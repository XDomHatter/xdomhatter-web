/**
 * 三维连珠 · 房间制实时对战服务。
 *
 * 设计要点：
 *   - 服务端权威：所有落子合法性、回合、胜负都在服务端裁决，客户端只发送意图。
 *   - 房间号：4 位数字，创建时随机分配，玩家把房间号给对方即可加入。
 *   - 断线重连：房间按 token 识别玩家；掉线保留座位与倒计时，超时判负。
 *   - 无持久化：进程重启房间即清空（纯对局场景，不需要落库）。
 *
 * 挂载方式见 server/app.js：createGameServer(server) 复用同一 HTTP 端口做 upgrade。
 */
const crypto = require('crypto')
const { WebSocketServer } = require('ws')
const Rules = require('../lib/gomoku3d-rules')

const PATH = '/ws/gomoku3d'

const ROOM_TTL_MS = 30 * 60 * 1000 // 空房间保留时长
const DISCONNECT_GRACE_MS = 60 * 1000 // 掉线宽限，超时判负
const TURN_TIMEOUT_MS = 120 * 1000 // 单步限时，超时判负
const HEARTBEAT_MS = 30 * 1000
const MAX_ROOMS = 500

/**
 * 两个超时时长的运行时开关。
 * 之所以不直接引用上面的常量，是为了让测试能把它们改短，
 * 从而在秒级时间内验证「超时判负」这条服务端单方面触发的路径。
 */
const TIMEOUTS = {
	turn: TURN_TIMEOUT_MS,
	grace: DISCONNECT_GRACE_MS
}

const DEFAULT_N = 4
const DEFAULT_M = 4

/** 房间集合：roomCode -> Room */
const rooms = new Map()

function now () {
	return Date.now()
}

function randomCode () {
	for (let attempt = 0; attempt < 2000; attempt++) {
		// 1000–9999，避免前导零带来的输入歧义
		const code = String(1000 + Math.floor(Math.random() * 9000))
		if (!rooms.has(code)) return code
	}
	return null
}

function makeToken () {
	return crypto.randomBytes(16).toString('hex')
}

/* ------------------------------------------------------------------ *
 * Room
 * ------------------------------------------------------------------ */

class Room {
	constructor (code, n, m) {
		this.code = code
		this.n = n
		this.m = m
		this.board = Rules.emptyBoard(n)
		this.seats = [null, null] // [ {token, name, socket, connected} | null ]
		this.turn = Rules.PLAYER_ONE
		this.status = 'waiting' // waiting | playing | finished
		this.winner = 0 // 0 未分胜负, 1/2 玩家, 3 平局
		this.winCells = []
		this.lastMove = null
		this.moveCount = 0
		this.createdAt = now()
		this.touchedAt = now()
		this.turnDeadline = 0
		this.turnTimer = null
	}

	touch () {
		this.touchedAt = now()
	}

	seatOf (token) {
		if (!token) return -1
		return this.seats.findIndex(function (s) {
			return s && s.token === token
		})
	}

	playerOf (seat) {
		return seat + 1 // seat 0 -> 玩家 1, seat 1 -> 玩家 2
	}

	isEmpty () {
		return this.seats.every(function (s) {
			return !s || !s.connected
		})
	}

	connectedCount () {
		return this.seats.filter(function (s) {
			return s && s.connected
		}).length
	}

	/** 双方都在座且都连接 -> 开局 */
	maybeStart () {
		if (this.status !== 'waiting') return false
		const both = this.seats[0] && this.seats[1]
		if (!both) return false
		if (!this.seats[0].connected || !this.seats[1].connected) return false
		this.status = 'playing'
		this.turn = Rules.PLAYER_ONE
		this.startTurnTimer()
		return true
	}

	clearTimers () {
		if (this.turnTimer) {
			clearTimeout(this.turnTimer)
			this.turnTimer = null
		}
		this.seats.forEach(function (s) {
			if (!s) return
			if (s.graceTimer) {
				clearTimeout(s.graceTimer)
				s.graceTimer = null
			}
			s.graceDeadline = 0
		})
		this.turnDeadline = 0
	}

	startTurnTimer () {
		if (this.turnTimer) clearTimeout(this.turnTimer)
		this.turnDeadline = now() + TIMEOUTS.turn
		const self = this
		this.turnTimer = setTimeout(function () {
			self.turnTimer = null
			self.turnDeadline = 0
			if (self.status !== 'playing') return
			// 当前执子方超时 -> 判负
			const loserSeat = self.turn - 1
			self.finish(self.turn === Rules.PLAYER_ONE ? Rules.PLAYER_TWO : Rules.PLAYER_ONE, 'timeout', [], loserSeat)
			// 超时是服务端单方面触发的，必须主动广播，
			// 否则对手端会一直停在「等待对方」，看不到终局。
			self.broadcast()
		}, TIMEOUTS.turn)
	}

