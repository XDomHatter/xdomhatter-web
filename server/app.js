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
const store = require('./store')

const ROOT = render.ROOT
const DIST = path.join(ROOT, 'dist')
const config = require(path.join(ROOT, 'config.json'))
const blogConf = config.blog || {}
const SITE_URL = String(blogConf.url || '').replace(/\/+$/, '')
const BLOG_TITLE = blogConf.title || 'Blog'
const BLOG_DESC = blogConf.description || config.head.description || ''

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
	app.listen(PORT, function () {
		console.log('[blog] 监听 http://localhost:' + PORT)
		console.log('[blog] 博客 /blog    后台 /admin')
		console.log('[blog] 文章目录 ' + store.POSTS_DIR)
	})
}

module.exports = app
