/**
 * 坐标落子交互的回归测试（无需浏览器 / 无需 WebGL）。
 *
 * 做法：把构建产物 dist/js/game3d.js 放进一个最小 DOM 桩里真实执行，
 * 再直接调用 App 的公开方法驱动交互。之所以跑 dist 而不是 src，
 * 是因为要验证「实际发出去的页面脚本」而不是源码。
 *
 * 重点覆盖三件在浏览器里最容易踩、单测又最容易漏的事：
 *   1. 脚本加载顺序：layout.pug 把规则模块的 <script> 排在 game3d.js 之后，
 *      所以顶层绝不能读 window.Gomoku3DRules（这里刻意先加载 game3d.js、
 *      之后再挂规则模块，复现真实顺序）；
 *   2. 客户端要求的 DOM id 是否都在构建产物里（把 src 里的 $('#id') 全部
 *      抽出来逐个核对，比手写一份清单更不容易漏）；
 *   3. 坐标校验、回合门禁、提交与回填的行为。
 *
 * 说明：本用例不引入 three.js，因此不验证 3D 绘制；
 * 与「坐标 → 棋子」相关的部分只验证 App 与 Board3D 之间的调用契约。
 *
 * 运行：node scripts/test-move-input.js
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const assert = require('assert')

const ROOT = path.resolve(__dirname, '..')
const BUNDLE = path.join(ROOT, 'dist', 'js', 'game3d.js')
const PAGE = path.join(ROOT, 'dist', 'games', 'gomoku3d', 'index.html')
const SOURCE = path.join(ROOT, 'src', 'js', 'game3d.js')
const Rules = require('../lib/gomoku3d-rules')

let pass = 0
let fail = 0
function ok (name, cond, extra) {
	if (cond) {
		pass++
		console.log('PASS  ' + name)
	} else {
		fail++
		console.log('FAIL  ' + name + (extra ? ' :: ' + extra : ''))
	}
}

/* ---------------- 0. 构建产物是否存在 ---------------- */

for (const f of [BUNDLE, PAGE]) {
	if (!fs.existsSync(f)) {
		console.error('缺少构建产物：' + path.relative(ROOT, f) + '，请先执行 npx gulp build')
		process.exit(1)
	}
}

/* ---------------- 1. 最小 DOM 桩 ---------------- */

function makeEl (sel) {
	const classes = new Set()
	const el = {
		selector: sel,
		id: sel.charAt(0) === '#' ? sel.slice(1) : '',
		value: '',
		textContent: '',
		placeholder: '',
		maxLength: 0,
		disabled: false,
		hidden: false,
		checked: false,
		_listeners: {},
		classList: {
			add: function () {
				for (let i = 0; i < arguments.length; i++) classes.add(arguments[i])
			},
			remove: function () {
				for (let i = 0; i < arguments.length; i++) classes.delete(arguments[i])
			},
			contains: function (c) {
				return classes.has(c)
			},
			toggle: function (c, on) {
				if (on === undefined) {
					if (classes.has(c)) classes.delete(c)
					else classes.add(c)
					return
				}
				if (on) classes.add(c)
				else classes.delete(c)
			}
		},
		addEventListener: function (type, fn) {
			;(el._listeners[type] = el._listeners[type] || []).push(fn)
		},
		fire: function (type, ev) {
			;(el._listeners[type] || []).forEach(function (fn) {
				fn(ev || {})
			})
		},
		focus: function () {
			sandbox.document.activeElement = el
		},
		select: function () {},
		closest: function () {
			return null
		},
		setPointerCapture: function () {},
		releasePointerCapture: function () {},
		getBoundingClientRect: function () {
			return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
		}
	}
	return el
}

const els = new Map()
const docListeners = {}
const sandbox = {
	console: console,
	location: { hash: '', protocol: 'http:', host: '127.0.0.1:3000', pathname: '/games/gomoku3d/' },
	performance: { now: function () { return Date.now() } },
	requestAnimationFrame: function () { return 0 },
	cancelAnimationFrame: function () {},
	setTimeout: setTimeout,
	clearTimeout: clearTimeout,
	setInterval: setInterval,
	clearInterval: clearInterval,
	document: {
		activeElement: null,
		querySelector: function (sel) {
			if (!els.has(sel)) els.set(sel, makeEl(sel))
			return els.get(sel)
		},
		addEventListener: function (type, fn) {
			docListeners[type] = fn
		}
	},
	// window.* 都落在这个沙箱对象上（下面 window = sandbox）
	addEventListener: function () {},
	removeEventListener: function () {},
	confirm: function () {
		return false
	},
	WebSocket: function () {
		throw new Error('本用例不应发起真实 WebSocket 连接')
	}
}
sandbox.window = sandbox
sandbox.self = sandbox
vm.createContext(sandbox)

