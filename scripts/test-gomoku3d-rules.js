/**
 * lib/gomoku3d-rules.js 的单元测试：13 个方向的胜负判定、边界与配置校验。
 * 运行：node scripts/test-gomoku3d-rules.js
 *
 * 真实 API：
 *   findWinAt(board, n, m, x, y, z) -> null | {direction, cells}
 *   validateConfig(n, m)            -> {ok, error?}
 */
const assert = require('assert')
const Rules = require('../lib/gomoku3d-rules')

let passed = 0
let failed = 0

function test (name, fn) {
	try {
		fn()
		passed++
		console.log('  ok   ' + name)
	} catch (err) {
		failed++
		console.error('  FAIL ' + name)
		console.error('       ' + err.message)
	}
}

/** 在 n 阶棋盘上落子，moves 为 [x,y,z,player]，返回棋盘 */
function boardWith (n, moves) {
	const board = Rules.emptyBoard(n)
	moves.forEach(function (mv) {
		board[Rules.indexOf(n, mv[0], mv[1], mv[2])] = mv[3] || 1
	})
	return board
}

/** 沿 coords 铺同色子，返回该棋盘与最后一子坐标 */
function line (n, coords, player) {
	const moves = coords.map(function (c) {
		return [c[0], c[1], c[2], player || 1]
	})
	return boardWith(n, moves)
}

/* ---------------- 索引与坐标 ---------------- */

console.log('\n[索引 / 坐标]')

test('空棋盘全为 0，长度为 n³', function () {
	const b = Rules.emptyBoard(4)
	assert.strictEqual(b.length, 64)
	for (let i = 0; i < b.length; i++) assert.strictEqual(b[i], 0)
})

test('indexOf / coordOf 往返一致（n=7 全覆盖）', function () {
	const n = 7
	let count = 0
	for (let x = 0; x < n; x++) {
		for (let y = 0; y < n; y++) {
			for (let z = 0; z < n; z++) {
				const idx = Rules.indexOf(n, x, y, z)
				assert.deepStrictEqual(Rules.coordOf(n, idx), [x, y, z])
				count++
			}
		}
	}
	assert.strictEqual(count, n * n * n)
})

test('indexOf 与 coordOf 对 n=3..12 首尾一致', function () {
	for (let n = 3; n <= 12; n++) {
		assert.strictEqual(Rules.indexOf(n, 0, 0, 0), 0)
		assert.strictEqual(Rules.indexOf(n, n - 1, n - 1, n - 1), n * n * n - 1)
		assert.deepStrictEqual(Rules.coordOf(n, n * n * n - 1), [n - 1, n - 1, n - 1])
	}
})

test('inBounds 正确拒绝越界坐标', function () {
	const n = 4
	assert.ok(Rules.inBounds(n, 0, 0, 0))
	assert.ok(Rules.inBounds(n, 3, 3, 3))
	assert.ok(!Rules.inBounds(n, -1, 0, 0))
	assert.ok(!Rules.inBounds(n, 0, 4, 0))
	assert.ok(!Rules.inBounds(n, 0, 0, 9))
})

/* ---------------- 坐标输入 ---------------- */

console.log('\n[坐标输入]')

test('parseCoord 接受范围内的十进制坐标', function () {
	assert.strictEqual(Rules.parseCoord('0', 4), 0)
	assert.strictEqual(Rules.parseCoord('3', 4), 3)
	assert.strictEqual(Rules.parseCoord(2, 4), 2, '数字也应可用')
	assert.strictEqual(Rules.parseCoord(' 2 ', 4), 2, '应容忍前后空白')
	assert.strictEqual(Rules.parseCoord('11', 12), 11, 'N=12 时两位数是合法的')
})

test('parseCoord 拒绝越界坐标', function () {
	assert.strictEqual(Rules.parseCoord('4', 4), null)
	assert.strictEqual(Rules.parseCoord('9', 4), null)
	assert.strictEqual(Rules.parseCoord('12', 12), null)
	assert.strictEqual(Rules.parseCoord('-1', 4), null)
})

