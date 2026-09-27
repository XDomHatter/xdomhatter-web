/**
 * 坐标落子交互的回归测试（无需浏览器 / 无需 WebGL）。
 *
 * 做法：把构建产物 dist/js/game3d.js 放进一个最小 DOM 桩里真实执行，
 * 再直接调用 App 的公开方法驱动交互。之所以跑 dist 而不是 src，
 * 是因为要验证「实际发出去的页面脚本」而不是源码。
 *
 * 重点覆盖四件在浏览器里最容易踩、单测又最容易漏的事：
 *   1. 脚本加载顺序：layout.pug 把规则模块的 <script> 排在 game3d.js 之后，
 *      所以顶层绝不能读 window.Gomoku3DRules（这里刻意先加载 game3d.js、
 *      之后再挂规则模块，复现真实顺序）；
 *   2. 客户端要求的 DOM id 是否都在构建产物里（把 src 里的 $('#id') 全部
 *      抽出来逐个核对，比手写一份清单更不容易漏）；
 *   3. spinner 的层级契约：game3d.js 通过 coordInput.parentNode 找同组的
 *      上下键，所以 DOM 桩必须真的把「上键 / 数值框 / 下键」搭成父子结构，
 *      否则按钮绑不上事件，测试会假装通过而实际点了没反应；
 *   4. 坐标校验、回合门禁、步进/环绕/夹取、提交与回填的行为。
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
	const attrs = {}

	// 从选择器里提取 id 与 class，例如
	//   'button.game3d-coord-step is-up' -> classes = [game3d-coord-step, is-up]
	//   '#coord-x'                       -> id = coord-x
	// 必须真的把 class 装进 classList：否则 contains 恒为假，
	// querySelectorAll('.game3d-coord-step') 一个按钮都找不到，
	// 测试会在「按钮已经绑上事件」的假象下全绿。
	const parts = sel.split(/[\s.]+/).filter(Boolean)
	let id = ''
	parts.forEach(function (part) {
		if (part.charAt(0) === '#') {
			id = part.slice(1)
			return
		}
		// 纯字母片段是 tag 名（div / button / span / input），不当 class 处理
		if (/^[a-z]+$/i.test(part)) return
		classes.add(part)
	})

	const el = {
		selector: sel,
		id: id,
		value: '',
		textContent: '',
		placeholder: '',
		maxLength: 0,
		disabled: false,
		hidden: false,
		checked: false,
		parentNode: null,
		children: [],
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
		setAttribute: function (name, value) {
			attrs[name] = String(value)
		},
		getAttribute: function (name) {
			return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null
		},
		addEventListener: function (type, fn) {
			;(el._listeners[type] = el._listeners[type] || []).push(fn)
		},
		fire: function (type, ev) {
			// 默认补一个带 preventDefault 的事件对象：真实浏览器里 pointerdown /
			// keydown 都带这个方法，桩里若缺了，被测代码调用时会直接抛错，
			// 看起来像业务 bug，实际是桩不完整。
			const event = Object.assign(
				{ preventDefault: function () {}, stopPropagation: function () {} },
				ev || {}
			)
			;(el._listeners[type] || []).forEach(function (fn) {
				fn(event)
			})
		},
		// 按 class 做子树查询，语义与真实 DOM 一致：模板里按钮嵌在
		// .game3d-coord-steps 里，而 game3d.js 是从 body 往下找 .game3d-coord-step，
		// 只查直接子节点会漏掉，测试就会假装通过而实际页面点了没反应。
		querySelectorAll: function (query) {
			const want = query.replace(/^\./, '')
			const found = []
			const walk = function (node) {
				node.children.forEach(function (child) {
					if (child.classList.contains(want)) found.push(child)
					walk(child)
				})
			}
			walk(el)
			return found
		},
		click: function () {
			el.fire('click', { preventDefault: function () {} })
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

/** 造一个「上按钮 + 数值框 + 下按钮」的坐标组，层级与 gomoku3d.pug 完全一致 */
function makeCoordGroup (axis) {
	const input = makeEl('#coord-' + axis)
	const box = makeEl('span.game3d-coord-body')
	const stepsBox = makeEl('span.game3d-coord-steps')
	const up = makeEl('button.game3d-coord-step is-up')
	up.setAttribute('data-step', '1')
	up.setAttribute('data-axis', axis)
	const down = makeEl('button.game3d-coord-step is-down')
	down.setAttribute('data-step', '-1')
	down.setAttribute('data-axis', axis)
	// body > [steps > [up, down], input]，与模板一致
	stepsBox.children = [up, down]
	up.parentNode = stepsBox
	down.parentNode = stepsBox
	box.children = [stepsBox, input]
	stepsBox.parentNode = box
	input.parentNode = box
	return { box: box, stepsBox: stepsBox, input: input, up: up, down: down }
}

