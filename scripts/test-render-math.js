/**
 * 渲染层数学验证（无需浏览器）。
 *
 * 目的：在不依赖 WebGL 的前提下，验证 Board3D 的两条关键数学路径
 *   1. cellToWorld —— 棋盘居中于原点（这是「渲染在屏幕正中央」的根据）；
 *   2. 坐标轴正方向的屏幕投影 —— 落子方式改为「输入 x/y/z 坐标」之后，
 *      玩家唯一的方位依据就是棋盘角落的三支箭头和页面图例。
 *      因此 lib/gomoku3d-rules.js 里 AXES[].screen 写的「右下 / 正上 / 左下」
 *      必须与相机矩阵算出来的实际投影一致：改相机而不同步文案，这里会立刻失败。
 *
 * 相机参数、球坐标旋转、投影公式与 src/js/game3d.js 保持一致。
 */

const Rules = require('../lib/gomoku3d-rules')

// ---- 与 three.js PerspectiveCamera 等价的投影矩阵（列主序）----
function perspective (fovDeg, aspect, near, far) {
	const f = 1 / Math.tan((fovDeg * Math.PI) / 180 / 2)
	const nf = 1 / (near - far)
	return [
		f / aspect, 0, 0, 0,
		0, f, 0, 0,
		0, 0, (far + near) * nf, -1,
		0, 0, 2 * far * near * nf, 0
	]
}

function multiply (a, b) {
	const o = new Array(16)
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) {
			o[c * 4 + r] =
				a[0 * 4 + r] * b[c * 4 + 0] +
				a[1 * 4 + r] * b[c * 4 + 1] +
				a[2 * 4 + r] * b[c * 4 + 2] +
				a[3 * 4 + r] * b[c * 4 + 3]
		}
	}
	return o
}

/** lookAt：与 three.js Matrix4.lookAt 同一算法（右手系，相机看向 -Z） */
function lookAt (eye, target, up) {
	const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2]
	const zl = Math.hypot(zx, zy, zz)
	const z = [zx / zl, zy / zl, zz / zl]

	const xx = up[1] * z[2] - up[2] * z[1]
	const xy = up[2] * z[0] - up[0] * z[2]
	const xz = up[0] * z[1] - up[1] * z[0]
	const xl = Math.hypot(xx, xy, xz) || 1
	const x = [xx / xl, xy / xl, xz / xl]

	const y = [
		z[1] * x[2] - z[2] * x[1],
		z[2] * x[0] - z[0] * x[2],
		z[0] * x[1] - z[1] * x[0]
	]

	return [
		x[0], y[0], z[0], 0,
		x[1], y[1], z[1], 0,
		x[2], y[2], z[2], 0,
		-eye[0] * x[0] - eye[1] * x[1] - eye[2] * x[2],
		-eye[0] * y[0] - eye[1] * y[1] - eye[2] * y[2],
		-eye[0] * z[0] - eye[1] * z[1] - eye[2] * z[2],
		1
	]
}

/** 把世界点投影到 NDC */
function project (p, viewProj) {
	const v = [p[0], p[1], p[2], 1]
	const out = [0, 0, 0, 0]
	for (let r = 0; r < 4; r++) {
		out[r] =
			viewProj[0 * 4 + r] * v[0] +
			viewProj[1 * 4 + r] * v[1] +
			viewProj[2 * 4 + r] * v[2] +
			viewProj[3 * 4 + r] * v[3]
	}
	if (out[3] === 0) return null
	return [out[0] / out[3], out[1] / out[3], out[2] / out[3]]
}

// ---- 与 game3d.js 一致的相机初始姿态 ----
function makeCamera (n, width, height) {
	const d = n * 2.0
	const eye = [d * 0.62, d * 0.62, d * 0.72]
	const view = lookAt(eye, [0, 0, 0], [0, 1, 0])
	const proj = perspective(42, width / height, 0.1, 200)
	return { eye, viewProj: multiply(proj, view), width, height }
}

function cellToWorld (n, x, y, z) {
	const off = (n - 1) / 2
	return [x - off, y - off, z - off]
}

/** 世界点 -> 屏幕像素（y 轴向下，与浏览器一致） */
function toScreen (cam, world) {
	const ndc = project(world, cam.viewProj)
	return [((ndc[0] + 1) / 2) * cam.width, ((1 - ndc[1]) / 2) * cam.height]
}

/** 沿某轴走一格，在屏幕上产生的位移（dx 右为正，dy 下为正） */
function screenStep (cam, n, axis) {
	const a = toScreen(cam, cellToWorld(n, 0, 0, 0))
	const b = toScreen(
		cam,
		cellToWorld(n, axis[0], axis[1], axis[2])
	)
	return [b[0] - a[0], b[1] - a[1]]
}

