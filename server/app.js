/**
 * 站点服务：主页等静态资源仍从 dist/ 直出，blog 改为请求时渲染 Markdown，
 * 并附带 /admin 后台与一组带鉴权的读写接口。
 *
 * 启动： BLOG_ADMIN_TOKEN=你的令牌 XDHPAGE_PORT=3000 node server/app.js
 */
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const express = require('express')
const matter = require('gray-matter')
const render = require('../lib/render')
const Rules = require('../lib/gomoku3d-rules')
const store = require('./store')
const comments = require('./comments')
const gameServer = require('./gomoku3d')

const ROOT = render.ROOT
const DIST = path.join(ROOT, 'dist')
const config = require(path.join(ROOT, 'config.json'))
const blogConf = config.blog || {}
const SITE_URL = String(blogConf.url || '').replace(/\/+$/, '')
const BLOG_TITLE = blogConf.title || 'Blog'
const BLOG_DESC = blogConf.description || config.head.description || ''

// 评论开关：config.json 的 blog.comments 为 false 时整体下线（模板不渲染评论区）
const COMMENTS_ON = blogConf.comments !== false

const ADMIN_TOKEN = process.env.BLOG_ADMIN_TOKEN || ''
const PORT = Number(process.env.XDHPAGE_PORT || 80)

const app = express()
app.use(express.json({ limit: '4mb' }))

function baseOptions (extra) {
	return Object.assign(
		{
			siteTitle: config.head.title,
			blogTitle: BLOG_TITLE,
			blogDesc: BLOG_DESC,
			tags: [],
			math: false,
			feed: true,
			// 动态模式用目录式 URL：root=/ suffix=''
			root: '/',
			suffix: '',
			cssInline: null,
			jsInline: null
		},
		extra
	)
}

/* ---------------- Timer -----------------*/
app.get('/timer', (req, res) => {
	res.sendFile(path.join(DIST, 'timer.html'));
})

/* ---------------- 游戏模块 ---------------- */

/**
 * 把不带结尾斜杠的路径 301 到带斜杠的规范形式。
 *
 * 原因：游戏列表页里的卡片链接是相对本页解析的（config.json 里写的是 "gomoku3d/"）。
 * 从 /games/ 打开时它解析为 /games/gomoku3d/，正确；但直接从 /games 打开时，
 * 浏览器以 / 为基准解析成 /gomoku3d/，就会 404。
 *
 * 注意：Express 默认关闭 strict routing，/games 与 /games/ 会命中同一个 handler，
 * 因此不能用两个 app.get 分别处理，否则会自我重定向成死循环。
 */
function ensureTrailingSlash (req, res) {
	if (req.path.charAt(req.path.length - 1) === '/') return false
	const qs = req.url.indexOf('?')
	res.redirect(301, req.path + '/' + (qs >= 0 ? req.url.slice(qs) : ''))
	return true
}

app.get(['/games', '/games/'], function (req, res) {
	if (ensureTrailingSlash(req, res)) return

	const catalog = render.buildGamesCatalog((config.games || {}).catalog)
	const gamesConf = config.games || {}
	const title = gamesConf.title || 'Games'

	res.type('html').send(
		render.renderGames({
			root: '/',
			homeHref: '',
			title: title + ' · ' + config.head.title,
			description: gamesConf.description || config.head.description || '',
			gamesTitle: title,
			gamesDesc: gamesConf.description || '',
			gamesBack: gamesConf.back || 'Home',
			gamesListTitle: gamesConf.listTitle || 'Games',
			gamesEmpty: gamesConf.empty || 'No games yet',
			gamesFootnote: gamesConf.footnote || '',
			gamesSearch: gamesConf.search !== false,
			gamesFilters: gamesConf.filters !== false,
			showCount: gamesConf.count !== false,
			categories: catalog.categories,
			games: catalog.list,
			cssInline: null,
			jsInline: null
		})
	)
})

/* ---------------- 三维连珠（联机对局） ---------------- */
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js'

app.get(['/games/gomoku3d', '/games/gomoku3d/'], function (req, res) {
	if (ensureTrailingSlash(req, res)) return

	const gamesConf = config.games || {}
	const title = '三维连珠'
	res.type('html').send(
		render.renderGomoku3D({
			root: '/',
			suffix: '',
			title: title + ' · ' + (gamesConf.title || '') + ' · ' + config.head.title,
			description:
				'N³ 立方棋盘上的 M 子连珠，双方输入 (x, y, z) 坐标落子，13 个方向判定胜负，支持房间号联机。',
			gameTitle: title,
			gameSub: 'N³ 立方棋盘 · 坐标落子 · 13 个方向判定 · 房间号联机',
			axes: Rules.AXES,
			cssInline: null,
			jsInline: null,
			rulesInline: null,
			rulesSrc: 'js/gomoku3d-rules.js',
			extraCss: 'css/game3d.css',
			extraHead: '<script src="' + THREE_URL + '"></script>'
		})
	)
})

