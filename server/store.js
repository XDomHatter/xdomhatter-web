/**
 * 文章存储：每篇文章一个 data/posts/<id>/ 文件夹（id 为 8 位随机 hex，独立于 slug），
 * 内含 post.md（front-matter 携带 slug）；评论放在同一文件夹的 comments.json。
 * 按 mtime 做内存缓存，任何写操作都会失效缓存，下一次请求即重新渲染，
 * 因此改完立刻生效；直接在服务器上改文件也能被 mtime 变化检测到。
 * slug 只承担对外 URL：改 slug 只改 front-matter，不会移动或重命名任何文件。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const render = require('../lib/render')

const POSTS_DIR = process.env.BLOG_POSTS_DIR
	? path.resolve(process.env.BLOG_POSTS_DIR)
	: path.join(render.ROOT, 'data', 'posts')

const cache = new Map()

function ensureDir () {
	fs.mkdirSync(POSTS_DIR, { recursive: true })
}

function fullPath (file) {
	return path.join(POSTS_DIR, file)
}

/** 文章文件夹即文章 id；散文件（如 _orphan-comments.json）不是文章，自动排除 */
function listIds () {
	if (!fs.existsSync(POSTS_DIR)) return []
	return fs
		.readdirSync(POSTS_DIR, { withFileTypes: true })
		.filter(function (entry) {
			return entry.isDirectory()
		})
		.map(function (entry) {
			return entry.name
		})
}

function loadFile (id) {
	const file = path.join(id, 'post.md')
	let stat = null
	try {
		stat = fs.statSync(fullPath(file))
	} catch (err) {
		return null // 文件夹里没有 post.md，视为无效文章
	}
	const hit = cache.get(file)
	if (hit && hit.mtimeMs === stat.mtimeMs) return hit.post

	const post = render.parsePost(file, fs.readFileSync(fullPath(file), 'utf8'))
	if (!post.slug) {
		// slug 是文章的唯一对外标识，缺失的文件不进列表，避免渲染出 /blog/posts// 这类地址
		console.warn('[blog] 跳过缺少 slug 的文章：' + file)
		post.readingTime = 0
		cache.set(file, { mtimeMs: stat.mtimeMs, post: null })
		return null
	}
	post.id = id
	post.readingTime = Math.max(1, Math.round(post.words / 350))
	cache.set(file, { mtimeMs: stat.mtimeMs, post: post })
	return post
}

function today () {
	return new Date().toISOString().slice(0, 10)
}

/** 全部文章（含草稿），后台管理用 */
function allPosts () {
	return render.sortByDateDesc(
		listIds()
			.map(loadFile)
			.filter(Boolean)
	)
}

/** 已发布文章，站点渲染用 */
function publishedPosts () {
	return allPosts().filter(function (post) {
		return !post.draft && post.date
	})
}

function findBySlug (slug) {
	return allPosts().find(function (post) {
		return post.slug === slug
	}) || null
}

function publicMeta (post) {
	return {
		id: post.id,
		slug: post.slug,
		title: post.title,
		date: post.date,
		tags: post.tags,
		summary: post.summary,
		words: post.words,
		readingTime: post.readingTime
	}
}

function adminMeta (post) {
	return Object.assign(publicMeta(post), {
		file: post.file,
		draft: post.draft
	})
}

/** 原位重写 <id>/post.md；slug 变化只体现为 front-matter 的一行，文件位置不变 */
function writeFile (id, slug, data, existing) {
	const date =
		render.formatDate(data.date) || (existing && existing.date) || today()
	const raw = render.serializePost(
		{
			title: data.title || slug,
			date: date,
			tags: data.tags || [],
			summary: data.summary || '',
			slug: slug,
			draft: !!data.draft
		},
		data.body || ''
	)

	ensureDir()
	const file = path.join(id, 'post.md')
	fs.writeFileSync(fullPath(file), raw, 'utf8')
	cache.delete(file)
	return file
}

function createPost (data) {
	const slug = render.slugify(data.slug || data.title)
	if (!slug) {
		const err = new Error('缺少 slug 或标题')
		err.status = 400
		throw err
	}
	if (findBySlug(slug)) {
		const err = new Error('已存在同 slug 的文章：' + slug)
		err.status = 409
		throw err
	}
	ensureDir()
	let id
	do {
		id = crypto.randomBytes(4).toString('hex')
	} while (fs.existsSync(path.join(POSTS_DIR, id)))
	fs.mkdirSync(path.join(POSTS_DIR, id))
	writeFile(id, slug, data, null)
	return findBySlug(slug)
}

function updatePost (oldSlug, data) {
	const existing = findBySlug(oldSlug)
	if (!existing) {
		const err = new Error('文章不存在：' + oldSlug)
		err.status = 404
		throw err
	}
	const newSlug = render.slugify(data.slug || oldSlug)
	if (newSlug !== oldSlug && findBySlug(newSlug)) {
		const err = new Error('已存在同 slug 的文章：' + newSlug)
		err.status = 409
		throw err
	}
	writeFile(existing.id, newSlug, data, existing)
	return findBySlug(newSlug)
}

/** 删除整个 <id>/ 文件夹（post.md 与它的 comments.json 一起消失） */
function deletePost (slug) {
	const post = findBySlug(slug)
	if (!post) {
		const err = new Error('文章不存在：' + slug)
		err.status = 404
		throw err
	}
	fs.rmSync(path.join(POSTS_DIR, post.id), { recursive: true, force: true })
	cache.delete(path.join(post.id, 'post.md'))
	return post
}

function renderPreview (content) {
	return render.renderMarkdown(content || '')
}

module.exports = {
	POSTS_DIR: POSTS_DIR,
	allPosts: allPosts,
	publishedPosts: publishedPosts,
	findBySlug: findBySlug,
	publicMeta: publicMeta,
	adminMeta: adminMeta,
	createPost: createPost,
	updatePost: updatePost,
	deletePost: deletePost,
	renderPreview: renderPreview
}
