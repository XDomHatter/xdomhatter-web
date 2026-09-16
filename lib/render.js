/**
 * 博客渲染核心：静态构建（scripts/build-blog.js）与动态服务（server/）共用同一套管线，
 * 保证两种模式下 Markdown / LaTeX / 目录 / 标签的行为完全一致。
 */
const fs = require('fs')
const path = require('path')
const matter = require('gray-matter')
const MarkdownIt = require('markdown-it')
const katexPlugin = require('@vscode/markdown-it-katex').default
const anchorPlugin = require('markdown-it-anchor')
const hljs = require('highlight.js')
const pug = require('pug')

const ROOT = path.resolve(__dirname, '..')
const TPL_DIR = path.join(ROOT, 'src', 'blog', 'templates')

function slugify (input) {
	const s = String(input == null ? '' : input)
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[\\/:*?"<>|.,;!?'"`~@#$%^&+=()[\]{}]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
	return s || 'section'
}

const md = new MarkdownIt({
	html: true,
	linkify: true,
	highlight: function (str, lang) {
		if (lang && hljs.getLanguage(lang)) {
			try {
				return (
					'<pre class="hljs"><code>' +
					hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
					'</code></pre>'
				)
			} catch (err) {
				/* 回退到转义输出 */
			}
		}
		return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>'
	}
})

md.use(anchorPlugin, { slugify: slugify, permalink: false, level: [2, 3, 4] })
md.use(katexPlugin, { throwOnError: false, errorColor: '#cc0000' })

function renderMarkdown (content) {
	return md.render(content)
}

function buildToc (html) {
	const re = /<h([234])\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g
	const toc = []
	let match
	while ((match = re.exec(html)) !== null) {
		const text = match[3].replace(/<[^>]+>/g, '').trim()
		if (text) {
			toc.push({ level: Number(match[1]), id: match[2], text: text })
		}
	}
	return toc
}

function formatDate (value) {
	if (!value) return ''
	if (value instanceof Date) return value.toISOString().slice(0, 10)
	const s = String(value)
	const m = s.match(/^\d{4}-\d{2}-\d{2}/)
	return m ? m[0] : s
}

function countWords (plain) {
	const cjk = (plain.match(/[\u3400-\u9fff]/g) || []).length
	const latin = (plain.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9]+/g) || [])
		.length
	return cjk + latin
}

function toPlainText (html) {
	return html
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

function summaryOf (plain) {
	return plain.slice(0, 120)
}

/**
 * 解析单篇文章。
 * @param {string} file 文件名，如 2026-09-13-hello.md
 * @param {string} raw  文件全文
 */
function parsePost (file, raw) {
	const parsed = matter(raw)
	const data = parsed.data || {}
	const fileName = file.replace(/\.md$/i, '')
	const html = renderMarkdown(parsed.content)
	const plain = toPlainText(html)

	return {
		file: file,
		slug: data.slug || fileName.replace(/^\d{4}-\d{2}-\d{2}-/, '') || fileName,
		title: data.title || fileName,
		date: formatDate(data.date || fileName.slice(0, 10)),
		tags: (data.tags || [])
			.map(function (t) {
				return String(t).trim()
			})
			.filter(Boolean),
		draft: data.draft === true,
		summary: data.summary || summaryOf(plain),
		content: html,
		toc: buildToc(html),
		words: countWords(plain),
		readingTime: 0,
		raw: raw
	}
}

/** 由 slug + front-matter 重新组装原始文件文本（供后台保存用） */
function serializePost (fields, body) {
	const tags = fields.tags || []
	const lines = ['---']
	lines.push('title: ' + JSON.stringify(String(fields.title || '')))
	lines.push('date: ' + (fields.date || ''))
	if (tags.length) {
		lines.push('tags: [' + tags.map((t) => JSON.stringify(t)).join(', ') + ']')
	}
	if (fields.summary) {
		lines.push('summary: ' + JSON.stringify(String(fields.summary)))
	}
	if (fields.draft) lines.push('draft: true')
	lines.push('---', '')
	return lines.join('\n') + String(body || '').replace(/^\s+/, '') + '\n'
}

function buildTagIndex (posts) {
	const used = Object.create(null)
	const map = Object.create(null)
	const order = []

	posts.forEach(function (post) {
		post.tags.forEach(function (name) {
			if (!map[name]) {
				let slug = slugify(name)
				if (!slug || slug === 'section') {
					slug = 'tag-' + Buffer.from(name, 'utf8').toString('hex').slice(0, 12)
				}
				while (used[slug]) slug = slug + '-2'
				used[slug] = true
				map[name] = { name: name, slug: slug, count: 0 }
				order.push(name)
			}
			map[name].count += 1
		})
	})

	return {
		map: map,
		list: order
			.map(function (name) {
				return map[name]
			})
			.sort(function (a, b) {
				return b.count - a.count || a.name.localeCompare(b.name)
			})
	}
}

function sortByDateDesc (posts) {
	return posts.slice().sort(function (a, b) {
		return a.date < b.date ? 1 : a.date > b.date ? -1 : 0
	})
}

function renderIndex (options) {
	return pug.renderFile(path.join(TPL_DIR, 'index.pug'), options)
}

function renderPost (options) {
	return pug.renderFile(path.join(TPL_DIR, 'post.pug'), options)
}

function buildFeed (posts, options) {
	const opts = options || {}
	const siteUrl = String(opts.siteUrl || '').replace(/\/+$/, '')
	const items = posts
		.slice(0, 20)
		.map(function (post) {
			const link = siteUrl + '/blog/posts/' + post.slug + '/'
			return [
				'    <item>',
				'      <title>' + esc(post.title) + '</title>',
				'      <link>' + esc(link) + '</link>',
				'      <guid isPermaLink="true">' + esc(link) + '</guid>',
				'      <pubDate>' +
					new Date(post.date + 'T00:00:00Z').toUTCString() +
					'</pubDate>',
				'      <description>' + esc(post.summary) + '</description>',
				'    </item>'
			].join('\n')
		})
		.join('\n')

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
		'  <channel>',
		'    <title>' + esc(opts.title) + '</title>',
		'    <link>' + esc(siteUrl + '/blog/') + '</link>',
		'    <description>' + esc(opts.description) + '</description>',
		'    <language>zh-CN</language>',
		items,
		'  </channel>',
		'</rss>',
		''
	].join('\n')
}

function esc (s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

module.exports = {
	ROOT: ROOT,
	TPL_DIR: TPL_DIR,
	slugify: slugify,
	renderMarkdown: renderMarkdown,
	buildToc: buildToc,
	formatDate: formatDate,
	countWords: countWords,
	toPlainText: toPlainText,
	parsePost: parsePost,
	serializePost: serializePost,
	buildTagIndex: buildTagIndex,
	sortByDateDesc: sortByDateDesc,
	buildFeed: buildFeed,
	renderIndex: renderIndex,
	renderPost: renderPost,
	esc: esc
}