test('parseCoord 拒绝 Number() 会放过的伪坐标', function () {
	// 这些是「用 Number() 直接转换」时最容易漏掉的一类输入
	assert.strictEqual(Rules.parseCoord('1e3', 8), null)
	assert.strictEqual(Rules.parseCoord('0x2', 8), null)
	assert.strictEqual(Rules.parseCoord('1.5', 8), null)
	assert.strictEqual(Rules.parseCoord('+2', 8), null)
	assert.strictEqual(Rules.parseCoord('1,2', 8), null)
	assert.strictEqual(Rules.parseCoord('0b1', 8), null)
})

test('parseCoord 拒绝空值与非法棋盘边长', function () {
	assert.strictEqual(Rules.parseCoord('', 4), null)
	assert.strictEqual(Rules.parseCoord('   ', 4), null)
	assert.strictEqual(Rules.parseCoord(null, 4), null)
	assert.strictEqual(Rules.parseCoord(undefined, 4), null)
	assert.strictEqual(Rules.parseCoord(NaN, 4), null)
	assert.strictEqual(Rules.parseCoord('0', 0), null)
	assert.strictEqual(Rules.parseCoord('0', 4.5), null)
	assert.strictEqual(Rules.parseCoord('0', '4'), null)
})

test('formatCoord 与 parseCoord 往返一致', function () {
	const n = 8
	for (let x = 0; x < n; x++) {
		const text = Rules.formatCoord(x, 1, 2)
		assert.strictEqual(text, x + ',1,2')
		assert.strictEqual(Rules.parseCoord(text.split(',')[0], n), x)
	}
})

/* ---------------- 坐标轴定义 ---------------- */

console.log('\n[坐标轴定义]')

