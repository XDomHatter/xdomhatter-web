(function () {
	'use strict';

	var ANIM = 340;

	function toArray (nodes) {
		var out = [];
		for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
		return out;
	}

	function reflow (el) {
		return el.offsetHeight;
	}

	/* ---------------- 列表：错峰入场 + 平滑折叠筛选 ---------------- */
	function initIndex () {
		var list = document.getElementById('blog-list');
		if (!list) return;

		var items = toArray(list.getElementsByTagName('li')).filter(function (li) {
			return li.className.indexOf('blog-item') >= 0;
		});
		var input = document.getElementById('blog-search');
		var chips = toArray(document.querySelectorAll('.blog-tag'));
		var count = document.getElementById('blog-count');
		var empty = document.getElementById('blog-empty');
		var state = { q: '', tag: '' };
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

		function hasTag (item, tag) {
			var tags = ',' + norm(item.getAttribute('data-tags')) + ',';
			return tags.indexOf(',' + norm(tag) + ',') >= 0;
		}

		function matches (item) {
			if (state.tag && !hasTag(item, state.tag)) return false;
			if (!state.q) return true;
			var q = norm(state.q);
			return (
				norm(item.getAttribute('data-title')).indexOf(q) >= 0 ||
				norm(item.getAttribute('data-summary')).indexOf(q) >= 0 ||
				norm(item.getAttribute('data-tags')).indexOf(q) >= 0
			);
		}

		function isHidden (item) {
			return (
				item.style.display === 'none' || item.classList.contains('is-hidden')
			);
		}

		function schedule (item, hide) {
			if (item.__blogTimer) clearTimeout(item.__blogTimer);
			item.__blogTimer = setTimeout(function () {
				item.classList.remove('is-animating');
				item.style.height = '';
				item.style.paddingTop = '';
				item.style.paddingBottom = '';
				if (hide) {
					item.style.display = 'none';
				} else {
					item.classList.remove('is-hidden');
				}
				item.__blogTimer = null;
			}, ANIM);
		}

		function collapse (item) {
			if (item.__blogTimer) {
				clearTimeout(item.__blogTimer);
				item.__blogTimer = null;
			}
			item.classList.add('is-animating');
			item.style.height = item.offsetHeight + 'px';
			reflow(item);
			item.classList.add('is-hidden');
			item.style.height = '0px';
			item.style.paddingTop = '0px';
			item.style.paddingBottom = '0px';
			schedule(item, true);
		}

		function expand (item) {
			if (item.__blogTimer) {
				clearTimeout(item.__blogTimer);
				item.__blogTimer = null;
			}
			item.classList.add('is-animating');
			item.classList.remove('is-hidden');
			item.style.display = '';
			item.style.height = '';
			item.style.paddingTop = '';
			item.style.paddingBottom = '';
			var target = item.offsetHeight;
			item.style.height = '0px';
			item.style.paddingTop = '0px';
			item.style.paddingBottom = '0px';
			item.classList.add('is-hidden');
			reflow(item);
			item.classList.remove('is-hidden');
			item.style.height = target + 'px';
			item.style.paddingTop = '';
			item.style.paddingBottom = '';
			schedule(item, false);
		}

		function apply () {
			if (initialised || state.tag || state.q) settle();

			var shown = 0;
			for (var i = 0; i < items.length; i++) {
				var item = items[i];
				var ok = matches(item);
				if (ok && isHidden(item)) expand(item);
				else if (!ok && !isHidden(item)) collapse(item);
				if (ok) shown++;
			}

			if (count) {
				count.textContent = shown ? '共 ' + shown + ' 篇' : '';
				count.classList.toggle('is-shown', shown > 0);
			}
			if (empty) empty.classList.toggle('is-visible', shown === 0);

			for (var j = 0; j < chips.length; j++) {
				var active =
					state.tag && norm(chips[j].getAttribute('data-tag')) === norm(state.tag);
				chips[j].classList.toggle('is-active', !!active);
			}

			syncHash();
		}

		function syncHash () {
			if (!window.history || !window.history.replaceState) return;
			var parts = [];
			if (state.tag) parts.push('tag=' + encodeURIComponent(state.tag));
			if (state.q) parts.push('q=' + encodeURIComponent(state.q));
			var hash = parts.length ? '#' + parts.join('&') : '';
			window.history.replaceState(
				null,
				'',
				window.location.pathname + window.location.search + hash
			);
		}

		function readHash () {
			state.tag = '';
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
				if (key === 'tag') state.tag = value;
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
				var name = chip.getAttribute('data-tag');
				state.tag = state.tag === name ? '' : name;
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

		setTimeout(settle, 1100);
	}

	/* ---------------- 阅读进度条 ---------------- */
	function initProgress () {
		var bar = document.getElementById('blog-progress-bar');
		if (!bar) return;
		var ticking = false;

		function update () {
			var doc = document.documentElement;
			var max = doc.scrollHeight - window.innerHeight;
			var ratio = max > 0 ? (window.pageYOffset || doc.scrollTop || 0) / max : 0;
			if (ratio < 0) ratio = 0;
			if (ratio > 1) ratio = 1;
			bar.style.transform = 'scaleX(' + ratio + ')';
			ticking = false;
		}

		window.addEventListener(
			'scroll',
			function () {
				if (!ticking) {
					ticking = true;
					window.requestAnimationFrame(update);
				}
			},
			{ passive: true }
		);
		window.addEventListener('resize', update);
		update();
	}

	/* ---------------- 目录滚动高亮 ---------------- */
	function initToc () {
		var links = toArray(document.querySelectorAll('.blog-toc a'));
		if (!links.length || !window.IntersectionObserver) return;

		var headings = [];
		links.forEach(function (link) {
			var id = link.getAttribute('href').slice(1);
			var el = document.getElementById(id);
			if (el) headings.push({ el: el, link: link });
		});
		if (!headings.length) return;

		var visible = {};
		var observer = new window.IntersectionObserver(
			function (entries) {
				entries.forEach(function (entry) {
					if (entry.isIntersecting) visible[entry.target.id] = true;
					else delete visible[entry.target.id];
				});
				var activeId = null;
				for (var i = 0; i < headings.length; i++) {
					if (visible[headings[i].el.id]) {
						activeId = headings[i].el.id;
						break;
					}
				}
				headings.forEach(function (item) {
					item.link.classList.toggle('is-active', item.el.id === activeId);
				});
			},
			{ rootMargin: '-84px 0px -65% 0px' }
		);

		headings.forEach(function (item) {
			observer.observe(item.el);
		});
	}

	/* ---------------- 回到顶部 ---------------- */
	function initTop () {
		var btn = document.getElementById('blog-top');
		if (!btn) return;
		var ticking = false;

		function update () {
			var y = window.pageYOffset || document.documentElement.scrollTop || 0;
			btn.classList.toggle('is-visible', y > 400);
			ticking = false;
		}

		window.addEventListener(
			'scroll',
			function () {
				if (!ticking) {
					ticking = true;
					window.requestAnimationFrame(update);
				}
			},
			{ passive: true }
		);

		btn.addEventListener('click', function () {
			try {
				window.scrollTo({ top: 0, behavior: 'smooth' });
			} catch (err) {
				window.scrollTo(0, 0);
			}
		});

		update();
	}

	initIndex();
	initProgress();
	initToc();
	initTop();
})();
