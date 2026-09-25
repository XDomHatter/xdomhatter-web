/**
 * server/gomoku3d.js 的端到端测试：真实起 HTTP + WebSocket，两个客户端对打。
 * 运行：node scripts/test-gomoku3d.js
 */
const http = require('http')
const WebSocket = require('ws')
const assert = require('assert')
const game = require('../server/gomoku3d')

const PATH = game.PATH

function delay (ms) {
	return new Promise(function (r) {
		setTimeout(r, ms)
	})
}

/** 把 ws 包装成「发指令 + 等某个类型消息」的易用对象 */
function client (port) {
	const ws = new WebSocket('ws://127.0.0.1:' + port + PATH)
	const queue = []
	const waiters = []

	ws.on('message', function (raw) {
		const msg = JSON.parse(String(raw))
		// 先满足正在等待的 waiter（FIFO，避免旧 waiter 抢占新消息）
		for (let i = 0; i < waiters.length; i++) {
			if (waiters[i].type === msg.type) {
				const w = waiters.splice(i, 1)[0]
				clearTimeout(w.timer)
				w.resolve(msg)
				return
			}
		}
		queue.push(msg)
	})

	return {
		ws: ws,
		open: function () {
			return new Promise(function (resolve, reject) {
				ws.on('open', resolve)
				ws.on('error', reject)
			})
		},
		send: function (obj) {
			ws.send(JSON.stringify(obj))
		},
		/** 清空历史队列，用于隔离各测试段 */
		drain: function () {
			queue.length = 0
		},
		wait: function (type, timeoutMs) {
			// 优先消费已到达的历史消息
			for (let i = 0; i < queue.length; i++) {
				if (queue[i].type === type) return Promise.resolve(queue.splice(i, 1)[0])
			}
			return new Promise(function (resolve, reject) {
				const w = {
					type: type,
					resolve: resolve,
					timer: setTimeout(function () {
						const idx = waiters.indexOf(w)
						if (idx >= 0) waiters.splice(idx, 1) // 超时必须摘除，否则会污染后续等待
						reject(new Error('等待 ' + type + ' 超时'))
					}, timeoutMs || 4000)
				}
				waiters.push(w)
			})
		},
		close: function () {
			try {
				ws.close()
			} catch (e) {
				/* ignore */
			}
		}
	}
}