test('AXES 提供模板渲染所需的全部字段', function () {
	// gomoku3d.pug 直接读 axis.key / axis.label / axis.color / axis.screen，
	// 客户端读 axis.vector，缺任何一项都会在渲染或绘制箭头时报错。
	assert.strictEqual(Rules.AXES.length, 3)
	Rules.AXES.forEach(function (axis) {
		assert.strictEqual(typeof axis.key, 'string')
		assert.ok(axis.key.length > 0)
		assert.ok(/^\+\w$/.test(axis.label), 'label 形如 +x，实际 ' + axis.label)
		assert.ok(/^#[0-9a-f]{6}$/i.test(axis.color), 'color 应为 #rrggbb，实际 ' + axis.color)
		assert.ok(axis.screen && axis.screen.length > 0, 'screen 文案不能为空')
		assert.strictEqual(axis.vector.length, 3)
	})
})

/* ---------------- 13 个方向 ---------------- */

console.log('\n[13 个方向]')

test('DIRECTIONS 恰好 13 条且互不共线', function () {
	assert.strictEqual(Rules.DIRECTIONS.length, 13)
	const seen = {}
	Rules.DIRECTIONS.forEach(function (d) {
		let g = d.slice()
		const first = g.find(function (v) {
			return v !== 0
		})
		if (first < 0) g = g.map(function (v) {
			return -v
		})
		const key = g.join(',')
		assert.ok(!seen[key], '方向重复: ' + key)
		seen[key] = true
	})
	assert.strictEqual(Object.keys(seen).length, 13)
})

test('轴向 x 连成 M 子', function () {
	const n = 5, m = 4
	const b = line(n, [[0, 2, 2], [1, 2, 2], [2, 2, 2], [3, 2, 2]])
	assert.ok(Rules.findWinAt(b, n, m, 3, 2, 2))
	assert.ok(!Rules.findWinAt(b, n, m + 1, 3, 2, 2), 'M=5 时不该成立')
})

test('轴向 y 连成 M 子', function () {
	const n = 5, m = 4
	const b = line(n, [[1, 0, 1], [1, 1, 1], [1, 2, 1], [1, 3, 1]])
	assert.ok(Rules.findWinAt(b, n, m, 1, 3, 1))
})

test('轴向 z 连成 M 子', function () {
	const n = 5, m = 4
	const b = line(n, [[0, 0, 0], [0, 0, 1], [0, 0, 2], [0, 0, 3]])
	assert.ok(Rules.findWinAt(b, n, m, 0, 0, 3))
})

test('面对角线 xy（正）连成 M 子', function () {
	const n = 5, m = 4
	const b = line(n, [[0, 0, 0], [1, 1, 0], [2, 2, 0], [3, 3, 0]])
	assert.ok(Rules.findWinAt(b, n, m, 3, 3, 0))
})

test('面对角线 xy（负）连成 M 子', function () {
	const n = 5, m = 4
	const b = line(n, [[3, 0, 0], [2, 1, 0], [1, 2, 0], [0, 3, 0]])
	assert.ok(Rules.findWinAt(b, n, m, 0, 3, 0))
})

test('面对角线 xz（正）连成 M 子', function () {
	const n = 5, m = 4
	const b = line(n, [[0, 0, 0], [1, 0, 1], [2, 0, 2], [3, 0, 3]])
	assert.ok(Rules.findWinAt(b, n, m, 3, 0, 3))
})

test('面对角线 xz（负）连成 M 子', function () {
	const n = 5, m = 4
	const b = line(n, [[3, 0, 0], [2, 0, 1], [1, 0, 2], [0, 0, 3]])
	assert.ok(Rules.findWinAt(b, n, m, 0, 0, 3))
})

test('面对角线 yz（正）连成 M 子', function () {
	const n = 5, m = 4
	const b = line(n, [[0, 0, 0], [0, 1, 1], [0, 2, 2], [0, 3, 3]])
	assert.ok(Rules.findWinAt(b, n, m, 0, 3, 3))
})

test('面对角线 yz（负）连成 M 子', function () {
	const n = 5, m = 4
	const b = line(n, [[0, 3, 0], [0, 2, 1], [0, 1, 2], [0, 0, 3]])
	assert.ok(Rules.findWinAt(b, n, m, 0, 0, 3))
})

test('四条体对角线全部可判定', function () {
	const n = 5, m = 4
	const cases = [
		[[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]],
		[[4, 0, 0], [3, 1, 1], [2, 2, 2], [1, 3, 3]],
		[[0, 4, 0], [1, 3, 1], [2, 2, 2], [3, 1, 3]],
		[[0, 0, 4], [1, 1, 3], [2, 2, 2], [3, 3, 1]]
	]
	cases.forEach(function (coords) {
		const b = line(n, coords)
		const last = coords[coords.length - 1]
		assert.ok(
			Rules.findWinAt(b, n, m, last[0], last[1], last[2]),
			'体对角线漏判: ' + JSON.stringify(coords)
		)
	})
})

test('返回的 cells 是恰好 M 个的点集且包含落点', function () {
	const n = 5, m = 4
	const b = line(n, [[0, 2, 2], [1, 2, 2], [2, 2, 2], [3, 2, 2]])
	const res = Rules.findWinAt(b, n, m, 3, 2, 2)
	assert.ok(res && res.cells)
	assert.strictEqual(res.cells.length, m)
	assert.deepStrictEqual(res.direction, [1, 0, 0])
	const has = res.cells.some(function (c) {
		return c[0] === 3 && c[1] === 2 && c[2] === 2
	})
	assert.ok(has, 'cells 应包含刚落下的点')
})

test('只沿落点所在直线判定：远处已有连线不影响', function () {
	const n = 5, m = 4
	// 玩家1在 y=0 层连成 4 子，但落点在别处
	const b = line(n, [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]])
	b[Rules.indexOf(n, 4, 4, 4)] = 1
	assert.ok(!Rules.findWinAt(b, n, m, 4, 4, 4), '落点处无连线应返回 null')
})

/* ---------------- 负例 ---------------- */

console.log('\n[负例]')

test('只连成 M-1 子不算胜', function () {
	const n = 5, m = 4
	const b = line(n, [[0, 0, 0], [1, 0, 0], [2, 0, 0]])
	assert.ok(!Rules.findWinAt(b, n, m, 2, 0, 0))
})

