/**
 * 三维连珠核心规则（服务端 / 浏览器端共用）。
 *
 * 棋盘：N³ 立方格，每个格子由 (x, y, z) 唯一描述，取值 0..N-1。
 * 落子：双方轮流占用空格。
 * 胜负：某一方占用的格子中出现连续 M 个，且方向属于以下 13 类之一。
 *
 * 13 个方向 = 三维格点中所有「本质不同」的直线方向。做法是把方向向量的每个分量
 * 限制在 {-1, 0, 1}，并只取字典序大于 0 的一半（正负方向是同一条直线，只需查一次）：
 *   3 条轴向      (1,0,0) (0,1,0) (0,0,1)
 *   6 条面对角线  (1,1,0) (1,-1,0) (1,0,1) (1,0,-1) (0,1,1) (0,1,-1)
 *   4 条体对角线  (1,1,1) (1,1,-1) (1,-1,1) (1,-1,-1)
 *
 * 这样枚举在数学上是完备的：任何格点直线方向都能约化为这 13 条之一的正负号。
 */
(function (root, factory) {
	var api = factory()
	if (typeof module === 'object' && module.exports) module.exports = api
	else root.Gomoku3DRules = api
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict'

	/** 全部 13 个判定方向（各方向的正负号视为同一条直线） */
	var DIRECTIONS = [
		// 轴向
		[1, 0, 0],
		[0, 1, 0],
		[0, 0, 1],
		// 面对角线
		[1, 1, 0],
		[1, -1, 0],
		[1, 0, 1],
		[1, 0, -1],
		[0, 1, 1],
		[0, 1, -1],
		// 体对角线
		[1, 1, 1],
		[1, 1, -1],
		[1, -1, 1],
		[1, -1, -1]
	]

	var EMPTY = 0
	var PLAYER_ONE = 1
	var PLAYER_TWO = 2

	/**
	 * 三个坐标轴的正方向定义。
	 *
	 * 棋盘上的箭头、页面里的图例、规则说明都从这里取，避免三处各写一份而漂移。
	 * screen 描述该轴正方向在默认相机下的屏幕朝向，由
	 * scripts/test-render-math.js 的「轴方向」用例对着相机矩阵校验：
	 * 一旦有人改了相机姿态而没同步文案，测试会立刻失败。
	 */
	var AXES = [
		{ key: 'x', vector: [1, 0, 0], label: '+x', color: '#ffd166', screen: '右下' },
		{ key: 'y', vector: [0, 1, 0], label: '+y', color: '#7ee787', screen: '正上' },
		{ key: 'z', vector: [0, 0, 1], label: '+z', color: '#b39ddb', screen: '左下' }
	]

	function isInt (value) {
		return typeof value === 'number' && isFinite(value) && Math.floor(value) === value
	}

	/** 坐标是否落在 N³ 棋盘内 */
	function inBounds (n, x, y, z) {
		return x >= 0 && x < n && y >= 0 && y < n && z >= 0 && z < n
	}

	/** 线性索引：把 (x,y,z) 映射到一维数组下标，棋盘用 Int8Array 存储 */
	function indexOf (n, x, y, z) {
		return (x * n + y) * n + z
	}

	function coordOf (n, index) {
		var z = index % n
		var y = Math.floor(index / n) % n
		var x = Math.floor(index / (n * n))
		return [x, y, z]
	}

	/** 由 N、M 算出对局合法性：M 必须能放进棋盘 */
	function validateConfig (n, m) {
		if (!isInt(n) || n < 3 || n > 12) {
			return { ok: false, error: '边长 N 需为 3–12 的整数' }
		}
		if (!isInt(m) || m < 3 || m > n) {
			return { ok: false, error: '连子数 M 需为 3–' + n + ' 的整数' }
		}
		return { ok: true }
	}

	/**
	 * 检查在 (x,y,z) 落子后是否形成 M 连。
	 * 只沿经过该点的直线检查，避免全盘扫描。
	 * @returns {null | {direction:number[], cells:number[][]}}
	 *          未获胜返回 null，否则返回获胜方向与连成一线的格子列表（从一端到另一端）。
	 */
	function findWinAt (board, n, m, x, y, z) {
		var player = board[indexOf(n, x, y, z)]
		if (player !== PLAYER_ONE && player !== PLAYER_TWO) return null

		for (var d = 0; d < DIRECTIONS.length; d++) {
			var dir = DIRECTIONS[d]
			// 收集经过 (x,y,z) 的这一整条线：先向负方向回溯到尽头，再正向收集
			var line = []

			var sx = x
			var sy = y
			var sz = z
			while (inBounds(n, sx - dir[0], sy - dir[1], sz - dir[2])) {
				sx -= dir[0]
				sy -= dir[1]
				sz -= dir[2]
			}

			while (inBounds(n, sx, sy, sz)) {
				line.push([sx, sy, sz])
				sx += dir[0]
				sy += dir[1]
				sz += dir[2]
			}

			// 在这条线上找是否存在长度 >= M 的连续同色段，且包含刚落下的这颗子
			var run = 0
			var runStart = 0
			for (var i = 0; i < line.length; i++) {
				var cell = line[i]
				if (board[indexOf(n, cell[0], cell[1], cell[2])] === player) {
					if (run === 0) runStart = i
					run++
					if (run >= m) {
						// 命中：直接返回这条连线（长度恰好 M，便于前端高亮）
						var cells = []
						for (var k = runStart; k < runStart + run; k++) cells.push(line[k])
						return { direction: dir.slice(), cells: cells }
					}
				} else {
					run = 0
				}
			}
		}

		return null
	}

	/** 棋盘是否已下满 */
	function isFull (board) {
		for (var i = 0; i < board.length; i++) {
			if (board[i] === EMPTY) return false
		}
		return true
	}

	/**
	 * 把玩家输入的坐标文本解析成 0..n-1 的整数。
	 *
	 * 只接受纯十进制数字（允许前后空白），其余一律返回 null。
	 * 不用 Number() 直接转换，是为了拒绝 "1e3"、"0x2"、"1.5"、"+2"、"" 这类
	 * 会被 Number 接受、但不符合「格子坐标」直觉的输入。
	 */
	function parseCoord (raw, n) {
		if (!isInt(n) || n < 1) return null
		var s = String(raw == null ? '' : raw).trim()
		if (!/^\d{1,2}$/.test(s)) return null
		var v = parseInt(s, 10)
		if (v < 0 || v >= n) return null
		return v
	}

/** 把坐标拼成便于显示与作为键的文本，如 "1,0,2" */
function formatCoord (x, y, z) {
	return x + ',' + y + ',' + z
}

/**
 * 把一个坐标值夹回 0..n-1。
 *
 * 落子输入区用的是 spinner（上下键增减）而不是自由文本，
 * 因此「越界」不该报错，而应当直接回到可取范围：
 *   - 减到 0 以下   -> 0
 *   - 加到 n-1 以上 -> n-1
 * 非数字（NaN、Infinity）一律退化为 0，避免把 NaN 带进棋盘索引。
 */
function clampCoord (value, n) {
	if (!isInt(n) || n < 1) return 0
	var v = Number(value)
	if (!isFinite(v)) return 0
	v = Math.floor(v)
	if (v < 0) return 0
	if (v > n - 1) return n - 1
	return v
}

/**
 * spinner 的一步：在当前值上按 delta 增减，并在 0..n-1 之间环绕（wrap）。
 *
 * 之所以选环绕而不是夹取：棋盘边长常常只有 4，夹取会让按钮在边界处「失灵」，
 * 玩家要反向绕大半圈才能到对侧；环绕则两个方向都始终有效。
 *   0 再按「下」   -> n-1
 *   n-1 再按「上」 -> 0
 *
 * @param {number} wrap 为 false 时退化为夹取（保留给将来需要非环绕手感的地方）
 */
function stepCoord (value, delta, n, wrap) {
	if (!isInt(n) || n < 1) return 0
	// 非整数的当前值先规范化，否则 -Infinity 之类会污染取模结果
	var cur = clampCoord(value, n)
	var d = isInt(delta) ? delta : 0
	var span = n
	var next = ((cur + d) % span + span) % span
	if (wrap === false) return clampCoord(cur + d, n)
	return next
}

	function emptyBoard (n) {
		return new Int8Array(n * n * n)
	}

	/** 已落子数量 */
	function moveCount (board) {
		var total = 0
		for (var i = 0; i < board.length; i++) {
			if (board[i] !== EMPTY) total++
		}
		return total
	}

	return {
		DIRECTIONS: DIRECTIONS,
		AXES: AXES,
		EMPTY: EMPTY,
		PLAYER_ONE: PLAYER_ONE,
		PLAYER_TWO: PLAYER_TWO,
		isInt: isInt,
		inBounds: inBounds,
		indexOf: indexOf,
		coordOf: coordOf,
		validateConfig: validateConfig,
		findWinAt: findWinAt,
		isFull: isFull,
		parseCoord: parseCoord,
		formatCoord: formatCoord,
		clampCoord: clampCoord,
		stepCoord: stepCoord,
		emptyBoard: emptyBoard,
		moveCount: moveCount
	}
})