/** 把「右下 / 正上 / 左下」这类文案翻译成方向约束 */
function expectFromText (text) {
	return {
		right: text.indexOf('右') >= 0,
		left: text.indexOf('左') >= 0,
		up: text.indexOf('上') >= 0,
		down: text.indexOf('下') >= 0
	}
}

/* ---------------- 断言 ---------------- */

let pass = 0, fail = 0
function t (name, fn) {
	try { fn(); pass++; console.log('  ok   ' + name) }
	catch (e) { fail++; console.error('  FAIL ' + name + '\n       ' + e.message) }
}
const assert = require('assert')

console.log('\n[棋盘居中]')

t('cellToWorld 的几何中心为原点（棋盘位于屏幕正中）', () => {
	for (let n = 3; n <= 8; n++) {
		// 取所有格心的质心，应等于原点
		let cx = 0, cy = 0, cz = 0, count = 0
		for (let x = 0; x < n; x++) {
			for (let y = 0; y < n; y++) {
				for (let z = 0; z < n; z++) {
					const w = cellToWorld(n, x, y, z)
					cx += w[0]; cy += w[1]; cz += w[2]; count++
				}
			}
		}
		assert.ok(Math.abs(cx / count) < 1e-9, 'n=' + n + ' x 质心 ' + cx / count)
		assert.ok(Math.abs(cy / count) < 1e-9, 'n=' + n + ' y 质心 ' + cy / count)
		assert.ok(Math.abs(cz / count) < 1e-9, 'n=' + n + ' z 质心 ' + cz / count)
	}
})

t('camera.lookAt(0,0,0) 使原点投影到屏幕正中', () => {
	for (let n = 3; n <= 8; n++) {
		const cam = makeCamera(n, 1280, 720)
		const c = project([0, 0, 0], cam.viewProj)
		assert.ok(Math.abs(c[0]) < 1e-9 && Math.abs(c[1]) < 1e-9, 'n=' + n)
	}
})

t('对角格关于原点对称', () => {
	for (let n = 3; n <= 8; n++) {
		const a = cellToWorld(n, 0, 0, 0)
		const b = cellToWorld(n, n - 1, n - 1, n - 1)
		assert.ok(Math.abs(a[0] + b[0]) < 1e-9)
		assert.ok(Math.abs(a[1] + b[1]) < 1e-9)
		assert.ok(Math.abs(a[2] + b[2]) < 1e-9)
	}
})

console.log('\n[坐标轴正方向]')

t('AXES 定义了三支两两正交的纯轴向单位向量', () => {
	assert.strictEqual(Rules.AXES.length, 3, '轴数量应为 3')
	const keys = Rules.AXES.map((a) => a.key).join('')
	assert.strictEqual(keys, 'xyz', '轴顺序应为 x/y/z，实际 ' + keys)

	Rules.AXES.forEach((axis) => {
		const v = axis.vector
		assert.strictEqual(v.length, 3, axis.key + ' 向量维度')
		const len = Math.hypot(v[0], v[1], v[2])
		assert.ok(Math.abs(len - 1) < 1e-9, axis.key + ' 应为单位向量，实际 ' + len)
		assert.strictEqual(
			v.filter((c) => c !== 0).length,
			1,
			axis.key + ' 应为纯轴向（只允许一个非零分量）'
		)
	})

	for (let i = 0; i < 3; i++) {
		for (let j = i + 1; j < 3; j++) {
			const a = Rules.AXES[i].vector
			const b = Rules.AXES[j].vector
			const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
			assert.strictEqual(dot, 0, '轴应两两正交')
		}
	}
})