/* ---------------- 2. 复现真实脚本顺序 ---------------- */

let loadError = null
try {
	// 此刻 window.Gomoku3DRules 还不存在 —— 正是页面里 game3d.js 先执行的状态
	assert.strictEqual(sandbox.Gomoku3DRules, undefined)
	vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'game3d.js' })
} catch (e) {
	loadError = e
}
ok(
	'game3d.js 在规则模块尚未加载时不报错（不能顶层读 Gomoku3DRules）',
	!loadError,
	loadError && loadError.message
)
if (loadError) {
	console.log('\n==> ' + pass + ' passed, ' + (fail + 1) + ' failed')
	process.exit(1)
}

// 规则模块的 <script> 排在后面，这里补上
sandbox.Gomoku3DRules = Rules
docListeners.DOMContentLoaded()
const app = sandbox.__gomoku3d
ok('DOMContentLoaded 后创建了 App 实例', !!app)

/* ---------------- 3. DOM id 契约：src 要求 vs 构建产物 ---------------- */

const pageHtml = fs.readFileSync(PAGE, 'utf8')
const srcCode = fs.readFileSync(SOURCE, 'utf8')

const requiredIds = new Set()
{
	const re = /\$\('#([\w-]+)'\)/g
	let m
	while ((m = re.exec(srcCode)) !== null) requiredIds.add(m[1])
}
ok('从 src 中解析到客户端依赖的 DOM id', requiredIds.size >= 15, '共 ' + requiredIds.size + ' 个')

const missing = Array.from(requiredIds).filter(function (id) {
	return pageHtml.indexOf('id="' + id + '"') < 0
})
ok(
	'客户端引用的每个 id 都存在于构建产物中',
	missing.length === 0,
	missing.length ? '缺失: ' + missing.join(', ') : ''
)

const requiredClasses = new Set()
{
	const re = /\$\('\.([\w-]+)'\)/g
	let m
	while ((m = re.exec(srcCode)) !== null) requiredClasses.add(m[1])
}
const missingCls = Array.from(requiredClasses).filter(function (c) {
	return pageHtml.indexOf('class="' + c) < 0 && pageHtml.indexOf(' ' + c) < 0
})
ok(
	'客户端引用的每个 class 都存在于构建产物中',
	missingCls.length === 0,
	missingCls.length ? '缺失: ' + missingCls.join(', ') : ''
)

ok('坐标输入区已内联进对局页', pageHtml.indexOf('id="move-form"') >= 0)
ok('轴图例三支齐备', (pageHtml.match(/class="game3d-axis is-[xyz]"/g) || []).length === 3)

/* ---------------- 4. 交互行为 ---------------- */

const sent = []
app.net.send = function (obj) {
	sent.push(obj)
}

// 记录 App 对预览的调用序列（Board3D 没有 three.js 时不会真的显示，只看调用契约）
const previewLog = []
const rawSetPreview = app.board.setPreview.bind(app.board)
const rawClearPreview = app.board.clearPreview.bind(app.board)
app.board.setPreview = function (cell) {
	previewLog.push(cell ? 'show:' + cell.join(',') : 'hide')
	return rawSetPreview(cell)
}
app.board.clearPreview = function () {
	previewLog.push('hide')
	return rawClearPreview()
}
function lastPreview () {
	return previewLog[previewLog.length - 1]
}

/* 注意：本用例没有 three.js，board.preview 为 null，
   因此 Board3D.setPreview 内部会走 clearPreview 的兜底分支，
   预览日志里可能出现多余的 hide —— 断言只取「是否请求过该格」与「最终是否收起」。 */

function setState (over) {
	const n = 4
	const state = Object.assign(
		{
			room: '1234',
			n: n,
			m: 4,
			status: 'playing',
			turn: 1,
			winner: 0,
			reason: '',
			winCells: [],
			lastMove: null,
			moveCount: 0,
			board: new Array(n * n * n).fill(0),
			turnRemainMs: 0,
			graceRemainMs: 0,
			seats: [
				{ name: '甲', connected: true, player: 1 },
				{ name: '乙', connected: true, player: 2 }
			]
		},
		over || {}
	)
	app.room = '1234'
	app.myPlayer = 1
	app.applyState(state)
	return state
}

function type (index, text) {
	const input = app.coordInputs[index]
	input.value = ''
	// 逐字符模拟，触发与真实输入一致的 input 事件
	for (const ch of String(text)) {
		input.value += ch
		input.fire('input')
	}
}

function clearInputs () {
	app.coordInputs.forEach(function (i) {
		i.value = ''
	})
}

const hint = els.get('#coord-hint')

setState()
ok('轮到自己时输入框可用', app.coordInputs.every((i) => !i.disabled))
ok('轮到自己时落子按钮可用', !els.get('#btn-move').disabled)