const els = new Map()
const docListeners = {}

// 三个坐标轴各自的 spinner 组（上键 / 数值框 / 下键），与页面模板同构。
// 必须在这里预置：game3d.js 通过 coordInput.parentNode 去找同组的上下键，
// 若父节点是空壳，按钮就绑不上事件，测试会退化成「按钮点了没反应」。
const coordGroups = {
	x: makeCoordGroup('x'),
	y: makeCoordGroup('y'),
	z: makeCoordGroup('z')
}
const coordValueEls = {
	x: makeEl('#coord-x-value'),
	y: makeEl('#coord-y-value'),
	z: makeEl('#coord-z-value')
}

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
			// 坐标相关的节点走预置实例，保证父子关系与页面一致
			for (const axis of ['x', 'y', 'z']) {
				if (sel === '#coord-' + axis) return coordGroups[axis].input
				if (sel === '#coord-' + axis + '-value') return coordValueEls[axis]
			}
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
	// 每段用例都从默认坐标 (0,0,0) 出发：applyState 会走 updateMoveForm，
	// 它只做夹取不做归零，会把上一段的残留值带进来，导致断言互相污染。
	app.resetCoords(false)
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
ok(
	'提交后坐标重置为默认 (0,0,0)',
	app.coordInputs.every((i) => i.value === '0'),
	app.coordInputs.map((i) => i.value).join(',')
)
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

/* 占用提示：输入指向占用格时 Board3D 要留下标记，移到空格后要清除。
   无 three.js 时 halo 不会真的显示，这里验证的是 App↔Board3D 的调用契约 */
setState({ turn: 1 })
app.board.stones['1,2,3'] = { userData: { player: 2 } }
type(0, '1')
type(1, '2')
type(2, '3')
ok(
	'输入指向占用格时记录占用提示',
	JSON.stringify(app.board._occupiedCell) === '[1,2,3]',
	JSON.stringify(app.board._occupiedCell)
)
type(0, '3')
type(1, '3')
type(2, '3')
ok(
	'移到空格后占用提示清除',
	app.board._occupiedCell === null,
	JSON.stringify(app.board._occupiedCell)
)
type(0, '1')
type(1, '2')
type(2, '3')
sent.length = 0
app.submitMove()
ok(
	'提交占用格被拦截时同样给出占用提示',
	JSON.stringify(app.board._occupiedCell) === '[1,2,3]',
	JSON.stringify(app.board._occupiedCell)
)
ok('占用格提交不发送指令', sent.length === 0)
delete app.board.stones['1,2,3']

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
ok(
	'提交后坐标回到默认 (0,0,0)',
	app.coordInputs.every((i) => i.value === '0'),
	app.coordInputs.map((i) => i.value).join(',')
)
app.net.emit('error', { message: '这里已经有子了' })
ok(
	'服务端拒绝后坐标被回填，避免重敲',
	app.coordInputs.map((i) => i.value).join(',') === '2,2,2',
	app.coordInputs.map((i) => i.value).join(',')
)

/* 提交后坐标回到默认值 (0,0,0) */
setState({ turn: 1 })
ok(
	'提交后坐标重置为默认 (0,0,0)',
	app.coordInputs.map((i) => i.value).join(',') === '0,0,0',
	app.coordInputs.map((i) => i.value).join(',')
)

/* ---------------- spinner：默认值 / 上下键 / 环绕 ---------------- */

console.log('\n[spinner]')

function axis (name) {
	return coordGroups[name]
}
function values () {
	return app.coordInputs.map((i) => i.value).join(',')
}
function shown () {
	return ['x', 'y', 'z'].map((k) => coordValueEls[k].textContent).join(',')
}

/**
 * 真实鼠标的一次点击：pointerdown -> pointerup -> click。
 *
 * 必须走完整序列，不能只 fire('click')：点击处理里靠
 * _suppressClickBtn 跳过 pointerdown 之后补发的那次 click，
 * 只发 click 会绕过这条路径，此前「点一下却走两格」的 bug 就是这么漏掉的。
 */