/* ---------------- 博客前台 ---------------- */

app.get(['/blog', '/blog/'], function (req, res) {
	const posts = store.publishedPosts()
	const tags = render.buildTagIndex(posts)
	res.type('html').send(
		render.renderIndex(
			baseOptions({
				tags: tags.list,
				posts: posts.map(store.publicMeta),
				tag: null,
				title: BLOG_TITLE + ' · ' + config.head.title,
				description: BLOG_DESC
			})
		)
	)
})

app.get('/blog/tags/:tag', function (req, res, next) {
	const posts = store.publishedPosts()
	const tags = render.buildTagIndex(posts)
	const wanted = String(req.params.tag || '')
	const tagObj = tags.list.find(function (t) {
		return t.slug === wanted || t.name === wanted
	})
	if (!tagObj) return next()

	const filtered = posts
		.filter(function (post) {
			return post.tags.indexOf(tagObj.name) >= 0
		})
		.map(store.publicMeta)

	res.type('html').send(
		render.renderIndex(
			baseOptions({
				tags: tags.list,
				posts: filtered,
				tag: tagObj.name,
				title: '标签：' + tagObj.name + ' · ' + BLOG_TITLE,
				description: BLOG_DESC
			})
		)
	)
})

app.get('/blog/posts/:slug', function (req, res, next) {
	const posts = store.publishedPosts()
	const found = posts.find(function (post) {
		return post.slug === req.params.slug
	})
	if (!found) return next()

	const tags = render.buildTagIndex(posts)
	const post = Object.assign({}, found, {
		tagObjs: found.tags.map(function (name) {
			return tags.map[name]
		})
	})

	res.type('html').send(
		render.renderPost(
			baseOptions({
				tags: tags.list,
				math: true,
				post: post,
				// 评论服务端渲染：首屏即有内容，不依赖 JS 也能读到；
				// submitUrl 为空表示静态产物，前端提交时会给出明确提示。
				commentsOn: COMMENTS_ON,
				comments: COMMENTS_ON
					? comments.listBySlug(post.slug).map(comments.publicComment)
					: [],
				commentCount: COMMENTS_ON ? comments.listBySlug(post.slug).length : 0,
				submitUrl: '/api/comments/' + encodeURIComponent(post.slug),
				title: post.title + ' · ' + BLOG_TITLE,
				description: post.summary
			})
		)
	)
})

app.get('/blog/posts.json', function (req, res) {
	res.json({
		site: SITE_URL,
		updated: new Date().toISOString(),
		posts: store.publishedPosts().map(store.publicMeta)
	})
})

app.get('/blog/feed.xml', function (req, res) {
	res
		.type('application/xml')
		.send(
			render.buildFeed(store.publishedPosts().map(store.publicMeta), {
				siteUrl: SITE_URL,
				title: BLOG_TITLE,
				description: BLOG_DESC
			})
		)
})

/* ---------------- 管理后台 ---------------- */

app.get(['/admin', '/admin/'], function (req, res) {
	res.sendFile(path.join(__dirname, 'admin.html'))
})

function tokenMatches (provided) {
	if (!ADMIN_TOKEN || typeof provided !== 'string') return false
	const a = Buffer.from(provided)
	const b = Buffer.from(ADMIN_TOKEN)
	if (a.length !== b.length) return false
	try {
		return crypto.timingSafeEqual(a, b)
	} catch (err) {
		return false
	}
}

function requireToken (req, res, next) {
	if (!ADMIN_TOKEN) {
		return res.status(503).json({ error: '服务端未设置 BLOG_ADMIN_TOKEN' })
	}
	if (!tokenMatches(req.get('x-admin-token'))) {
		return res.status(401).json({ error: '未授权' })
	}
	next()
}

function fail (res, err) {
	res.status(err.status || 500).json({ error: err.message || '内部错误' })
}

function withBody (post) {
	return Object.assign(store.adminMeta(post), {
		body: matter(post.raw).content
	})
}

app.get('/api/posts', requireToken, function (req, res) {
	res.json({ posts: store.allPosts().map(store.adminMeta) })
})