	/**
	 * 掉线宽限：计时器挂在「座位」上而不是房间上。
	 * 房间级单例会在双方先后掉线时互相覆盖，也会被另一方的重连误清除，
	 * 导致掉线方永远得不到裁决。
	 */
	startGrace (seat) {
		const s = this.seats[seat]
		if (!s) return
		if (s.graceTimer) clearTimeout(s.graceTimer)
		s.graceDeadline = now() + TIMEOUTS.grace
		const self = this
		s.graceTimer = setTimeout(function () {
			s.graceTimer = null
			s.graceDeadline = 0
			if (s.connected) return
			if (self.status !== 'playing') return
			// 掉线方判负
			self.finish(self.playerOf(seat === 0 ? 1 : 0), 'disconnect', [], seat)
			// 同上：掉线判负也必须广播
			self.broadcast()
		}, TIMEOUTS.grace)
	}

	stopGrace (seat) {
		const s = this.seats[seat]
		if (!s) return
		if (s.graceTimer) {
			clearTimeout(s.graceTimer)
			s.graceTimer = null
		}
		s.graceDeadline = 0
	}

	/** 当前仍在宽限中的最大剩余毫秒数（双方都可能同时掉线） */
	graceRemainMs () {
		let max = 0
		this.seats.forEach(function (s) {
			if (!s || !s.graceDeadline) return
			const left = s.graceDeadline - now()
			if (left > max) max = left
		})
		return max
	}

	finish (winner, reason, winCells, loserSeat) {
		this.status = 'finished'
		this.winner = winner
		this.reason = reason || 'line'
		this.winCells = winCells || []
		this.loserSeat = typeof loserSeat === 'number' ? loserSeat : -1
		this.clearTimers()
	}

	reset () {
		this.board = Rules.emptyBoard(this.n)
		this.turn = Rules.PLAYER_ONE
		this.winner = 0
		this.winCells = []
		this.lastMove = null
		this.moveCount = 0
		this.reason = ''
		this.loserSeat = -1
		this.status = 'waiting'
		this.clearTimers()
		if (this.maybeStart()) this.broadcast()
	}

	/** 落子：返回 { ok, error? } */
	place (seat, x, y, z) {
		if (this.status !== 'playing') return { ok: false, error: '对局未在进行中' }
		const player = this.playerOf(seat)
		if (player !== this.turn) return { ok: false, error: '还没轮到你' }
		if (!Rules.isInt(x) || !Rules.isInt(y) || !Rules.isInt(z)) {
			return { ok: false, error: '坐标非法' }
		}
		if (!Rules.inBounds(this.n, x, y, z)) return { ok: false, error: '坐标越界' }

		const idx = Rules.indexOf(this.n, x, y, z)
		if (this.board[idx] !== Rules.EMPTY) return { ok: false, error: '这里已经有子了' }

		this.board[idx] = player
		this.moveCount++
		this.lastMove = { x: x, y: y, z: z, player: player }

		const win = Rules.findWinAt(this.board, this.n, this.m, x, y, z)
		if (win) {
			this.finish(player, 'line', win.cells, seat === 0 ? 1 : 0)
			return { ok: true, win: true }
		}
		if (Rules.isFull(this.board)) {
			this.finish(3, 'draw', [], -1)
			return { ok: true, draw: true }
		}

		this.turn = player === Rules.PLAYER_ONE ? Rules.PLAYER_TWO : Rules.PLAYER_ONE
		this.startTurnTimer()
		return { ok: true }
	}

	resign (seat) {
		if (this.status !== 'playing') return { ok: false, error: '对局未在进行中' }
		const winner = this.playerOf(seat === 0 ? 1 : 0)
		this.finish(winner, 'resign', [], seat)
		return { ok: true }
	}

	/** 下发给客户端的房间快照 */
	state () {
		return {
			type: 'state',
			room: this.code,
			n: this.n,
			m: this.m,
			status: this.status,
			turn: this.turn,
			winner: this.winner,
			reason: this.reason || '',
			loserSeat: this.loserSeat === undefined ? -1 : this.loserSeat,
			winCells: this.winCells,
			lastMove: this.lastMove,
			moveCount: this.moveCount,
			board: Array.from(this.board),
			turnRemainMs: this.turnDeadline ? Math.max(0, this.turnDeadline - now()) : 0,
			graceRemainMs: this.graceRemainMs(),
			seats: this.seats.map(function (s, i) {
				return s
					? { name: s.name, connected: s.connected, player: i + 1 }
					: null
			})
		}
	}