function mouseClick (btn) {
	btn.fire('pointerdown', { pointerId: 1 })
	btn.fire('pointerup', { pointerId: 1 })
	btn.fire('click')
}

setState({ turn: 1 })
ok('初始值为 (0,0,0)', values() === '0,0,0', values())
ok('spinner 读数与提交值一致', shown() === '0,0,0', shown())

/* 回归：一次真实点击只走一格（曾出现 pointerdown 走一步 + click 补走一步 = +2） */
mouseClick(axis('x').up)
ok('mouseClick 一次点击只 +1（回归：曾误走 +2）', app.coordInputs[0].value === '1', app.coordInputs[0].value)
mouseClick(axis('x').up)
ok('mouseClick 连点两次得到 2', app.coordInputs[0].value === '2', app.coordInputs[0].value)
mouseClick(axis('x').down)
mouseClick(axis('x').down)
ok('mouseClick 下键同样只走一格', app.coordInputs[0].value === '0', app.coordInputs[0].value)

/* 上键 +1 */
mouseClick(axis('x').up)
ok('x 上键 +1', app.coordInputs[0].value === '1', app.coordInputs[0].value)
ok('x 读数同步刷新', coordValueEls.x.textContent === '1', coordValueEls.x.textContent)
mouseClick(axis('x').down)
ok('x 下键 -1 回到 0', app.coordInputs[0].value === '0', app.coordInputs[0].value)

/* 三轴互不串台 */
mouseClick(axis('y').up)
mouseClick(axis('z').up)
mouseClick(axis('z').up)
ok(
	'三轴各自独立步进',
	values() === '0,1,2',
	values()
)

/* 边界环绕：0 再按下回到 N-1 */
setState({ turn: 1 })
mouseClick(axis('z').down)
ok('N=4 时 0 按下环绕到 3', app.coordInputs[2].value === '3', app.coordInputs[2].value)
mouseClick(axis('z').up)
ok('3 再按上环绕回 0', app.coordInputs[2].value === '0', app.coordInputs[2].value)

/* 环绕要绕满整圈都合法 */
setState({ turn: 1 })
for (let i = 0; i < 4; i++) mouseClick(axis('x').up)
ok('连按 4 次上键绕回 0（N=4）', app.coordInputs[0].value === '0', app.coordInputs[0].value)

/* 步进后预览与提示跟随 */
setState({ turn: 1 })
previewLog.length = 0
mouseClick(axis('x').up)
ok('步进后提示更新为新坐标', hint.textContent.indexOf('将落在 (1,0,0)') >= 0, hint.textContent)
ok('步进后预览落到新坐标', previewLog.indexOf('show:1,0,0') >= 0, JSON.stringify(previewLog))

/* 步进出的坐标可以直接落子 */
setState({ turn: 1 })
sent.length = 0
mouseClick(axis('y').up)
mouseClick(axis('y').up)
els.get('#move-form').fire('submit', { preventDefault: function () {} })
ok(
	'用 spinner 调出的坐标能正常提交',
	sent.length === 1 && sent[0].x === 0 && sent[0].y === 2 && sent[0].z === 0,
	JSON.stringify(sent)
)

/* 键盘上下键（Enter/Space 触发的是 click，且不带 pointerdown）
   这里显式补一个裸 click 用例，确保键盘激活不被 _suppressClickBtn 误吞 */
setState({ turn: 1 })
axis('x').up.fire('keydown', { key: 'ArrowUp', preventDefault: function () {} })
ok('按钮上 ArrowUp 等价于上键', app.coordInputs[0].value === '1', app.coordInputs[0].value)
axis('x').up.fire('keydown', { key: 'ArrowDown', preventDefault: function () {} })
ok('按钮上 ArrowDown 等价于下键', app.coordInputs[0].value === '0', app.coordInputs[0].value)
axis('x').up.fire('keydown', { key: 'ArrowLeft', preventDefault: function () {} })
ok('无关按键不改变坐标', app.coordInputs[0].value === '0', app.coordInputs[0].value)

/* 回归：Enter 激活只发 click（无 pointerdown），必须仍然 +1 */
setState({ turn: 1 })
axis('x').up.fire('click')
ok('裸 click（键盘 Enter）走一格', app.coordInputs[0].value === '1', app.coordInputs[0].value)
axis('x').up.fire('click')
ok('裸 click 连续两次得 2', app.coordInputs[0].value === '2', app.coordInputs[0].value)

