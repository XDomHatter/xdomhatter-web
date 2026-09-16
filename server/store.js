/**
 * 文章存储：直接以 Markdown 文件为数据源，按 mtime 做内存缓存。
 * 任何写操作都会失效缓存，下一次请求即重新渲染，因此改完立刻生效；
 * 直接在服务器上改文件也能被 mtime 变化检测到。
 */
const fs = require('fs')
const path = require('path')
const render = require('../lib/render')

const POSTS_DIR = process.env.BLOG_POSTS_DIR
	? path.resolve(process.env.BLOG_POSTS_DIR)
	: path.join(render.ROOT, 'src', 'blog', 'posts')

const cache = new Map()

function ensureDir () {
	fs.mkdirSync(POSTS_DIR, { recursive: true })
}

function fullPath (file) {
	return path.join(POSTS_DIR, file)
}

function listFiles () {
	if (!fs.existsSync(POSTS_DIR)) return []
	return fs
		.readdirSync(POSTS_DIR)
		.filter(function (file) {
			return /\.md$/i.test(file)
		})
}

function loadFile (file) {
	const stat = fs.statSync(fullPath(file))
	const hit = cache.get(file)
	if (hit && hit.mtimeMs === stat.mtimeMs) return hit.post
	const post = render.parsePost(file, fs.readFileSync(fullPath(file), 'utf8'))
	post.readingTime = Math.max(1, Math.round(post.words / 350))
	cache.set(file, { mtimeMs: stat.mtimeMs, post: post })
	return post
}

function today () {
	return new Date().toISOString().slice(0, 10)
}

/** 全部文章（含草稿），后台管理用 */
function allPosts () {
	return render.sortByDateDesc(listFiles().map(loadFile))
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

function writeFile (slug, data, existing) {
	const date =
		render.formatDate(data.date) || (existing && existing.date) || today()
	const raw = render.serializePost(
		{
			title: data.title || slug,
			date: date,
			tags: data.tags || [],
			summary: data.summary || '',
			draft: !!data.draft
		},
		data.body || ''
	)

	const filename = date + '-' + slug + '.md'
	ensureDir()
	fs.writeFileSync(fullPath(filename), raw, 'utf8')

	if (existing && existing.file !== filename) {
		fs.rmSync(fullPath(existing.file), { force: true })
		cache.delete(existing.file)
	}
	cache.delete(filename)
	return filename
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
	writeFile(slug, data, null)
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
	writeFile(newSlug, data, existing)
	return findBySlug(newSlug)
}

function deletePost (slug) {
	const post = findBySlug(slug)
	if (!post) {
		const err = new Error('文章不存在：' + slug)
		err.status = 404
		throw err
	}
	fs.rmSync(fullPath(post.file), { force: true })
	cache.delete(post.file)
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
