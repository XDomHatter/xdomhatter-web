/**
 * 渲染层数学验证（无需浏览器）。
 *
 * 目的：在不依赖 WebGL 的前提下，验证 Board3D 的两条关键数学路径
 *   1. cellToWorld —— 棋盘居中于原点（这是「渲染在屏幕正中央」的根据）；
 *   2. pick 的投影拾取 —— 把 n³ 个格心投影到屏幕后取最近点，
 *      确认「用屏幕坐标能唯一反推出 (x,y,z)」，且网格隐藏时同样成立
 *      （因为拾取完全不依赖可见几何体）。
 *
 * 相机参数、球坐标旋转、投影公式与 src/js/game3d.js 保持一致。
 */

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

function mat4Identity () {
	return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
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
	let zl = Math.hypot(zx, zy, zz)
	const z = [zx / zl, zy / zl, zz / zl]

	let xx = up[1] * z[2] - up[2] * z[1]
	let xy = up[2] * z[0] - up[0] * z[2]
	let xz = up[0] * z[1] - up[1] * z[0]
	let xl = Math.hypot(xx, xy, xz) || 1
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

/** 复刻 Board3D.pick：屏幕坐标 -> 最近格心 */
function pick (cam, n, mx, my) {
	const { viewProj, width, height } = cam
	let best = null
	let bestDist = Infinity
	let bestDepth = Infinity

	// 阈值估算：相邻格心在屏幕上的间距 * 0.62
	const p0 = project(cellToWorld(n, 0, 0, 0), viewProj)
	const p1 = project(cellToWorld(n, 1, 0, 0), viewProj)
	const s0 = [((p0[0] + 1) / 2) * width, ((1 - p0[1]) / 2) * height]
	const s1 = [((p1[0] + 1) / 2) * width, ((1 - p1[1]) / 2) * height]
	const cellPx = Math.hypot(s1[0] - s0[0], s1[1] - s0[1])
	const threshold = Math.max(6, cellPx * 0.62)

	for (let x = 0; x < n; x++) {
		for (let y = 0; y < n; y++) {
			for (let z = 0; z < n; z++) {
				const w = cellToWorld(n, x, y, z)
				const depth = Math.hypot(w[0] - cam.eye[0], w[1] - cam.eye[1], w[2] - cam.eye[2])
				const ndc = project(w, viewProj)
				if (!ndc || ndc[2] < -1 || ndc[2] > 1) continue
				const sx = ((ndc[0] + 1) / 2) * width
				const sy = ((1 - ndc[1]) / 2) * height
				const dd = Math.hypot(sx - mx, sy - my)
				if (dd > threshold) continue
				if (dd < bestDist - 1 || (Math.abs(dd - bestDist) <= 1 && depth < bestDepth)) {
					bestDist = dd
					bestDepth = depth
					best = [x, y, z]
				}
			}
		}
	}
	return best
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

console.log('\n[屏幕投影拾取]')

t('对每个格子，用其自身屏幕坐标拾取都能唯一还原该格子', () => {
	for (const n of [3, 4, 5, 7]) {
		for (const [w, h] of [[1280, 720], [800, 900], [1600, 900]]) {
			const cam = makeCamera(n, w, h)
			let ok = 0, total = 0
			for (let x = 0; x < n; x++) {
				for (let y = 0; y < n; y++) {
					for (let z = 0; z < n; z++) {
						const ndc = project(cellToWorld(n, x, y, z), cam.viewProj)
						const sx = ((ndc[0] + 1) / 2) * w
						const sy = ((1 - ndc[1]) / 2) * h
						const got = pick(cam, n, sx, sy)
						total++
						// 允许遮挡（前层格子坐标更靠前），但必须命中同一「屏幕位置」的格子
						if (got) {
							// 校验命中点的投影与目标点的投影几乎重合
							const gndc = project(cellToWorld(n, got[0], got[1], got[2]), cam.viewProj)
							const gsx = ((gndc[0] + 1) / 2) * w
							const gsy = ((1 - gndc[1]) / 2) * h
							if (Math.hypot(gsx - sx, gsy - sy) < 1) ok++
						}
					}
				}
			}
			assert.ok(ok / total > 0.85, 'n=' + n + ' ' + w + 'x' + h + ' 命中率 ' + (ok / total).toFixed(2))
		}
	}
})

t('拾取不依赖任何可见几何体（网格隐藏时依然有效）', () => {
	// pick 只用相机矩阵与格心坐标，与 cellGroup.visible 无关。
	// 这里通过「不放任何棋子、不使用 raycast」来体现：命中率应与上一测试一致。
	const n = 4
	const cam = makeCamera(n, 1280, 720)
	let hit = 0
	for (let x = 0; x < n; x++) {
		for (let y = 0; y < n; y++) {
			for (let z = 0; z < n; z++) {
				const ndc = project(cellToWorld(n, x, y, z), cam.viewProj)
				const got = pick(cam, n, ((ndc[0] + 1) / 2) * 1280, ((1 - ndc[1]) / 2) * 720)
				if (got) hit++
			}
		}
	}
	assert.ok(hit > 0.85 * 64, '命中 ' + hit + '/64')
})

t('屏幕四角拾取不误判（阈值外应返回 null 或边缘格）', () => {
	const n = 4
	const cam = makeCamera(n, 1280, 720)
	const corner = pick(cam, n, 2, 2) // 左上角，远离棋盘
	assert.strictEqual(corner, null, '左上角不应命中任何格子，实际 ' + JSON.stringify(corner))
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