app.get('/api/posts/:slug', requireToken, function (req, res) {
	const post = store.findBySlug(req.params.slug)
	if (!post) return res.status(404).json({ error: '文章不存在' })
	res.json(withBody(post))
})

app.post('/api/posts', requireToken, function (req, res) {
	try {
		res.status(201).json({ post: store.adminMeta(store.createPost(req.body || {})) })
	} catch (err) {
		fail(res, err)
	}
})

app.put('/api/posts/:slug', requireToken, function (req, res) {
	try {
		res.json({
			post: store.adminMeta(store.updatePost(req.params.slug, req.body || {}))
		})
	} catch (err) {
		fail(res, err)
	}
})

app.delete('/api/posts/:slug', requireToken, function (req, res) {
	try {
		res.json({ ok: true, post: store.adminMeta(store.deletePost(req.params.slug)) })
	} catch (err) {
		fail(res, err)
	}
})

app.post('/api/preview', requireToken, function (req, res) {
	res.json({ html: store.renderPreview((req.body || {}).content) })
})

/* ---------------- 评论接口 ---------------- */

function clientIp (req) {
	// 反代场景下取第一个 X-Forwarded-For 条目；本地直连则用 socket 地址。
	const forwarded = req.get('x-forwarded-for')
	if (forwarded) return forwarded.split(',')[0].trim()
	return (req.socket && (req.socket.remoteAddress || '')) || ''
}

/** 公开读：只返回已通过审核的评论，不含邮箱与 IP */
app.get('/api/comments/:slug', function (req, res) {
	if (!COMMENTS_ON) return res.json({ comments: [], count: 0 })
	const list = comments.listBySlug(req.params.slug)
	res.json({
		comments: list.map(comments.publicComment),
		count: list.length
	})
})

/** 公开写：无需令牌，带节流与字段校验 */
app.post('/api/comments/:slug', function (req, res) {
	if (!COMMENTS_ON) {
		return res.status(403).json({ error: '评论功能已关闭' })
	}
	try {
		const created = comments.addComment(req.params.slug, req.body || {}, {
			ip: clientIp(req)
		})
		// 先审后发时不能直接把内容回给前端（否则等于绕过审核）
		const visible = created.approved !== false
		res.status(201).json({
			ok: true,
			pending: !visible,
			comment: visible ? comments.publicComment(created) : null,
			message: visible ? '评论已发布' : '评论已提交，等待审核'
		})
	} catch (err) {
		fail(res, err)
	}
})

/* ---------------- 评论管理（复用令牌） ---------------- */

app.get('/api/admin/comments', requireToken, function (req, res) {
	const slug = req.query.slug ? String(req.query.slug) : ''
	const list = slug ? comments.listBySlug(slug, { includePending: true }) : comments.allComments()
	res.json({ comments: list.map(comments.adminComment), count: list.length })
})

app.post('/api/admin/comments/:id/approve', requireToken, function (req, res) {
	try {
		res.json({ ok: true, comment: comments.adminComment(comments.approveComment(req.params.id)) })
	} catch (err) {
		fail(res, err)
	}
})

app.delete('/api/admin/comments/:id', requireToken, function (req, res) {
	try {
		res.json({ ok: true, comment: comments.adminComment(comments.deleteComment(req.params.id)) })
	} catch (err) {
		fail(res, err)
	}
})

/* ---------------- 静态资源（放在最后，避免覆盖上面的动态路由） ---------------- */

app.use(
	express.static(DIST, {
		extensions: ['html'],
		setHeaders: function (res, filePath) {
			if (/\.(html)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache')
		}
	})
)

app.use(function (err, req, res, next) {
	console.error('[blog]', err)
	res.status(500).json({ error: '内部错误' })
})

if (require.main === module) {
	if (!ADMIN_TOKEN) {
		console.warn('[blog] 警告：未设置 BLOG_ADMIN_TOKEN，/api 接口将全部返回 503')
	}
	const server = app.listen(PORT, function () {
		console.log('[blog] 监听 http://localhost:' + PORT)
		console.log('[blog] 博客 /blog    后台 /admin')
		console.log('[games] 游戏 /games    三维连珠 /games/gomoku3d')
		console.log('[ws] 联机对局 ws://localhost:' + PORT + gameServer.PATH)
		console.log('[timer] 计时器 /timer')
		console.log('[blog] 文章目录 ' + store.POSTS_DIR)
		if (COMMENTS_ON) {
			console.log('[blog] 评论数据 ' + comments.COMMENTS_FILE)
		}
	})
	gameServer.createGameServer(server)
}

module.exports = app