	broadcast (override) {		const payload = JSON.stringify(override || this.state())
		this.seats.forEach(function (s) {
			if (s && s.connected && s.socket && s.socket.readyState === 1) {
				s.socket.send(payload)
			}
		})
	}
}

/* ------------------------------------------------------------------ *
 * 房间池维护
 * ------------------------------------------------------------------ */

setInterval(function () {
	const cutoff = now() - ROOM_TTL_MS
	rooms.forEach(function (room, code) {
		if (room.isEmpty() && room.touchedAt < cutoff) {
			room.clearTimers()
			rooms.delete(code)
		}
	})
}, 60 * 1000).unref()

/* ------------------------------------------------------------------ *
 * WebSocket
 * ------------------------------------------------------------------ */

function send (socket, type, data) {
	if (socket.readyState !== 1) return
	const payload = Object.assign({ type: type }, data || {})
	socket.send(JSON.stringify(payload))
}

function err (socket, message) {
	send(socket, 'error', { message: message })
}

function createGameServer (httpServer) {
	const wss = new WebSocketServer({ noServer: true })

	httpServer.on('upgrade', function (req, socket, head) {
		let pathname = ''
		try {
			pathname = new URL(req.url, 'http://localhost').pathname
		} catch (e) {
			pathname = ''
		}
		if (pathname !== PATH) return // 交回给其它 upgrade 监听器
		wss.handleUpgrade(req, socket, head, function (ws) {
			wss.emit('connection', ws, req)
		})
	})

	wss.on('connection', function (ws) {
		ws.isAlive = true
		ws.on('pong', function () {
			ws.isAlive = true
		})

		// 本连接绑定的房间与座位
		ws.roomCode = null
		ws.seat = -1
		ws.token = null

		ws.on('message', function (raw) {
			let msg = null
			try {
				msg = JSON.parse(String(raw))
			} catch (e) {
				return err(ws, '消息格式错误')
			}
			if (!msg || typeof msg.type !== 'string') return err(ws, '消息格式错误')
			try {
				handle(ws, msg)
			} catch (e) {
				console.error('[gomoku3d]', e)
				err(ws, '服务端处理异常')
			}
		})

		ws.on('close', function () {
			const room = ws.roomCode ? rooms.get(ws.roomCode) : null
			if (!room) return
			const seat = room.seatOf(ws.token)
			if (seat < 0) return
			const s = room.seats[seat]
			if (s && s.socket === ws) {
				s.connected = false
				s.socket = null
				room.touch()
				if (room.status === 'playing') {
					room.startGrace(seat)
					room.broadcast()
				} else {
					room.broadcast()
				}
			}
		})
	})

	const heartbeat = setInterval(function () {
		wss.clients.forEach(function (ws) {
			if (ws.isAlive === false) return ws.terminate()
			ws.isAlive = false
			try {
				ws.ping()
			} catch (e) {
				/* ignore */
			}
		})
	}, HEARTBEAT_MS)
	heartbeat.unref()

	wss.on('close', function () {
		clearInterval(heartbeat)
	})

	return wss
}

function handle (ws, msg) {
	switch (msg.type) {
		case 'create':
			return onCreate(ws, msg)
		case 'join':
			return onJoin(ws, msg)
		case 'move':
			return onMove(ws, msg)
		case 'resign':
			return onResign(ws)
		case 'rematch':
			return onRematch(ws)
		case 'leave':
			return onLeave(ws)
		case 'ping':
			return send(ws, 'pong', { t: msg.t })
		default:
			return err(ws, '未知指令')
	}
}

function attach (ws, room, seat, token) {
	ws.roomCode = room.code
	ws.seat = seat
	ws.token = token
	const s = room.seats[seat]
	s.connected = true
	s.socket = ws
	room.touch()
}

function onCreate (ws, msg) {
	if (ws.roomCode) return err(ws, '你已在一个房间中')
	if (rooms.size >= MAX_ROOMS) return err(ws, '房间数已达上限，请稍后再试')

	const cfg = Rules.validateConfig(msg.n, msg.m)
	if (!cfg.ok) return err(ws, cfg.error)

	const code = randomCode()
	if (!code) return err(ws, '房间号分配失败，请重试')

	const room = new Room(code, msg.n, msg.m)
	const token = makeToken()
	room.seats[0] = {
		token: token,
		name: String(msg.name || '玩家 1').slice(0, 16),
		socket: ws,
		connected: true
	}
	rooms.set(code, room)
	attach(ws, room, 0, token)

	send(ws, 'created', {
		room: code,
		seat: 0,
		player: 1,
		token: token,
		n: room.n,
		m: room.m
	})
	room.broadcast()
}

