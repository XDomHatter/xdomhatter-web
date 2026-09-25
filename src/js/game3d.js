/**
 * 三维连珠 · 客户端。
 *
 * 职责划分：
 *   - 网络层只管收发与重连，不做任何裁决（规则以服务端为准）。
 *   - 渲染层用 three.js 把 N³ 格子画在屏幕正中央，支持拖拽旋转、滚轮缩放、点击拾取。
 *   - 交互层把点击换算成 (x,y,z) 发给服务端。
 *
 * 依赖：three.js（CDN 全局 THREE）、页面内联的 Gomoku3DRules。
 */
(function () {
	'use strict';

	var WS_PATH = '/ws/gomoku3d';
	var COLOR_P1 = 0xff6b6b; // 与 game3d.less 的 @p1 对应
	var COLOR_P2 = 0x4fc3f7;
	var COLOR_GRID = 0xffffff;
	var CELL_GAP = 0.12; // 棋子相对格宽的内缩，便于看清格线

	function $(sel) {
		return document.querySelector(sel);
	}

	/* ==================================================================
	 * 网络层
	 * ================================================================== */
	function Net() {
		this.ws = null;
		this.handlers = {};
		this.token = null;
		this.room = null;
		this.connected = false;
		this.queue = [];
	}

	Net.prototype.on = function (type, fn) {
		if (!this.handlers[type]) this.handlers[type] = [];
		this.handlers[type].push(fn);
	};

	Net.prototype.emit = function (type, payload) {
		var list = this.handlers[type] || [];
		for (var i = 0; i < list.length; i++) {
			try {
				list[i](payload);
			} catch (e) {
				console.error('[gomoku3d] handler error', type, e);
			}
		}
	};

	Net.prototype.connect = function () {
		if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
			return Promise.resolve();
		}
		var self = this;
		return new Promise(function (resolve, reject) {
			var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
			var ws;
			try {
				ws = new WebSocket(proto + '//' + location.host + WS_PATH);
			} catch (e) {
				return reject(e);
			}
			self.ws = ws;

			var settled = false;
			ws.onopen = function () {
				self.connected = true;
				// 补发断线期间积压的指令
				var q = self.queue.splice(0);
				q.forEach(function (m) {
					try {
						ws.send(JSON.stringify(m));
					} catch (e) {
						/* ignore */
					}
				});
				if (!settled) {
					settled = true;
					resolve();
				}
				self.emit('open');
			};
			ws.onmessage = function (ev) {
				var msg;
				try {
					msg = JSON.parse(ev.data);
				} catch (e) {
					return;
				}
				if (msg && msg.type) self.emit(msg.type, msg);
			};
			ws.onclose = function () {
				self.connected = false;
				self.emit('close');
			};
			ws.onerror = function () {
				if (!settled) {
					settled = true;
					reject(new Error('无法连接服务器'));
				}
			};
		});
	};

	Net.prototype.send = function (obj, forceQueue) {
		if (this.ws && this.ws.readyState === 1) {
			this.ws.send(JSON.stringify(obj));
		} else if (forceQueue !== false) {
			this.queue.push(obj);
		}
	};

	Net.prototype.close = function () {
		if (this.ws) {
			try {
				this.ws.close();
			} catch (e) {
				/* ignore */
			}
			this.ws = null;
		}
		this.connected = false;
	};

	/* ==================================================================
	 * 渲染层：三维棋盘
	 * ================================================================== */
	function Board3D(canvas) {
		this.canvas = canvas;
		this.scene = null;
		this.camera = null;
		this.renderer = null;
		this.cellGroup = null; // 格线
		this.stoneGroup = null; // 棋子
		this.highlightGroup = null; // 获胜连线
		this.ghost = null; // 悬停预览
		this.n = 4;
		this.cellSize = 1;
		this.gap = CELL_GAP;
		this.showGrid = true;
		this.stones = {}; // "x,y,z" -> mesh
		this.raycaster = null;
		this.pointer = { x: 0, y: 0, clientX: 0, clientY: 0, inside: false };
		this.sphere = null; // 旋转用包围球
		this.onPick = null; // 点击回调 (x,y,z)
		this.enabled = false;
		this.animId = null;
		this._drag = null;
		this._bind();
	}

	Board3D.prototype._bind = function () {
		var self = this;

		this.canvas.addEventListener('pointerdown', function (e) {
			if (!self.renderer) return;
			self._drag = { x: e.clientX, y: e.clientY, moved: false, t: Date.now() };
			try {
				self.canvas.setPointerCapture(e.pointerId);
			} catch (err) {
				/* ignore */
			}
		});

		this.canvas.addEventListener('pointermove', function (e) {
			self._updatePointer(e);
			if (self._drag && self.renderer) {
				var dx = e.clientX - self._drag.x;
				var dy = e.clientY - self._drag.y;
				if (Math.abs(dx) > 3 || Math.abs(dy) > 3) self._drag.moved = true;
				if (self._drag.moved) {
					self._rotate(dx, dy);
					self._drag.x = e.clientX;
					self._drag.y = e.clientY;
				}
			}
			self._updateGhost();
		});

		function endDrag(e) {
			if (!self._drag) return;
			var wasClick = !self._drag.moved && Date.now() - self._drag.t < 600;
			self._drag = null;
			try {
				self.canvas.releasePointerCapture(e.pointerId);
			} catch (err) {
				/* ignore */
			}
			if (wasClick) self._handleClick();
		}
		this.canvas.addEventListener('pointerup', endDrag);
		this.canvas.addEventListener('pointercancel', function () {
			self._drag = null;
		});

		this.canvas.addEventListener('pointerleave', function () {
			self.pointer.inside = false;
			self._hideGhost();
		});

		this.canvas.addEventListener(
			'wheel',
			function (e) {
				if (!self.camera) return;
				e.preventDefault();
				var factor = e.deltaY > 0 ? 1.08 : 0.925;
				var next = self.camera.position.length() * factor;
				var min = self.n * 1.1;
				var max = self.n * 6.5;
				if (next < min) next = min;
				if (next > max) next = max;
				self.camera.position.setLength(next);
				self.camera.lookAt(0, 0, 0);
			},
			{ passive: false }
		);
	};

	Board3D.prototype._updatePointer = function (e) {
		var rect = this.canvas.getBoundingClientRect();
		this.pointer.clientX = e.clientX;
		this.pointer.clientY = e.clientY;
		this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
		this.pointer.inside =
			e.clientX >= rect.left &&
			e.clientX <= rect.right &&
			e.clientY >= rect.top &&
			e.clientY <= rect.bottom;
	};

	Board3D.prototype._rotate = function (dx, dy) {
		if (!this.camera) return;
		// 用球坐标旋转：避免万向锁，并保持始终看向原点
		var pos = this.camera.position;
		var radius = pos.length();
		var theta = Math.atan2(pos.x, pos.z);
		var phi = Math.acos(Math.max(-1, Math.min(1, pos.y / radius)));

		theta -= dx * 0.007;
		phi -= dy * 0.007;
		phi = Math.max(0.12, Math.min(Math.PI - 0.12, phi));

		pos.set(
			radius * Math.sin(phi) * Math.sin(theta),
			radius * Math.cos(phi),
			radius * Math.sin(phi) * Math.cos(theta)
		);
		this.camera.lookAt(0, 0, 0);
	};

	/** 由格子坐标算出世界坐标（棋盘居中于原点） */
	Board3D.prototype.cellToWorld = function (x, y, z) {
		var n = this.n;
		var s = this.cellSize;
		var off = ((n - 1) * s) / 2;
		return [x * s - off, y * s - off, z * s - off];
	};

	/** 世界坐标反推格子坐标（用于拾取兜底） */
	Board3D.prototype.worldToCell = function (p) {
		var n = this.n;
		var s = this.cellSize;
		var off = ((n - 1) * s) / 2;
		var x = Math.round((p.x + off) / s);
		var y = Math.round((p.y + off) / s);
		var z = Math.round((p.z + off) / s);
		if (x < 0 || x >= n || y < 0 || y >= n || z < 0 || z >= n) return null;
		return [x, y, z];
	};

	Board3D.prototype.init = function (n) {
		this.n = n;
		var THREE = window.THREE;
		if (!THREE) {
			console.error('[gomoku3d] three.js 未加载');
			return false;
		}

		if (!this.renderer) {
			this.renderer = new THREE.WebGLRenderer({
				canvas: this.canvas,
				antialias: true,
				alpha: true
			});
			this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
			this.scene = new THREE.Scene();
		}

		// 相机：等轴测方向看向原点，保证棋盘落在画面正中
		this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
		var d = n * 2.0;
		this.camera.position.set(d * 0.62, d * 0.62, d * 0.72);
		this.camera.lookAt(0, 0, 0);

		this._buildLights();
		this._buildBoard();
		this._resize();
		this._loop();
		return true;
	};

	Board3D.prototype._buildLights = function () {
		var THREE = window.THREE;
		if (this._lit) return;
		var ambient = new THREE.AmbientLight(0xffffff, 0.72);
		var key = new THREE.DirectionalLight(0xffffff, 0.85);
		key.position.set(6, 10, 8);
		var fill = new THREE.DirectionalLight(0x8f9bff, 0.4);
		fill.position.set(-8, -4, -6);
		this.scene.add(ambient, key, fill);
		this._lit = true;
	};

	Board3D.prototype._buildBoard = function () {
		var THREE = window.THREE;
		var self = this;
		var n = this.n;

		if (this.cellGroup) this.scene.remove(this.cellGroup);
		if (this.stoneGroup) this.scene.remove(this.stoneGroup);
		if (this.highlightGroup) this.scene.remove(this.highlightGroup);

		this.cellGroup = new THREE.Group();
		this.stoneGroup = new THREE.Group();
		this.highlightGroup = new THREE.Group();
		this.stones = {};

		// ---- 格线（线框立方网格）----
		var half = (n - 1) / 2;
		var lo = -half - 0.5;
		var hi = half + 0.5;
		var geo = new THREE.BufferGeometry();
		var verts = [];

		// 沿三个轴向各画 n+1 条线，构成 n³ 格
		for (var i = 0; i <= n; i++) {
			var p = lo + i;
			// 沿 X 的线（在 y-z 平面上铺开）
			for (var j = 0; j <= n; j++) {
				var q = lo + j;
				verts.push(lo, p, q, hi, p, q);
				verts.push(p, lo, q, p, hi, q);
				verts.push(p, q, lo, p, q, hi);
			}
		}
		geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
		var mat = new THREE.LineBasicMaterial({
			color: COLOR_GRID,
			transparent: true,
			opacity: 0.16
		});
		var lines = new THREE.LineSegments(geo, mat);
		this.cellGroup.add(lines);

		// 外框稍亮，帮助建立立体感
		var boxGeo = new THREE.BoxGeometry(n, n, n);
		var boxEdges = new THREE.EdgesGeometry(boxGeo);
		var boxLine = new THREE.LineSegments(
			boxEdges,
			new THREE.LineBasicMaterial({
				color: COLOR_GRID,
				transparent: true,
				opacity: 0.3
			})
		);
		this.cellGroup.add(boxLine);
		this.cellGroup.visible = this.showGrid;

		this.scene.add(this.cellGroup);
		this.scene.add(this.stoneGroup);
		this.scene.add(this.highlightGroup);

		// 复用几何体：棋子是球体，半径略小于半格
		this._stoneGeo = this._stoneGeo || new THREE.SphereGeometry(1, 20, 14);
		this._pickGeo = this._pickGeo || new THREE.SphereGeometry(1, 16, 12);

		this.sphere = new THREE.Sphere(Math.max(2, n * 0.9));
		this._syncGrid();
		void self;
	};

	Board3D.prototype._syncGrid = function () {
		if (!this.ghost) {
			var THREE = window.THREE;
			this.ghost = new THREE.Mesh(
				new THREE.SphereGeometry(1, 16, 12),
				new THREE.MeshBasicMaterial({
					color: 0xffffff,
					transparent: true,
					opacity: 0.22
				})
			);
			this.ghost.visible = false;
			this._ghostReady = true;
			this.scene.add(this.ghost);
			void THREE;
		}
	};

	Board3D.prototype.setGridVisible = function (visible) {
		this.showGrid = !!visible;
		if (this.cellGroup) this.cellGroup.visible = this.showGrid;
	};

	/** 全量刷新棋子（服务端每次广播都带完整棋盘，避免增量不同步） */
	Board3D.prototype.sync = function (state) {
		var THREE = window.THREE;
		var self = this;
		var n = state.n;
		if (n !== this.n) {
			this.init(n);
			this._reapplyGrid();
		}
		this.n = n;

		var board = state.board || [];
		var seen = {};

		for (var i = 0; i < board.length; i++) {
			var p = board[i];
			if (!p) continue;
			var c = window.Gomoku3DRules.coordOf(n, i);
			var key = c[0] + ',' + c[1] + ',' + c[2];
			seen[key] = true;
			if (!this.stones[key]) {
				this._addStone(c[0], c[1], c[2], p);
			} else if (this.stones[key].userData.player !== p) {
				this.stones[key].material.color.setHex(
					p === 1 ? COLOR_P1 : COLOR_P2
				);
				this.stones[key].userData.player = p;
			}
		}

		// 移除已被清掉的棋子（重开时）
		Object.keys(this.stones).forEach(function (key) {
			if (!seen[key]) {
				var m = self.stones[key];
				self.stoneGroup.remove(m);
				delete self.stones[key];
			}
		});

		this.syncHighlight(state);
	};

	Board3D.prototype._addStone = function (x, y, z, player, animateFrom) {
		var THREE = window.THREE;
		var w = this.cellToWorld(x, y, z);
		var radius = (this.cellSize / 2) * (1 - this.gap);

		var mat = new THREE.MeshStandardMaterial({
			color: player === 1 ? COLOR_P1 : COLOR_P2,
			metalness: 0.25,
			roughness: 0.35,
			emissive: player === 1 ? 0x3a0d0d : 0x0a2b3a,
			emissiveIntensity: 0.55
		});
		var mesh = new THREE.Mesh(this._stoneGeo, mat);
		mesh.scale.setScalar(radius);
		mesh.position.set(w[0], w[1], w[2]);
		mesh.userData = { player: player, cell: [x, y, z] };

		// 落子动画：从上方略大处落下
		if (animateFrom) {
			mesh.position.y += this.cellSize * 1.6;
			mesh.scale.setScalar(radius * 1.5);
			mesh.userData.t0 = performance.now();
			mesh.userData.from = mesh.position.y;
			mesh.userData.to = w[1];
			mesh.userData.radius = radius;
			this._animating = this._animating || [];
			this._animating.push(mesh);
		}

		this.stoneGroup.add(mesh);
		this.stones[x + ',' + y + ',' + z] = mesh;
		return mesh;
	};

	/** 获胜连线高亮 */
	Board3D.prototype.syncHighlight = function (state) {
		var THREE = window.THREE;
		if (!this.highlightGroup) return;
		while (this.highlightGroup.children.length) {
			this.highlightGroup.remove(this.highlightGroup.children[0]);
		}
		var cells = state.winCells || [];
		if (!cells.length) return;

		var self = this;
		cells.forEach(function (c) {
			var key = c[0] + ',' + c[1] + ',' + c[2];
			var stone = self.stones[key];
			if (stone) {
				var halo = new THREE.Mesh(
					new THREE.SphereGeometry(1, 16, 12),
					new THREE.MeshBasicMaterial({
						color: 0xffffff,
						transparent: true,
						opacity: 0.32
					})
				);
				halo.scale.setScalar(stone.scale.x * 1.5);
				halo.position.copy(stone.position);
				self.highlightGroup.add(halo);
			}
		});

		// 连线的中轴线段
		var a = this.cellToWorld(cells[0][0], cells[0][1], cells[0][2]);
		var b = this.cellToWorld(
			cells[cells.length - 1][0],
			cells[cells.length - 1][1],
			cells[cells.length - 1][2]
		);
		var geo = new THREE.BufferGeometry();
		geo.setAttribute(
			'position',
			new THREE.Float32BufferAttribute([a[0], a[1], a[2], b[0], b[1], b[2]], 3)
		);
		var line = new THREE.Line(
			geo,
			new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
		);
		this.highlightGroup.add(line);
	};

	/** 悬停时在目标格显示半透明预览 */
	Board3D.prototype._updateGhost = function () {
		if (!this.ghost || !this.enabled || !this.pointer.inside) {
			this._hideGhost();
			return;
		}
		var cell = this.pick();
		if (!cell) {
			this._hideGhost();
			return;
		}
		var key = cell[0] + ',' + cell[1] + ',' + cell[2];
		// 已有子的格子不预览
		if (this.stones[key]) {
			this._hideGhost();
			return;
		}
		var w = this.cellToWorld(cell[0], cell[1], cell[2]);
		var radius = (this.cellSize / 2) * (1 - this.gap);
		this.ghost.position.set(w[0], w[1], w[2]);
		this.ghost.scale.setScalar(radius * 1.05);
		this.ghost.visible = true;
		this._ghostCell = cell;
	};

	Board3D.prototype._hideGhost = function () {
		if (this.ghost) this.ghost.visible = false;
		this._ghostCell = null;
	};

	/**
	 * 拾取：优先命中已有棋子的包围球球心；否则用「射线与格心最近的交点」判定。
	 * 做法是把 n³ 个格心投影到屏幕，取离鼠标最近且在阈值内的那个，
	 * 这样即使网格隐藏（无可见几何体）也能正常拾取。
	 */
	Board3D.prototype.pick = function () {
		if (!this.camera || !this.renderer) return null;
		var n = this.n;
		var rect = this.canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) return null;

		var mx = this.pointer.clientX - rect.left;
		var my = this.pointer.clientY - rect.top;

		var v = new window.THREE.Vector3();
		var best = null;
		var bestDist = Infinity;
		var bestDepth = Infinity;

		// 阈值按格宽在屏幕上的投影估算
		var probe = new window.THREE.Vector3();
		var w0 = this.cellToWorld(0, 0, 0);
		var w1 = this.cellToWorld(1, 0, 0);
		probe.set(w0[0], w0[1], w0[2]);
		probe.project(this.camera);
		var sx0 = ((probe.x + 1) / 2) * rect.width;
		var sy0 = ((1 - probe.y) / 2) * rect.height;
		probe.set(w1[0], w1[1], w1[2]);
		probe.project(this.camera);
		var sx1 = ((probe.x + 1) / 2) * rect.width;
		var sy1 = ((1 - probe.y) / 2) * rect.height;
		var cellPx = Math.sqrt(
			(sx1 - sx0) * (sx1 - sx0) + (sy1 - sy0) * (sy1 - sy0)
		);
		var threshold = Math.max(6, cellPx * 0.62);

		for (var x = 0; x < n; x++) {
			for (var y = 0; y < n; y++) {
				for (var z = 0; z < n; z++) {
					var w = this.cellToWorld(x, y, z);
					v.set(w[0], w[1], w[2]);
					var depth = v.distanceTo(this.camera.position);
					v.project(this.camera);
					if (v.z < -1 || v.z > 1) continue;
					var sx = ((v.x + 1) / 2) * rect.width;
					var sy = ((1 - v.y) / 2) * rect.height;
					var d = Math.sqrt((sx - mx) * (sx - mx) + (sy - my) * (sy - my));
					if (d > threshold) continue;
					// 同分时选离相机更近的（前层优先，符合直觉）
					if (d < bestDist - 1 || (Math.abs(d - bestDist) <= 1 && depth < bestDepth)) {
						bestDist = d;
						bestDepth = depth;
						best = [x, y, z];
					}
				}
			}
		}
		return best;
	};

	Board3D.prototype._handleClick = function () {
		if (!this.enabled || !this.onPick) return;
		var cell = this._ghostCell || this.pick();
		if (!cell) return;
		var key = cell[0] + ',' + cell[1] + ',' + cell[2];
		if (this.stones[key]) return; // 已占用
		this.onPick(cell[0], cell[1], cell[2]);
	};

	Board3D.prototype._reapplyGrid = function () {
		if (this.cellGroup) this.cellGroup.visible = this.showGrid;
		if (this._lastState) this.sync(this._lastState);
	};

	Board3D.prototype.resize = function () {
		this._resize();
	};

	Board3D.prototype._resize = function () {
		if (!this.renderer) return;
		var rect = this.canvas.getBoundingClientRect();
		var w = Math.max(1, Math.floor(rect.width));
		var h = Math.max(1, Math.floor(rect.height));
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	};

	Board3D.prototype._loop = function () {
		var self = this;
		if (this.animId) cancelAnimationFrame(this.animId);

		function frame() {
			self.animId = requestAnimationFrame(frame);
			self._tickAnimations();
			if (self.ghost && self.ghost.visible) {
				var t = performance.now() * 0.0035;
				self.ghost.material.opacity = 0.16 + Math.sin(t) * 0.07;
				self.ghost.rotation.y += 0.01;
			}
			if (self.highlightGroup) {
				self.highlightGroup.children.forEach(function (c) {
					if (c.material && c.material.opacity !== undefined) {
						c.material.opacity =
							c.type === 'Line' ? 0.85 : 0.24 + Math.sin(performance.now() * 0.005) * 0.14;
					}
				});
			}
			if (self.renderer && self.scene && self.camera) {
				self.renderer.render(self.scene, self.camera);
			}
		}
		frame();
	};

	Board3D.prototype._tickAnimations = function () {
		if (!this._animating || !this._animating.length) return;
		var now = performance.now();
		var keep = [];
		for (var i = 0; i < this._animating.length; i++) {
			var m = this._animating[i];
			var t = Math.min(1, (now - m.userData.t0) / 260);
			var e = 1 - Math.pow(1 - t, 3); // easeOutCubic
			m.position.y = m.userData.from + (m.userData.to - m.userData.from) * e;
			m.scale.setScalar(m.userData.radius * (1 + (1.5 - 1) * (1 - e) * 0.6));
			if (t < 1) keep.push(m);
			else {
				m.position.y = m.userData.to;
				m.scale.setScalar(m.userData.radius);
			}
		}
		this._animating = keep;
	};

	Board3D.prototype.resetView = function () {
		if (!this.camera) return;
		var d = this.n * 2.0;
		this.camera.position.set(d * 0.62, d * 0.62, d * 0.72);
		this.camera.lookAt(0, 0, 0);
	};

	Board3D.prototype.setEnabled = function (on) {
		this.enabled = !!on;
		if (!this.enabled) this._hideGhost();
	};

	/* ==================================================================
	 * 页面装配
	 * ================================================================== */
	function App() {
		this.net = new Net();
		this.board = null;
		this.state = null;
		this.myPlayer = 0;
		this.room = null;
		this.n = 4;
		this.m = 4;
		this.timerId = null;
		this.lobbyMsg = null;
		this.arenaMsg = null;
	}

	App.prototype.msg = function (text, kind) {
		var el = this.lobbyMsg && !this.lobbyMsg.closest('section').hidden
			? this.lobbyMsg
			: this.arenaMsg;
		if (!el) return;
		// 两个区域都可能可见，优先显示当前所在区域的提示
		var target = this.room ? this.arenaMsg : this.lobbyMsg;
		if (!target) return;
		target.textContent = text || '';
		target.classList.toggle('is-shown', !!text);
		target.classList.toggle('is-info', kind === 'info');
		void el;
	};

	App.prototype.init = function () {
		var self = this;
		this.lobbyMsg = $('#lobby-msg');
		this.arenaMsg = $('#arena-msg');

		this.board = new Board3D($('#canvas3d'));
		this.board.onPick = function (x, y, z) {
			self.onPick(x, y, z);
		};

		this.bindLobby();
		this.bindArena();
		this.bindNet();

		window.addEventListener('resize', function () {
			self.board.resize();
		});

		// 从 URL 里带房间号可直接预填，便于分享链接
		var m = location.hash.match(/room=(\d{4})/);
		if (m) {
			$('#join-room').value = m[1];
		}
	};

	App.prototype.bindLobby = function () {
		var self = this;

		var rangeN = $('#opt-n');
		var outN = $('#opt-n-out');
		var rangeM = $('#opt-m');
		var outM = $('#opt-m-out');

		function syncRanges() {
			var n = parseInt(rangeN.value, 10);
			// M 不得超过 N
			rangeM.max = String(n);
			if (parseInt(rangeM.value, 10) > n) rangeM.value = String(n);
			var m = parseInt(rangeM.value, 10);

			outN.textContent = String(n);
			outM.textContent = String(m);
			$('#opt-cells').textContent = String(n * n * n);
			$('#opt-m-hint').textContent =
				'需要连续 ' + m + ' 个同色格子，M 不得超过 N（当前上限 ' + n + '）。';
		}

		rangeN.addEventListener('input', syncRanges);
		rangeM.addEventListener('input', syncRanges);
		syncRanges();

		$('#btn-create').addEventListener('click', function () {
			var n = parseInt(rangeN.value, 10);
			var m = parseInt(rangeM.value, 10);
			var name = $('#opt-name').value.trim();
			self.showGridPref = $('#opt-grid').checked;
			self.create(n, m, name);
		});

		$('#join-room').addEventListener('input', function (e) {
			e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
		});
		$('#join-room').addEventListener('keydown', function (e) {
			if (e.key === 'Enter') $('#btn-join').click();
		});

		$('#btn-join').addEventListener('click', function () {
			var code = $('#join-room').value.trim();
			var name = $('#opt-name').value.trim();
			if (!/^\d{4}$/.test(code)) {
				self.msg('请输入 4 位房间号');
				return;
			}
			self.showGridPref = $('#opt-grid').checked;
			self.join(code, name);
		});
	};

	App.prototype.bindArena = function () {
		var self = this;

		$('#btn-leave').addEventListener('click', function () {
			self.net.send({ type: 'leave' });
			self.backToLobby();
		});

		$('#btn-resign').addEventListener('click', function () {
			if (!self.state || self.state.status !== 'playing') return;
			if (!window.confirm('确定认输？')) return;
			self.net.send({ type: 'resign' });
		});

		$('#btn-again').addEventListener('click', function () {
			self.net.send({ type: 'rematch' });
		});

		$('#btn-exit').addEventListener('click', function () {
			self.backToLobby();
		});

		$('#btn-recenter').addEventListener('click', function () {
			self.board.resetView();
		});

		$('#arena-grid').addEventListener('change', function (e) {
			self.board.setGridVisible(e.target.checked);
		});
	};

	App.prototype.bindNet = function () {
		var self = this;

		this.net.on('created', function (msg) {
			self.room = msg.room;
			self.myPlayer = msg.player;
			self.net.token = msg.token;
			self.enterArena(msg.room, msg.n, msg.m);
			self.msg('');
			location.hash = 'room=' + msg.room;
		});

		this.net.on('joined', function (msg) {
			self.room = msg.room;
			self.myPlayer = msg.player;
			self.net.token = msg.token;
			self.enterArena(msg.room, msg.n, msg.m);
			self.msg('');
			location.hash = 'room=' + msg.room;
			if (msg.reconnect) self.toast('已重新连接到房间');
		});

		this.net.on('state', function (msg) {
			self.applyState(msg);
		});

		this.net.on('error', function (msg) {
			self.msg(msg.message || '出错了');
			self.toast(msg.message || '出错了');
		});

		this.net.on('kicked', function (msg) {
			self.toast(msg.message || '连接被接管');
		});

		this.net.on('close', function () {
			if (self.room) {
				self.toast('连接已断开，正在尝试重连…');
				// 自动重连：服务端按 token 恢复座位
				setTimeout(function () {
					if (!self.room) return;
					self.net
						.connect()
						.then(function () {
							self.net.send({
								type: 'join',
								room: self.room,
								token: self.net.token
							});
						})
						.catch(function () {
							setTimeout(function () {
								self.backToLobby();
								self.msg('重连失败，请重新加入房间');
							}, 3000);
						});
				}, 1200);
			}
		});
	};

	App.prototype.toast = function (text) {
		// 复用消息条，但显示在竞技区，避免与大厅提示抢位
		if (!this.arenaMsg) return;
		this.arenaMsg.textContent = text;
		this.arenaMsg.classList.add('is-shown', 'is-info');
	};

	App.prototype.create = function (n, m, name) {
		var self = this;
		this.msg('');
		this.net
			.connect()
			.then(function () {
				self.net.send({ type: 'create', n: n, m: m, name: name });
			})
			.catch(function (e) {
				self.msg(e.message || '无法连接服务器');
			});
	};

	App.prototype.join = function (code, name) {
		var self = this;
		this.msg('');
		this.net
			.connect()
			.then(function () {
				self.net.send({ type: 'join', room: code, name: name });
			})
			.catch(function (e) {
				self.msg(e.message || '无法连接服务器');
			});
	};

	App.prototype.enterArena = function (room, n, m) {
		this.n = n;
		this.m = m;
		$('#lobby').hidden = true;
		$('#arena').hidden = false;
		$('#hud-room').textContent = '房间 ' + room;
		$('#hud-config').textContent = n + '³ 棋盘 · ' + m + ' 连';

		var showGrid = this.showGridPref !== false;
		$('#arena-grid').checked = showGrid;
		this.board.setGridVisible(showGrid);

		this.board.init(n);
		this.board.resetView();
		this.board.setEnabled(false); // 开局前不可落子
		this.applyState({ n: n, m: m, board: [], status: 'waiting', turn: 1 });
	};

	App.prototype.backToLobby = function () {
		this.net.close();
		this.room = null;
		this.state = null;
		this.myPlayer = 0;
		$('#arena').hidden = true;
		$('#lobby').hidden = false;
		$('#overlay').hidden = true;
		if (location.hash) location.hash = '';
		this.msg('', 'info');
	};

	App.prototype.applyState = function (s) {
		this.state = s;
		var board = this.board;
		board._lastState = s;

		if (s.n && s.n !== board.n) board.init(s.n);
		board.sync(s);

		// 提示条：有过操作后淡出
		if (s.moveCount > 0) $('#stage-tip').classList.add('is-hidden');

		var playing = s.status === 'playing';
		var myTurn = playing && s.turn === this.myPlayer;
		board.setEnabled(myTurn);

		this.updateHud(s);
		this.updateOverlay(s);
		this.updateTimer(s);
	};

	App.prototype.updateHud = function (s) {
		var turnEl = $('.game3d-turn');
		var text = $('#hud-turn');
		var timer = $('#hud-timer');
		turnEl.classList.remove('is-p1', 'is-p2');

		if (s.status === 'waiting') {
			text.textContent = '等待对手加入…';
			timer.textContent = '';
			return;
		}
		if (s.status === 'finished') {
			if (s.winner === 3) text.textContent = '平局';
			else if (s.winner === this.myPlayer) text.textContent = '你赢了';
			else text.textContent = '你输了';
			timer.textContent = '';
			return;
		}

		turnEl.classList.add(s.turn === 1 ? 'is-p1' : 'is-p2');
		var who = s.turn === 1 ? '玩家 1' : '玩家 2';
		text.textContent = s.turn === this.myPlayer ? '轮到你（' + who + '）' : '等待对方（' + who + '）';
	};

	App.prototype.updateOverlay = function (s) {
		var overlay = $('#overlay');
		if (s.status !== 'finished') {
			overlay.hidden = true;
			return;
		}
		overlay.hidden = false;

		var title = $('#overlay-title');
		var desc = $('#overlay-desc');
		var reasonText = {
			line: '连成 ' + s.m + ' 子',
			resign: '对方认输',
			timeout: '对方超时',
			disconnect: '对方掉线',
			leave: '对方离开',
			draw: '棋盘已满'
		};

		if (s.winner === 3) {
			title.textContent = '平局';
			desc.textContent = '棋盘已下满，无人连成 ' + s.m + ' 子。';
		} else if (s.winner === this.myPlayer) {
			title.textContent = '你赢了';
			desc.textContent = '玩家 ' + s.winner + ' 获胜 · ' + (reasonText[s.reason] || '');
		} else {
			title.textContent = '你输了';
			desc.textContent = '玩家 ' + s.winner + ' 获胜 · ' + (reasonText[s.reason] || '');
		}
	};

	App.prototype.updateTimer = function (s) {
		var el = $('#hud-timer');
		if (!el) return;
		if (this.timerId) {
			clearInterval(this.timerId);
			this.timerId = null;
		}
		if (s.status !== 'playing' || !s.turnRemainMs) {
			if (s.status === 'playing' && s.graceRemainMs > 0) {
				el.textContent = '对方掉线 ' + Math.ceil(s.graceRemainMs / 1000) + 's';
			}
			return;
		}
		var base = s.turnRemainMs;
		var t0 = Date.now();
		function tick() {
			var left = Math.max(0, base - (Date.now() - t0));
			el.textContent = Math.ceil(left / 1000) + 's';
			if (left <= 0 && this.timerId) {
				clearInterval(this.timerId);
				this.timerId = null;
			}
		}
		tick();
		var self = this;
		this.timerId = setInterval(tick, 250);
		void self;
	};

	App.prototype.onPick = function (x, y, z) {
		var s = this.state;
		if (!s || s.status !== 'playing') return;
		if (s.turn !== this.myPlayer) {
			this.toast('还没轮到你');
			return;
		}
		// 乐观本地反馈：先画上半透明子弹，等广播覆盖
		this.net.send({ type: 'move', x: x, y: y, z: z });
	};

	document.addEventListener('DOMContentLoaded', function () {
		var app = new App();
		app.init();
		window.__gomoku3d = app; // 便于调试
	});
})();