test('被对手挡断不算连成', function () {
	const n = 5, m = 4
	const b = boardWith(n, [
		[0, 0, 0, 1], [1, 0, 0, 1], [2, 0, 0, 2], [3, 0, 0, 1]
	])
	assert.ok(!Rules.findWinAt(b, n, m, 3, 0, 0))
})

test('中间断一格不算连成', function () {
	const n = 5, m = 4
	const b = boardWith(n, [
		[0, 0, 0, 1], [1, 0, 0, 1], [3, 0, 0, 1], [4, 0, 0, 1]
	])
	assert.ok(!Rules.findWinAt(b, n, m, 4, 0, 0))
})

test('空格子调用返回 null', function () {
	const n = 4
	const b = Rules.emptyBoard(n)
	assert.strictEqual(Rules.findWinAt(b, n, 3, 0, 0, 0), null)
})

test('n=4 的体对角线正好 4 连应判胜（打满整条对角线）', function () {
	const n = 4, m = 4
	const b = line(n, [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]])
	assert.ok(Rules.findWinAt(b, n, m, 3, 3, 3))
})

test('恰好到达棋盘边界的连线不会被越界误判', function () {
	const n = 4, m = 3
	// 贴着 x=n-1 的边界，沿 y 方向 3 连
	const b = line(n, [[3, 1, 1], [3, 2, 1], [3, 3, 1]])
	assert.ok(Rules.findWinAt(b, n, m, 3, 3, 1))
})

/* ---------------- 配置校验 ---------------- */

console.log('\n[配置校验]')

test('validateConfig 接受合法范围', function () {
	assert.ok(Rules.validateConfig(3, 3).ok)
	assert.ok(Rules.validateConfig(12, 12).ok)
	assert.ok(Rules.validateConfig(8, 5).ok)
	assert.ok(Rules.validateConfig(4, 3).ok)
})

test('validateConfig 拒绝 N 越界', function () {
	assert.ok(!Rules.validateConfig(2, 3).ok)
	assert.ok(!Rules.validateConfig(13, 3).ok)
})

test('validateConfig 拒绝 M > N', function () {
	assert.ok(!Rules.validateConfig(4, 5).ok)
})

test('validateConfig 拒绝 M < 3', function () {
	assert.ok(!Rules.validateConfig(4, 2).ok)
})

test('validateConfig 拒绝非整数', function () {
	assert.ok(!Rules.validateConfig(4.5, 4).ok)
	assert.ok(!Rules.validateConfig('4', 4).ok)
})

test('validateConfig 返回可读的错误信息', function () {
	const r = Rules.validateConfig(4, 9)
	assert.strictEqual(typeof r.error, 'string')
	assert.ok(r.error.length > 0)
})

/* ---------------- 棋盘状态 ---------------- */

console.log('\n[棋盘状态]')

test('moveCount 统计已落子数', function () {
	const n = 4
	const b = Rules.emptyBoard(n)
	assert.strictEqual(Rules.moveCount(b), 0)
	b[0] = 1
	b[Rules.indexOf(n, 3, 3, 3)] = 2
	assert.strictEqual(Rules.moveCount(b), 2)
})

test('isFull 在下满时返回真', function () {
	const n = 3
	const b = Rules.emptyBoard(n)
	assert.ok(!Rules.isFull(b))
	b.fill(1)
	assert.ok(Rules.isFull(b))
})

test('isInt 判定正确', function () {
	assert.ok(Rules.isInt(4))
	assert.ok(Rules.isInt(0))
	assert.ok(!Rules.isInt(4.2))
	assert.ok(!Rules.isInt('4'))
	assert.ok(!Rules.isInt(NaN))
	assert.ok(!Rules.isInt(null))
})

test('PLAYER 常量符合约定', function () {
	assert.strictEqual(Rules.EMPTY, 0)
	assert.strictEqual(Rules.PLAYER_ONE, 1)
	assert.strictEqual(Rules.PLAYER_TWO, 2)
})

/* ---------------- 汇总 ---------------- */

console.log('\n' + '='.repeat(46))
console.log('  通过 ' + passed + ' / ' + (passed + failed))
if (failed > 0) {
	console.error('  失败 ' + failed)
	process.exit(1)
}
console.log('  规则测试全部通过')