function onJoin (ws, msg) {
	if (ws.roomCode) return err(ws, '你已在一个房间中')
	const code = String(msg.room || '').trim()
	if (!/^\d{4}$/.test(code)) return err(ws, '房间号应为 4 位数字')

	const room = rooms.get(code)
	if (!room) return err(ws, '房间不存在，请核对房间号')
	room.touch()

	// 断线重连：带 token 且能对上座位
	const existSeat = room.seatOf(msg.token)
	if (existSeat >= 0) {
		const s = room.seats[existSeat]
		const old = s.socket
		if (old && old !== ws && old.readyState === 1) {
			send(old, 'kicked', { message: '你的座位已在别处重新连接' })
			try {
				old.close()
			} catch (e) {
				/* ignore */
			}
		}
		attach(ws, room, existSeat, s.token)
		// 只清除「本座位」的宽限：对手若正在宽限中，不能被这次重连顺带取消
		room.stopGrace(existSeat)
		send(ws, 'joined', {
			room: room.code,
			seat: existSeat,
			player: room.playerOf(existSeat),
			token: s.token,
			n: room.n,
			m: room.m,
			reconnect: true
		})
		// maybeStart 内部已处理开局状态与回合计时，之后统一广播一次
		room.maybeStart()
		room.broadcast()
		return
	}

	const freeSeat = room.seats.findIndex(function (s) {
		return !s
	})
	if (freeSeat < 0) return err(ws, '房间已满')

	if (room.status === 'finished') {
		// 允许坐进已结束的房间观战，但不能落子
	}
	const token = makeToken()
	room.seats[freeSeat] = {
		token: token,
		name: String(msg.name || '玩家 ' + (freeSeat + 1)).slice(0, 16),
		socket: ws,
		connected: true
	}
	attach(ws, room, freeSeat, token)

	send(ws, 'joined', {
		room: room.code,
		seat: freeSeat,
		player: room.playerOf(freeSeat),
		token: token,
		n: room.n,
		m: room.m,
		reconnect: false
	})

	if (room.maybeStart()) {
		room.broadcast()
		return
	}
	room.broadcast()
}

function onMove (ws, msg) {
	const room = ws.roomCode ? rooms.get(ws.roomCode) : null
	if (!room) return err(ws, '你不在任何房间中')
	const seat = room.seatOf(ws.token)
	if (seat < 0) return err(ws, '座位失效，请重新加入')

	const res = room.place(seat, msg.x, msg.y, msg.z)
	if (!res.ok) return err(ws, res.error)
	room.broadcast()
}

function onResign (ws) {
	const room = ws.roomCode ? rooms.get(ws.roomCode) : null
	if (!room) return err(ws, '你不在任何房间中')
	const seat = room.seatOf(ws.token)
	if (seat < 0) return err(ws, '座位失效')

	const res = room.resign(seat)
	if (!res.ok) return err(ws, res.error)
	room.broadcast()
}

function onRematch (ws) {
	const room = ws.roomCode ? rooms.get(ws.roomCode) : null
	if (!room) return err(ws, '你不在任何房间中')
	if (room.status !== 'finished') return err(ws, '对局尚未结束')

	// 需要双方都在座才重开，避免一方单方面清盘
	const ready = room.seats.every(function (s) {
		return s && s.connected
	})
	if (!ready) return err(ws, '对手不在线，无法开始下一局')

	room.reset()
	room.broadcast()
}

function onLeave (ws) {
	const room = ws.roomCode ? rooms.get(ws.roomCode) : null
	if (!room) return
	const seat = room.seatOf(ws.token)
	if (seat >= 0) {
		const s = room.seats[seat]
		if (room.status === 'playing') {
			// 主动离开视为认输，避免对手干等
			const winner = room.playerOf(seat === 0 ? 1 : 0)
			room.finish(winner, 'leave', [], seat)
		}
		room.stopGrace(seat)
		room.seats[seat] = null
		if (s) {
			s.connected = false
			s.socket = null
		}
	}
	ws.roomCode = null
	ws.seat = -1
	ws.token = null
	room.touch()
	room.broadcast()
	send(ws, 'left', { room: room.code })
}

module.exports = {
	createGameServer: createGameServer,
	rooms: rooms,
	PATH: PATH,
	Room: Room,
	TIMEOUTS: TIMEOUTS
}
