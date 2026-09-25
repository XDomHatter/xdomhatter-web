/**
 * 对「真实运行中的服务」做一次联机冒烟测试：创建房间 -> 加入 -> 下到分出胜负。
 * 用法：先启动 node server/app.js，再 node scripts/smoke-live.js [port]
 */
const WebSocket = require('ws')

const PORT = process.argv[2] || 3199
const URL = 'ws://127.0.0.1:' + PORT + '/ws/gomoku3d'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function conn (tag) {
	const s = new WebSocket(URL)
	const seen = []
	s.on('message', (m) => {
		const msg = JSON.parse(String(m))
		seen.push(msg)
		console.log(tag + ' <- ' + msg.type + ' ' + JSON.stringify(msg).slice(0, 160))
	})
	return new Promise((resolve, reject) => {
		s.on('open', () => {
			console.log(tag + ' 已连接')
			resolve({ sock: s, seen: seen })
		})
		s.on('error', reject)
	})
}

const send = (c, o) => c.sock.send(JSON.stringify(o))

function last (c, type) {
	for (let i = c.seen.length - 1; i >= 0; i--) {
		if (c.seen[i].type === type) return c.seen[i]
	}
	return null
}

let failures = 0
function check (name, cond, extra) {
	if (cond) {
		console.log('  ok   ' + name)
	} else {
		failures++
		console.error('  FAIL ' + name + (extra ? ' :: ' + extra : ''))
	}
}

;(async function () {
	const a = await conn('A')
	const b = await conn('B')
	await wait(150)

	send(a, { type: 'create', name: '甲', n: 4, m: 3 })
	await wait(350)

	const created = last(a, 'created')
	check('创建房间返回房间号', !!created && /^\d{4}$/.test(String(created.room)), JSON.stringify(created))
	if (!created) process.exit(1)
	const room = String(created.room)

	send(b, { type: 'join', room: room, name: '乙' })
	await wait(350)

	const startA = last(a, 'state')
	const startB = last(b, 'state')
	check('对手加入后双方收到开局状态', !!startA && !!startB)
	check('开局时轮到玩家 1', startA && startA.turn === 1, startA && String(startA.turn))

	// 玩家1沿 x 轴连 3 子；玩家2在无关位置应对
	const seq = [
		[a, 0, 0, 0],
		[b, 0, 1, 1],
		[a, 1, 0, 0],
		[b, 0, 1, 2]
	]
	for (let i = 0; i < seq.length; i++) {
		const [who, x, y, z] = seq[i]
		send(who, { type: 'move', x: x, y: y, z: z })
		await wait(200)
	}

	// 玩家1落下第 3 子，应判胜
	send(a, { type: 'move', x: 2, y: 0, z: 0 })
	await wait(300)

	const fin = last(a, 'state')
	check('连成 3 子后对局结束', fin && fin.status === 'finished', fin && fin.status)
	check('获胜方为玩家 1', fin && fin.winner === 1, fin && String(fin.winner))
	check(
		'返回 3 个获胜格子且为 x 轴一线',
		fin && fin.winCells && fin.winCells.length === 3 &&
			fin.winCells[0][0] === 0 && fin.winCells[0][1] === 0 && fin.winCells[0][2] === 0 &&
			fin.winCells[2][0] === 2 && fin.winCells[2][1] === 0 && fin.winCells[2][2] === 0,
		fin && JSON.stringify(fin.winCells)
	)

	// 终局后禁止继续落子
	const before = last(a, 'state')
	send(b, { type: 'move', x: 3, y: 3, z: 3 })
	await wait(250)
	const after = last(a, 'state')
	check('终局后落子被拒（状态未变）', after && before && after.moveCount === before.moveCount)

	a.sock.close()
	b.sock.close()
	await wait(200)

	console.log('\n' + '='.repeat(46))
	if (failures) {
		console.error('  冒烟测试失败 ' + failures + ' 项')
		process.exit(1)
	}
	console.log('  联机冒烟测试全部通过')
	process.exit(0)
})().catch(function (err) {
	console.error('冒烟测试异常:', err)
	process.exit(1)
})
