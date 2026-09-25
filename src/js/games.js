(function () {
	'use strict';

	var ANIM = 320;

	function toArray (nodes) {
		var out = [];
		for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
		return out;
	}

	/* ---------------- 游戏导航：分类筛选 + 检索 ---------------- */
	function initNav () {
		var list = document.getElementById('games-list');
		if (!list) return;

		var items = toArray(list.getElementsByTagName('li')).filter(function (li) {
			return li.className.indexOf('games-item') >= 0;
		});
		var input = document.getElementById('games-search');
		var chips = toArray(document.querySelectorAll('.games-chip'));
		var count = document.getElementById('games-count');
		var empty = document.getElementById('games-empty');
		var state = { q: '', category: '' };
		var initialised = false;
		var settled = false;

		// 入场动画带 fill-mode: both，会覆盖 .is-hidden 的 opacity。
		// 动画结束后挂 .is-settled 关掉动画，筛选才由过渡接管。
		function settle () {
			if (settled) return;
			settled = true;
			list.classList.add('is-settled');
		}

		function norm (value) {
			return String(value == null ? '' : value).toLowerCase();
		}

		function matches (item) {
			if (state.category) {
				var category = norm(item.getAttribute('data-category'));
				if (category !== norm(state.category)) return false;
			}
			if (!state.q) return true;
			var q = norm(state.q);
			return (
				norm(item.getAttribute('data-title')).indexOf(q) >= 0 ||
				norm(item.getAttribute('data-summary')).indexOf(q) >= 0 ||
				norm(item.getAttribute('data-tags')).indexOf(q) >= 0 ||
				norm(item.getAttribute('data-category')).indexOf(q) >= 0
			);
		}

		function apply () {
			if (initialised || state.category || state.q) settle();

			var shown = 0;
			for (var i = 0; i < items.length; i++) {
				var ok = matches(items[i]);
				items[i].classList.toggle('is-hidden', !ok);
				if (ok) shown++;
			}

			if (count) {
				count.textContent = shown ? '共 ' + shown + ' 款' : '';
				count.classList.toggle('is-shown', shown > 0);
			}
			if (empty) empty.classList.toggle('is-visible', shown === 0);

			for (var j = 0; j < chips.length; j++) {
				var active =
					norm(chips[j].getAttribute('data-category')) === norm(state.category);
				chips[j].classList.toggle('is-active', active);
			}

			syncHash();
		}

		function syncHash () {
			if (!window.history || !window.history.replaceState) return;
			var parts = [];
			if (state.category) parts.push('cat=' + encodeURIComponent(state.category));
			if (state.q) parts.push('q=' + encodeURIComponent(state.q));
			var hash = parts.length ? '#' + parts.join('&') : '';
			window.history.replaceState(
				null,
				'',
				window.location.pathname + window.location.search + hash
			);
		}

		function readHash () {
			state.category = '';
			state.q = '';
			var raw = window.location.hash.replace(/^#/, '');
			if (!raw) return;
			var parts = raw.split('&');
			for (var i = 0; i < parts.length; i++) {
				var kv = parts[i].split('=');
				var key = kv[0];
				var value = kv.slice(1).join('=');
				try {
					value = decodeURIComponent(value);
				} catch (err) {
					/* keep raw value */
				}
				if (key === 'cat') state.category = value;
				if (key === 'q') state.q = value;
			}
		}

		if (input) {
			input.addEventListener('input', function () {
				state.q = input.value.trim();
				apply();
			});
			input.addEventListener('keydown', function (event) {
				if (event.key === 'Escape' || event.keyCode === 27) {
					input.value = '';
					state.q = '';
					apply();
				}
			});
		}

		chips.forEach(function (chip) {
			chip.addEventListener('click', function () {
				var name = chip.getAttribute('data-category') || '';
				state.category = state.category === name ? '' : name;
				apply();
			});
		});

		window.addEventListener('hashchange', function () {
			readHash();
			if (input) input.value = state.q;
			apply();
		});

		readHash();
		if (input) input.value = state.q;
		apply();
		initialised = true;

		// 入场动画结束后释放筛选过渡
		setTimeout(settle, ANIM + 900);
	}

	initNav();
})();