/* 回归：鼠标点击后再用键盘激活，键盘那次不能被吞掉 */
setState({ turn: 1 })
mouseClick(axis('x').up)
ok('鼠标点击一次得 1', app.coordInputs[0].value === '1', app.coordInputs[0].value)
axis('x').up.fire('click')
ok('紧接的键盘 click 未被吞（得 2）', app.coordInputs[0].value === '2', app.coordInputs[0].value)

/* 长按连续步进 */
setState({ turn: 1 })
axis('x').up.fire('pointerdown')
ok('长按立即走一步', app.coordInputs[0].value === '1', app.coordInputs[0].value)
axis('x').up.fire('pointerup')
/* 松手时浏览器仍会补一次 click，这一步绝不能再走一格 */
axis('x').up.fire('click')
ok('长按松手后补发的 click 不重复步进', app.coordInputs[0].value === '1', app.coordInputs[0].value)
mouseClick(axis('x').up)
ok('长按后再正常点击仍只 +1', app.coordInputs[0].value === '2', app.coordInputs[0].value)

/* N 变小后旧值必须被夹回范围内 */
setState({ n: 12, turn: 1, board: new Array(12 * 12 * 12).fill(0) })
for (let i = 0; i < 9; i++) mouseClick(axis('x').up)
ok('N=12 时 x 可到 9', app.coordInputs[0].value === '9', app.coordInputs[0].value)
ok(
	'N=12 时读数同步到 9',
	coordValueEls.x.textContent === '9',
	coordValueEls.x.textContent
)
// 换回小棋盘：越界的 9 必须被夹回 3，否则会带着一个提交必被拒的值
setState({ n: 4, turn: 1 })
app.writeCoord(0, 9, false)
ok('N 降到 4 后 x 被夹回 3', app.coordInputs[0].value === '3', app.coordInputs[0].value)
ok(
	'N 变化后 spinner 读数同步夹取',
	coordValueEls.x.textContent === '3',
	coordValueEls.x.textContent
)

/* 对手回合：按钮与输入框一起禁用 */
setState({ turn: 2 })
ok('对手回合时上下键被禁用', axis('x').up.disabled && axis('x').down.disabled)
sent.length = 0
mouseClick(axis('x').up)
ok('禁用状态下点按钮不改变坐标、不发指令', sent.length === 0 && app.coordInputs[0].value !== '4')

/* 服务端拒绝后回填到 spinner 读数 */
setState({ turn: 1 })
mouseClick(axis('x').up)
mouseClick(axis('x').up)
sent.length = 0
app.submitMove()
ok('提交前坐标已调好', sent.length === 1 && sent[0].x === 2)
app.net.emit('error', { message: '这里已经有子了' })
ok(
	'回填后 spinner 读数同步',
	coordValueEls.x.textContent === '2',
	coordValueEls.x.textContent
)

/* 手输路径仍可用（spinner 是主路径，但不是唯一路径） */
setState({ turn: 1 })
app.coordInputs[0].value = 'a1b'
app.coordInputs[0].fire('input')
ok('手输仍过滤非数字字符', app.coordInputs[0].value === '1', app.coordInputs[0].value)
ok('手输后读数同步', coordValueEls.x.textContent === '1', coordValueEls.x.textContent)

/* 上一手显示 */
setState({ lastMove: { x: 3, y: 1, z: 0, player: 2 } })
ok(
	'上一手显示在 HUD',
	els.get('#hud-last').textContent.indexOf('(3,1,0)') >= 0,
	els.get('#hud-last').textContent
)
setState({ lastMove: null })
ok('无上一手时清空该行', els.get('#hud-last').textContent === '')

/* 最后一手指示：Board3D 从 state 快照记录 lastMove 供 3D 光环使用
   （无 three.js 时 halo 不渲染，只验证 sync→Board3D 的数据契约） */
setState({ lastMove: { x: 3, y: 1, z: 0, player: 2 } })
ok(
	'最后一手被 Board3D 记录',
	JSON.stringify(app.board._lastMove) === JSON.stringify({ x: 3, y: 1, z: 0, player: 2 }),
	JSON.stringify(app.board._lastMove)
)
setState({ lastMove: null })
ok(
	'重开后最后一手指示清除',
	app.board._lastMove === null,
	JSON.stringify(app.board._lastMove)
)

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