async function main () {
	const server = http.createServer(function (req, res) {
		res.writeHead(404)
		res.end()
	})
	game.createGameServer(server)
	await new Promise(function (r) {
		server.listen(0, r)
	})
	const port = server.address().port

	let pass = 0
	let fail = 0
	function ok (name, cond) {
		if (cond) {
			pass++
			console.log('PASS  ' + name)
		} else {
			fail++
			console.log('FAIL  ' + name)
		}
	}

	/* ---------- 1. 创建房间 ---------- */
	const a = client(port)
	await a.open()
	a.send({ type: 'create', n: 4, m: 4, name: '甲' })
	const created = await a.wait('created')
	ok('创建房间返回 4 位房间号', /^\d{4}$/.test(created.room))
	ok('创建者坐 0 号位且为玩家 1', created.seat === 0 && created.player === 1)
	ok('创建时棋盘为空', (await a.wait('state')).board.every(function (v) {
		return v === 0
	}))

	/* ---------- 2. 加入房间 ---------- */
	const b = client(port)
	await b.open()
	b.send({ type: 'join', room: created.room, name: '乙' })
	const joined = await b.wait('joined')
	ok('加入者坐 1 号位且为玩家 2', joined.seat === 1 && joined.player === 2)
	const st = await b.wait('state')
	ok('双方到齐后开局', st.status === 'playing' && st.turn === 1)
	ok('等待方收到开局广播', (await a.wait('state')).status === 'playing')

	/* ---------- 3. 非法落子被拒 ---------- */
	a.drain()
	b.drain()
	b.send({ type: 'move', x: 0, y: 0, z: 0 })
	const notYourTurn = await b.wait('error')
	ok('没轮到你就落子被拒', notYourTurn.message.indexOf('轮') >= 0)

	a.send({ type: 'move', x: 9, y: 0, z: 0 })
	ok('越界落子被拒', (await a.wait('error')).message.indexOf('越界') >= 0)

	a.send({ type: 'move', x: 0, y: 0, z: 0 })
	ok('甲首手落子成功', (await a.wait('state')).moveCount === 1)
	// 此刻轮乙，乙去占甲的格子
	b.send({ type: 'move', x: 0, y: 0, z: 0 })
	const dupErr = await b.wait('error').catch(function (e) {
		return { message: '（未收到 error：' + e.message + '）' }
	})
	ok('重复占位被拒', dupErr.message.indexOf('已经有子') >= 0)

	/* ---------- 4. 回合交替 ---------- */
	const afterB = await b.wait('state') // 甲落子后乙收到广播
	ok('落子后轮到对手（turn=2）', afterB.turn === 2)
	ok('落子计数正确', afterB.moveCount === 1)

	/* ---------- 5. 实际对局：玩家 1 沿 x 轴连成 4 子获胜 ---------- */
	// 当前棋盘：甲 (0,0,0)，轮到乙。
	// 计划：乙先落一子，之后每轮「甲走一步 -> 乙走一步」，
	// 甲沿 x 轴走 (1,0,0) (2,0,0) (3,0,0)，第 4 子落定时判甲胜。
	b.send({ type: 'move', x: 0, y: 1, z: 1 })
	await b.wait('state')
	ok('乙落子后轮到甲（turn=1）', (await a.wait('state')).turn === 1)

	const aMoves = [[1, 0, 0], [2, 0, 0], [3, 0, 0]]
	const bMoves = [[1, 1, 1], [2, 1, 1]]

	for (let i = 0; i < aMoves.length; i++) {
		const m = aMoves[i]
		a.send({ type: 'move', x: m[0], y: m[1], z: m[2] })
		const s = await a.wait('state') // 甲收到自己落子后的局面

		if (i < bMoves.length) {
			ok('第 ' + (i + 3) + ' 手后轮到乙', s.turn === 2)
			const bm = bMoves[i]
			b.send({ type: 'move', x: bm[0], y: bm[1], z: bm[2] })
			await b.wait('state') // 乙确认落子
			// 乙落子后甲也会收到广播，取出以保持队列干净
			const backTurn = await a.wait('state')
			ok('乙落子后交还回合给甲', backTurn.turn === 1)
		} else {
			ok('获胜判定 status=finished', s.status === 'finished')
			ok('获胜方为玩家 1', s.winner === 1)
			ok('返回 4 个获胜格子', s.winCells.length === 4)
			ok('获胜方向为 x 轴', s.reason === 'line')
		}
	}

	/* ---------- 6. 终局后不可再落子 ---------- */
	b.send({ type: 'move', x: 3, y: 3, z: 3 })
	ok('终局后落子被拒', (await b.wait('error')).message.length > 0)

	/* ---------- 7. 重开 ---------- */
	a.drain()
	b.drain()
	a.send({ type: 'rematch' })
	const re = await a.wait('state')
	ok('双方在线时重开成功', re.status === 'playing' && re.moveCount === 0)
	ok('重开后轮到玩家 1', re.turn === 1)
	ok('重开后棋盘清空', re.board.every(function (v) {
		return v === 0
	}))

	/* ---------- 8. 认输 ---------- */
	a.drain()
	b.drain()
	a.send({ type: 'resign' })
	const rs = await a.wait('state')
	ok('认输后对手获胜', rs.status === 'finished' && rs.winner === 2 && rs.reason === 'resign')

	/* ---------- 9. 断线重连（带 token 回座） ---------- */
	a.drain()
	b.drain()
	a.send({ type: 'rematch' })
	await a.wait('state')
	b.drain() // 丢掉重开的广播，只关心掉线后的那条
	const tokenA = created.token
	a.close()

	// 等 b 收到「甲已离线」的那条 state（seats[0].connected === false）
	let stAfterDrop = null
	const deadline = Date.now() + 5000
	while (Date.now() < deadline) {
		const s = await b.wait('state', 5000)
		if (s.seats[0] && s.seats[0].connected === false) {
			stAfterDrop = s
			break
		}
	}
	ok('掉线后标记 disconnected', !!stAfterDrop)
	ok('掉线后给出宽限倒计时', !!stAfterDrop && stAfterDrop.graceRemainMs > 0)

	const a2 = client(port)
	await a2.open()
	a2.send({ type: 'join', room: created.room, token: tokenA, name: '甲' })
	const rejoin = await a2.wait('joined')
	ok('带 token 重连回到原座位', rejoin.seat === 0 && rejoin.reconnect === true)
	const stBack = await a2.wait('state')
	ok('重连后恢复在线', stBack.seats[0].connected === true)
	ok('重连后棋盘状态保留', stBack.moveCount === 0)

	/* ---------- 10. 错误房间号 ---------- */
	const c = client(port)
	await c.open()
	c.send({ type: 'join', room: '12ab' })
	ok('房间号格式不合法被拒', (await c.wait('error')).message.indexOf('4 位') >= 0)
	c.send({ type: 'join', room: '9999' })
	ok('房间不存在被拒', (await c.wait('error')).message.indexOf('不存在') >= 0)
	c.close()

	/* ---------- 11. 非法配置 ---------- */
	const d = client(port)
	await d.open()
	d.send({ type: 'create', n: 5, m: 9 })
	ok('M 大于 N 被拒', (await d.wait('error')).message.indexOf('M') >= 0)
	d.close()

	a2.close()
	b.close()
	await delay(100)
	server.close()
	game.rooms.clear()

	console.log('\n==> ' + pass + ' passed, ' + fail + ' failed')
	process.exit(fail ? 1 : 0)
}

main().catch(function (e) {
	console.error('测试异常:', e)
	process.exit(1)
})