t('每支轴的正方向在屏幕上的朝向与图例文案一致', () => {
	// 图例文案（AXES[].screen）是玩家唯一的方位依据，
	// 必须与相机矩阵算出的实际投影一致，否则「按坐标落子」会系统性落错位置。
	for (const n of [3, 4, 5, 6, 8]) {
		for (const [w, h] of [[1280, 720], [900, 900], [800, 1000]]) {
			const cam = makeCamera(n, w, h)
			Rules.AXES.forEach((axis) => {
				const [dx, dy] = screenStep(cam, n, axis.vector)
				const want = expectFromText(axis.screen)
				const tag =
					'+' + axis.key + ' n=' + n + ' ' + w + 'x' + h +
					' 实际位移 (' + dx.toFixed(1) + ',' + dy.toFixed(1) + ')' +
					' 文案「' + axis.screen + '」'

				// 注意：透视投影下即使相机 right 向量与轴正交，轴的屏幕投影
				// 也不会严格水平/垂直（沿轴移动会改变深度，透视除法带来轻微漂移）。
				// 所以这里判定的是「主方向」，用相对量而非绝对像素阈值。
				const ax = Math.abs(dx)
				const ay = Math.abs(dy)
				const DOMINANT = 0.15 // 主方向至少要比次方向大这么多倍
				const NEGLIGIBLE = 0.05 // 无该方向分量时允许的漂移比例

				if (want.right) {
					assert.ok(dx > 0 && dx > DOMINANT * ay, '应以右为主 · ' + tag)
				} else if (want.left) {
					assert.ok(dx < 0 && ax > DOMINANT * ay, '应以左为主 · ' + tag)
				} else {
					assert.ok(ax < NEGLIGIBLE * ay, '不应有水平分量 · ' + tag)
				}

				// 屏幕 y 轴向下为正
				if (want.down) {
					assert.ok(dy > 0 && dy > DOMINANT * ax, '应以下为主 · ' + tag)
				} else if (want.up) {
					assert.ok(dy < 0 && ay > DOMINANT * ax, '应以上为主 · ' + tag)
				} else {
					assert.ok(ay < NEGLIGIBLE * ax, '不应有垂直分量 · ' + tag)
				}
			})
		}
	}
})

t('三支轴在屏幕上的朝向互不重合（否则玩家无法区分坐标）', () => {
	const n = 4
	const cam = makeCamera(n, 1280, 720)
	const dirs = Rules.AXES.map((axis) => {
		const [dx, dy] = screenStep(cam, n, axis.vector)
		const len = Math.hypot(dx, dy)
		return [dx / len, dy / len]
	})
	for (let i = 0; i < dirs.length; i++) {
		for (let j = i + 1; j < dirs.length; j++) {
			const cos = dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1]
			assert.ok(
				Math.abs(cos) < 0.95,
				'轴 ' + Rules.AXES[i].key + ' 与 ' + Rules.AXES[j].key +
					' 屏幕朝向过于接近，cos=' + cos.toFixed(3)
			)
		}
	}
})

t('轴方向不随棋盘边长或视口比例改变（文案对任意 N 都成立）', () => {
	// 相机是「按 N 等比拉远」的，因此各轴的屏幕朝向与 N 无关。
	const sample = (n, w, h) => {
		const cam = makeCamera(n, w, h)
		return Rules.AXES.map((axis) => {
			const [dx, dy] = screenStep(cam, n, axis.vector)
			return Math.sign(dx) + ':' + Math.sign(dy)
		}).join('|')
	}
	const base = sample(4, 1280, 720)
	for (const n of [3, 5, 6, 8]) {
		for (const [w, h] of [[900, 900], [1600, 700]]) {
			assert.strictEqual(sample(n, w, h), base, 'n=' + n + ' ' + w + 'x' + h)
		}
	}
})

console.log('\n[球坐标旋转]')

t('拖拽旋转后棋盘仍指向原点（无万向锁、无漂移）', () => {
	// 复刻 _rotate：theta/phi 更新后重算相机位置，lookAt 原点
	function rotate (eye, dx, dy) {
		const radius = Math.hypot(eye[0], eye[1], eye[2])
		let theta = Math.atan2(eye[0], eye[2])
		let phi = Math.acos(Math.max(-1, Math.min(1, eye[1] / radius)))
		theta -= dx * 0.007
		phi -= dy * 0.007
		phi = Math.max(0.12, Math.min(Math.PI - 0.12, phi))
		return [
			radius * Math.sin(phi) * Math.sin(theta),
			radius * Math.cos(phi),
			radius * Math.sin(phi) * Math.cos(theta)
		]
	}

	let eye = [5, 5, 6]
	for (let i = 0; i < 500; i++) {
		eye = rotate(eye, (i % 7) - 3, (i % 5) - 2)
		// phi 被夹在 0.12..π-0.12，故不会退化到极点
		const radius = Math.hypot(eye[0], eye[1], eye[2])
		const phi = Math.acos(Math.max(-1, Math.min(1, eye[1] / radius)))
		assert.ok(phi > 0.11 && phi < Math.PI - 0.11, 'phi 越界: ' + phi)
		assert.ok(Math.abs(radius - Math.hypot(5, 5, 6)) < 1e-9, '半径应守恒')
	}
})

console.log('\n' + '='.repeat(46))
console.log('  通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.error('  失败 ' + fail); process.exit(1) }
console.log('  渲染层数学验证通过')