previewLog.length = 0
type(0, '1')
type(1, '0')
type(2, '2')
ok('合法坐标给出「将落在」提示', hint.textContent.indexOf('将落在 (1,0,2)') >= 0, hint.textContent)
ok('预览提示标记为通过态', hint.classList.contains('is-ok'))
ok(
	'已把预览落到 (1,0,2)',
	previewLog.indexOf('show:1,0,2') >= 0,
	JSON.stringify(previewLog)
)

sent.length = 0
els.get('#move-form').fire('submit', { preventDefault: function () {} })
ok(
	'提交后发送 move 指令',
	sent.length === 1 &&
		sent[0].type === 'move' &&
		sent[0].x === 1 &&
		sent[0].y === 0 &&
		sent[0].z === 2,
	JSON.stringify(sent)
)
ok('提交后清空输入框', app.coordInputs.every((i) => i.value === ''))
ok('提交后收起预览', lastPreview() === 'hide', JSON.stringify(previewLog))

/* 越界坐标 */
type(0, '9')
type(1, '0')
type(2, '0')
ok('越界坐标给出错误提示', hint.classList.contains('is-error'), hint.textContent)
sent.length = 0
app.submitMove()
ok('越界坐标不会发送指令', sent.length === 0)

/* 已有棋子：直接预置 board.stones，等价于该格已被占用 */
setState()
app.board.stones['0,0,0'] = { userData: { player: 2 } }
ok('hasStone 能识别已占用的格子', app.board.hasStone([0, 0, 0]))
type(0, '0')
type(1, '0')
type(2, '0')
ok('占用格给出错误提示', hint.classList.contains('is-error'), hint.textContent)
sent.length = 0
app.submitMove()
ok('占用格不会发送指令', sent.length === 0)
delete app.board.stones['0,0,0']

/* 不是自己回合 */
setState({ turn: 2 })
ok('对手回合时输入框被禁用', app.coordInputs.every((i) => i.disabled))
ok('对手回合时落子按钮被禁用', els.get('#btn-move').disabled)
ok('对手回合时表单标记为锁定', els.get('#move-form').classList.contains('is-locked'))
sent.length = 0
app.submitMove()
ok('对手回合时提交被本地拦截', sent.length === 0)

/* 服务端拒绝后回填 */
setState({ turn: 1 })
type(0, '2')
type(1, '2')
type(2, '2')
sent.length = 0
app.submitMove()
ok('合法坐标在本人回合下会发送', sent.length === 1)
ok('提交后输入框被清空', app.coordInputs.every((i) => i.value === ''))
app.net.emit('error', { message: '这里已经有子了' })
ok(
	'服务端拒绝后坐标被回填，避免重敲',
	app.coordInputs.map((i) => i.value).join(',') === '2,2,2',
	app.coordInputs.map((i) => i.value).join(',')
)

/* 自动跳格 */
setState({ turn: 1 })
clearInputs()
sandbox.document.activeElement = null
type(0, '3')
ok(
	'填满一位后自动跳到下一个输入框',
	sandbox.document.activeElement === app.coordInputs[1],
	sandbox.document.activeElement && sandbox.document.activeElement.selector
)

/* 输入过滤 */
clearInputs()
app.coordInputs[0].value = 'a1b'
app.coordInputs[0].fire('input')
ok('输入框过滤掉非数字字符', app.coordInputs[0].value === '1', app.coordInputs[0].value)

/* 上一手显示 */
setState({ lastMove: { x: 3, y: 1, z: 0, player: 2 } })
ok(
	'上一手显示在 HUD',
	els.get('#hud-last').textContent.indexOf('(3,1,0)') >= 0,
	els.get('#hud-last').textContent
)
setState({ lastMove: null })
ok('无上一手时清空该行', els.get('#hud-last').textContent === '')

/* 非进行中的局面 */
setState({ status: 'waiting', board: [] })
ok('等待开局时输入区被禁用', app.coordInputs.every((i) => i.disabled))
ok('等待开局时提示为空', hint.textContent === '', hint.textContent)

/* N 变化时同步输入位数与占位符（直接调 updateMoveForm，避免触发棋盘重建） */
app.updateMoveForm({ n: 8, status: 'playing', turn: 1 })
ok(
	'N=8 时输入位数与占位符同步',
	app.coordInputs[0].maxLength === 1 && app.coordInputs[0].placeholder === '0-7',
	app.coordInputs[0].maxLength + ' / ' + app.coordInputs[0].placeholder
)
app.updateMoveForm({ n: 12, status: 'playing', turn: 1 })
ok(
	'N=12 时允许两位坐标',
	app.coordInputs[0].maxLength === 2 && app.coordInputs[0].placeholder === '0-11',
	app.coordInputs[0].maxLength + ' / ' + app.coordInputs[0].placeholder
)

console.log('\n==> ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
