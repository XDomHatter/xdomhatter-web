const fs = require('fs')
const path = require('path')

const render = require('../lib/render')

const ROOT = render.ROOT
const POSTS_DIR = path.join(ROOT, 'src', 'blog', 'posts')
const OUT_DIR = path.join(ROOT, 'dist', 'blog')
const DIST_DIR = path.join(ROOT, 'dist')

const config = require(path.join(ROOT, 'config.json'))
const blogConf = config.blog || {}
const SITE_URL = String(blogConf.url || '').replace(/\/+$/, '')
const BLOG_TITLE = blogConf.title || 'Blog'
const BLOG_DESC = blogConf.description || config.head.description || ''

const esc = render.esc

function readPosts () {
	if (!fs.existsSync(POSTS_DIR)) return []
	return render.sortByDateDesc(
		fs
			.readdirSync(POSTS_DIR)
			.filter(function (file) {
				return /\.md$/i.test(file)
			})
			.map(function (file) {
				return render.parsePost(
					file,
					fs.readFileSync(path.join(POSTS_DIR, file), 'utf8')
				)
			})
			.filter(function (post) {
				return !post.draft && post.date
			})
	)
}

function ensureDir (dir) {
	fs.mkdirSync(dir, { recursive: true })
}

/**
 * 读取已编译产物，用于内联进页面。
 * 页面内联后不再依赖相对路径，file://、任意静态根、预览面板都能正常渲染。
 * 若产物尚未生成（例如单独跑 `npm run blog`），返回 null，模板会回退成外链。
 */
function readAsset (relPath, forbidden) {
	var file = path.join(DIST_DIR, relPath)
	if (!fs.existsSync(file)) return null
	var content = fs.readFileSync(file, 'utf8')
	if (forbidden && content.indexOf(forbidden) >= 0) return null
	return content
}

function writeFile (file, content) {
	ensureDir(path.dirname(file))
	fs.writeFileSync(file, content, 'utf8')
}

function walkHtml (dir) {
	if (!fs.existsSync(dir)) return []
	var out = []
	fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
		var full = path.join(dir, entry.name)
		if (entry.isDirectory()) out = out.concat(walkHtml(full))
		else if (/\.html$/.test(entry.name)) out.push(full)
	})
	return out
}

/**
 * 把页面里的相对链接按页面所在层级解析，逐个确认目标文件存在。
 * 相对路径层级算错时（例如 /blog/posts/<slug>/ 少上溯一级）会直接报出来。
 */
function checkLinks () {
	var problems = []
	walkHtml(OUT_DIR).forEach(function (file) {
		var baseUrl =
			'http://blog.invalid/' + path.relative(DIST_DIR, file).replace(/\\/g, '/')
		var re = /(?:href|src)="([^"]+)"/g
		var match
		while ((match = re.exec(fs.readFileSync(file, 'utf8'))) !== null) {
			var href = match[1]
			if (/^(https?:|mailto:|#|data:)/.test(href)) continue
			var resolved
			try {
				resolved = new URL(href, baseUrl)
			} catch (err) {
				continue
			}
			if (resolved.host !== 'blog.invalid') continue
			var target = path.join(DIST_DIR, decodeURIComponent(resolved.pathname))
			if (!fs.existsSync(target)) {
				problems.push(
					path.relative(DIST_DIR, file).replace(/\\/g, '/') + '  ->  ' + href
				)
			}
		}
	})

	if (problems.length) {
		console.warn('[blog] 发现 ' + problems.length + ' 个失效链接：')
		problems.slice(0, 12).forEach(function (line) {
			console.warn('  ' + line)
		})
	} else {
		console.log('[blog] 链接校验通过')
	}
}

function build () {
	const posts = readPosts()
	posts.forEach(function (post) {
		post.readingTime = Math.max(1, Math.round(post.words / 350))
	})

	const tags = render.buildTagIndex(posts)
	const full = posts.map(function (post) {
		return {
			slug: post.slug,
			title: post.title,
			date: post.date,
			tags: post.tags,
			summary: post.summary,
			words: post.words,
			readingTime: post.readingTime,
			tagObjs: post.tags.map(function (name) {
				return tags.map[name]
			}),
			toc: post.toc,
			content: post.content
		}
	})

	const meta = full.map(function (post) {
		return {
			slug: post.slug,
			title: post.title,
			date: post.date,
			tags: post.tags,
			summary: post.summary,
			words: post.words,
			readingTime: post.readingTime
		}
	})

	fs.rmSync(OUT_DIR, { recursive: true, force: true })
	ensureDir(OUT_DIR)

	const cssInline = readAsset('css/blog.css', '</style')
	const jsInline = readAsset('js/blog.js', '</script')
	if (!cssInline) {
		console.warn('[blog] 未找到 dist/css/blog.css，回退为外链（请先执行 gulp css）')
	}
	if (!jsInline) {
		console.warn('[blog] 未找到 dist/js/blog.js，回退为外链（请先执行 gulp js）')
	}

	const base = {
		siteTitle: config.head.title,
		blogTitle: BLOG_TITLE,
		blogDesc: BLOG_DESC,
		tags: tags.list,
		math: false,
		feed: true,
		// 静态产物是 index.html，动态服务是目录式 URL，靠 suffix 区分
		suffix: 'index.html',
		cssInline: cssInline,
		jsInline: jsInline
	}

	writeFile(
		path.join(OUT_DIR, 'index.html'),
		render.renderIndex(
			Object.assign({}, base, {
				root: '../',
				title: BLOG_TITLE + ' · ' + config.head.title,
				description: BLOG_DESC,
				posts: meta,
				tag: null
			})
		)
	)

	full.forEach(function (post) {
		writeFile(
			path.join(OUT_DIR, 'posts', post.slug, 'index.html'),
			render.renderPost(
				Object.assign({}, base, {
					// /blog/posts/<slug>/index.html -> 站点根需上溯三级
					root: '../../../',
					math: true,
					title: post.title + ' · ' + BLOG_TITLE,
					description: post.summary,
					post: post
				})
			)
		)
	})

	tags.list.forEach(function (tag) {
		const filtered = meta.filter(function (post) {
			return post.tags.indexOf(tag.name) >= 0
		})
		writeFile(
			path.join(OUT_DIR, 'tags', tag.slug, 'index.html'),
			render.renderIndex(
				Object.assign({}, base, {
					// /blog/tags/<tag>/index.html -> 站点根需上溯三级
					root: '../../../',
					title: '标签：' + tag.name + ' · ' + BLOG_TITLE,
					description: BLOG_DESC,
					posts: filtered,
					tag: tag.name
				})
			)
		)
	})

	writeFile(
		path.join(OUT_DIR, 'posts.json'),
		JSON.stringify(
			{
				site: SITE_URL,
				updated: new Date().toISOString(),
				posts: meta
			},
			null,
			2
		) + '\n'
	)

	writeFile(
		path.join(OUT_DIR, 'feed.xml'),
		render.buildFeed(meta, {
			siteUrl: SITE_URL,
			title: BLOG_TITLE,
			description: BLOG_DESC
		})
	)

	checkLinks()

	console.log(
		'[blog] ' +
			full.length +
			' 篇文章，' +
			tags.list.length +
			' 个标签 -> ' +
			path.relative(ROOT, OUT_DIR).replace(/\\/g, '/')
	)

	return { posts: meta, tags: tags.list }
}

module.exports = build
module.exports.build = build

if (require.main === module) {
	Promise.resolve()
		.then(build)
		.catch(function (err) {
			console.error('[blog] 构建失败:', err)
			process.exit(1)
		})
}
