/**
 * 一次性数据迁移：把旧版散装数据迁入 data/posts/<id>/ 结构。
 *   旧：文章 src/blog/posts/YYYY-MM-DD-<slug>.md + 评论 data/comments.json（全站单文件）
 *   新：data/posts/<id>/post.md（front-matter 含 slug）+ data/posts/<id>/comments.json
 *
 * 幂等，满足任一条件即静默返回：
 *   - data/posts 下已有文章文件夹（迁移已完成或已在使用新结构）；
 *   - src/blog/posts 与旧 data/comments.json 均不存在（没有可迁移的数据）。
 *
 * 由 server/app.js 启动（listen 前）与 scripts/build-blog.js 构建前自动调用；
 * 测试进程同进程 require app 时不会执行（调用点在 require.main === module 内）。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const matter = require('gray-matter')
const render = require('../lib/render')
const store = require('./store')

const LEGACY_POSTS_DIR = path.join(render.ROOT, 'src', 'blog', 'posts')
const LEGACY_COMMENTS_FILE = path.join(render.ROOT, 'data', 'comments.json')
const ORPHAN_FILE = path.join(store.POSTS_DIR, '_orphan-comments.json')

const VERSION = 1

/** 生成不与现有文件夹冲突的 8 位 hex id */
function newId () {
	let id
	do {
		id = crypto.randomBytes(4).toString('hex')
	} while (fs.existsSync(path.join(store.POSTS_DIR, id)))
	return id
}

function hasSubdir (dir) {
	if (!fs.existsSync(dir)) return false
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.some(function (entry) {
			return entry.isDirectory()
		})
}

/** 读一个 JSON 数组容器（comments.json / 孤儿收容文件），损坏或缺失按空数组处理 */
function readCommentList (file) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
		return Array.isArray(parsed.comments) ? parsed.comments : []
	} catch (err) {
		return []
	}
}

function writeCommentFile (file, comments) {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(
		file,
		JSON.stringify({ version: VERSION, comments: comments }, null, 2) + '\n',
		'utf8'
	)
}

function migrate () {
	/* ---------- 跳过条件：已在目标结构，或没有旧数据可迁 ---------- */
	if (hasSubdir(store.POSTS_DIR)) return
	if (!fs.existsSync(LEGACY_POSTS_DIR) && !fs.existsSync(LEGACY_COMMENTS_FILE)) {
		return
	}

	console.log('[migrate] 发现旧版数据，开始迁移到 ' + store.POSTS_DIR)
	fs.mkdirSync(store.POSTS_DIR, { recursive: true })

	/* ---------- 1. 迁移文章：src/blog/posts/*.md -> data/posts/<id>/post.md ---------- */
	// 先收录已有文件夹的 slug（应对「文章已迁、评论未迁」的中途状态），再迁文章本体
	const slugToId = Object.create(null)
	fs
		.readdirSync(store.POSTS_DIR, { withFileTypes: true })
		.filter(function (entry) {
			return entry.isDirectory()
		})
		.forEach(function (entry) {
			const file = path.join(store.POSTS_DIR, entry.name, 'post.md')
			try {
				const data = matter(fs.readFileSync(file, 'utf8')).data || {}
				if (data.slug) slugToId[String(data.slug)] = entry.name
			} catch (err) {
				/* 读不出的文件夹不纳入映射，不影响流程 */
			}
		})

	let legacyFiles = []
	if (fs.existsSync(LEGACY_POSTS_DIR)) {
		legacyFiles = fs
			.readdirSync(LEGACY_POSTS_DIR)
			.filter(function (name) {
				return /\.md$/i.test(name)
			})
			.sort()
		legacyFiles.forEach(function (name) {
			const base = name.replace(/\.md$/i, '')
			const slug = base.replace(/^\d{4}-\d{2}-\d{2}-/, '') || base
			const parsed = matter(
				fs.readFileSync(path.join(LEGACY_POSTS_DIR, name), 'utf8')
			)
			const data = parsed.data || {}
			const id = newId()
			fs.mkdirSync(path.join(store.POSTS_DIR, id))
			fs.writeFileSync(
				path.join(store.POSTS_DIR, id, 'post.md'),
				render.serializePost(
					{
						title: data.title || slug,
						date: render.formatDate(data.date) || base.slice(0, 10),
						tags: data.tags || [],
						summary: data.summary || '',
						slug: slug,
						draft: data.draft === true
					},
					parsed.content
				),
				'utf8'
			)
			slugToId[slug] = id
			console.log('[migrate] 文章 ' + slug + ' -> data/posts/' + id)
		})
	}

	/* ---------- 2. 归位评论：按 comment.slug 写进对应文章文件夹，逐字保留 ---------- */
	if (fs.existsSync(LEGACY_COMMENTS_FILE)) {
		const legacy = readCommentList(LEGACY_COMMENTS_FILE)
		const orphans = []
		let moved = 0
		legacy.forEach(function (item) {
			const id = item && slugToId[item.slug]
			if (!id) {
				orphans.push(item)
				return
			}
			const file = path.join(store.POSTS_DIR, id, 'comments.json')
			// 目标文件已存在（如上次迁移中断）则合并，不覆盖
			writeCommentFile(file, readCommentList(file).concat([item]))
			moved++
		})
		console.log('[migrate] 评论 ' + moved + ' 条归位到各文章文件夹')
		if (orphans.length) {
			writeCommentFile(ORPHAN_FILE, readCommentList(ORPHAN_FILE).concat(orphans))
			console.warn(
				'[migrate] 警告：' +
					orphans.length +
					' 条评论找不到对应文章，已写入 data/posts/_orphan-comments.json'
			)
		}
	}

	/* ---------- 3. 收尾：备份旧评论文件，删除已迁空的文章目录 ---------- */
	if (fs.existsSync(LEGACY_COMMENTS_FILE)) {
		fs.renameSync(LEGACY_COMMENTS_FILE, LEGACY_COMMENTS_FILE + '.bak')
		console.log('[migrate] 旧 data/comments.json 已备份为 data/comments.json.bak')
	}
	if (legacyFiles.length) {
		legacyFiles.forEach(function (name) {
			fs.rmSync(path.join(LEGACY_POSTS_DIR, name), { force: true })
		})
		try {
			fs.rmdirSync(LEGACY_POSTS_DIR)
			console.log('[migrate] 已删除 ' + path.relative(render.ROOT, LEGACY_POSTS_DIR))
		} catch (err) {
			console.warn('[migrate] src/blog/posts 非空，保留原目录：' + err.message)
		}
	}
	console.log('[migrate] 完成：文章与评论已集中到 ' + store.POSTS_DIR)
}

module.exports = {
	migrate: migrate
}
