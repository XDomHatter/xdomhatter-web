/**
 * 评论存储：每篇文章一个 data/posts/<id>/comments.json，与文章 post.md 同文件夹；
 * 内存缓存按 mtime 失效。
 *
 * 设计取舍：
 *   - 评论跟文章放同一文件夹：data/ 即全部运行数据，整目录复制/备份就是全量迁移；
 *     slug 只存在于 front-matter 与评论字段里，改 slug 不需要移动任何文件。
 *   - 选 JSON 而非 SQLite：本项目的文章源本身就是文件（data/posts/<id>/post.md），
 *     评论量级在个人博客尺度内，单文章单文件足以承载，且便于备份、diff 与人工修正。
 *   - 每次写操作整体重写并采用「临时文件 + rename」：rename 在同一文件系统上是原子的，
 *     可避免进程中断时留下半截 JSON 导致数据全丢。
 *   - 头像不依赖邮箱：由昵称首字符派生（initial），匿名显示默认头像；
 *     邮箱为选填项，随评论以小字公开显示（publicComment 下发），后台同样可见。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const render = require('../lib/render')
const store = require('./store')

const VERSION = 1

/** 单字段长度上限（按字符计，防止超长垃圾内容撑爆文件） */
const LIMITS = {
	slug: 120,
	nick: 40,
	email: 120,
	url: 200,
	content: 2000
}

/** 同一 IP 的提交节流窗口与上限 */
const RATE_WINDOW_MS = 60 * 1000
const RATE_MAX = 3

/** comments.json 绝对路径 -> { mtimeMs, store } */
const cache = new Map()

/* ---------------- 基础读写 ---------------- */

function emptyStore () {
	return { version: VERSION, comments: [] }
}

/** 由 slug 解析文章文件夹；slug 解析不到文章时返回 null（评论只允许发在已存在的文章上） */
function postDir (slug) {
	const post = store.findBySlug(clean(slug, LIMITS.slug))
	return post ? path.join(store.POSTS_DIR, post.id) : null
}

/** 全部文章各自的 comments.json 路径 */
function commentFiles () {
	if (!fs.existsSync(store.POSTS_DIR)) return []
	return fs
		.readdirSync(store.POSTS_DIR, { withFileTypes: true })
		.filter(function (entry) {
			return entry.isDirectory()
		})
		.map(function (entry) {
			return path.join(store.POSTS_DIR, entry.name, 'comments.json')
		})
}

/** 读取单个落盘文件；文件不存在时返回空结构，损坏时降级只读，不让服务整体挂掉 */
function readStore (file) {
	let stat = null
	try {
		stat = fs.statSync(file)
	} catch (err) {
		return emptyStore() // 还没有评论：不缓存，落盘后自然可读
	}

	const hit = cache.get(file)
	if (hit && hit.mtimeMs === stat.mtimeMs) return hit.store

	let data = null
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
		data = {
			version: VERSION,
			comments: Array.isArray(parsed.comments) ? parsed.comments : []
		}
	} catch (err) {
		// 损坏文件不做静默覆盖：保留原文件，仅在内存中降级，避免把用户数据抹掉。
		console.error('[comments] 数据文件解析失败，本次以降级只读模式运行：' + file, err.message)
		data = emptyStore()
	}

	cache.set(file, { mtimeMs: stat.mtimeMs, store: data })
	return data
}

function writeStore (file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	const tmp = file + '.' + process.pid + '.tmp'
	const payload = JSON.stringify(
		{ version: VERSION, comments: data.comments },
		null,
		2
	) + '\n'

	// 先写临时文件并 fsync，再 rename 覆盖，保证磁盘上要么是旧数据要么是新数据。
	const fd = fs.openSync(tmp, 'w')
	try {
		fs.writeFileSync(fd, payload, 'utf8')
		fs.fsyncSync(fd)
	} finally {
		fs.closeSync(fd)
	}
	fs.renameSync(tmp, file)

	const stat = fs.statSync(file)
	cache.set(file, { mtimeMs: stat.mtimeMs, store: data })
}

/* ---------------- 字段处理 ---------------- */

function clean (value, max) {
	return String(value == null ? '' : value)
		.replace(/\r\n?/g, '\n')
		.trim()
		.slice(0, max)
}

/** 邮箱只做粗校验：有 @ 且 @ 两侧非空、域名含点。不追求 RFC 完备，避免误杀 */
function validEmail (value) {
	if (!value) return true // 邮箱选填
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

/** 仅允许 http/https，挡住 javascript: 之类的伪协议注入 */
function normalizeUrl (value) {
	const s = clean(value, LIMITS.url)
	if (!s) return ''
	if (!/^https?:\/\//i.test(s)) return 'https://' + s.replace(/^\/+/, '')
	try {
		const u = new URL(s)
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : ''
	} catch (err) {
		return ''
	}
}

/** IP 只存加盐哈希：既能做节流与溯源，又不把访客原始 IP 落盘 */
function hashIp (ip) {
	const salt = process.env.BLOG_COMMENT_SALT || 'xdomhatter-blog'
	return crypto
		.createHash('sha256')
		.update(salt + '|' + String(ip || ''))
		.digest('hex')
		.slice(0, 16)
}

/** 头像文字：取昵称首字符（拉丁字母转大写）；匿名不留字，走默认黑色头像 */
function avatarInitial (nick) {
	const n = String(nick == null ? '' : nick).trim()
	if (!n || n === '匿名') return ''
	// Array.from 按码点切分，emoji 等代理对字符不会被截半
	const first = Array.from(n)[0]
	return first.toUpperCase()
}

function newId () {
	return (
		Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex')
	)
}

/* ---------------- 输出整形 ---------------- */

/**
 * 公开字段：邮箱为选填项、随评论公开展示（访客自主填写）；IP 哈希不下发前端。
 * initial 为头像首字符，由服务端统一派生，保证 SSR、静态构建与前端追加一致。
 */
function publicComment (item) {
	return {
		id: item.id,
		slug: item.slug,
		nick: item.nick,
		email: item.email || '',
		url: item.url || '',
		initial: avatarInitial(item.nick),
		content: item.content,
		created: item.created
	}
}

/** 后台字段：在公开字段基础上补来源 IP 哈希与审核状态，便于处理垃圾评论 */
function adminComment (item) {
	return Object.assign(publicComment(item), {
		ipHash: item.ipHash || '',
		approved: item.approved !== false,
		parent: item.parent || ''
	})
}

/* ---------------- 查询 ---------------- */

/** 在所有文章文件夹中定位一条评论（评论 id 全局唯一） */
function locate (id) {
	const files = commentFiles()
	for (const file of files) {
		const data = readStore(file)
		const index = data.comments.findIndex(function (item) {
			return item.id === id
		})
		if (index >= 0) {
			return { file: file, data: data, index: index, item: data.comments[index] }
		}
	}
	return null
}

/**
 * 取某篇文章的评论。
 * @param {string} slug 文章 slug
 * @param {object} [opts] { includePending: 是否含待审核 }
 */
function listBySlug (slug, opts) {
	const options = opts || {}
	const wanted = clean(slug, LIMITS.slug)
	const dir = postDir(wanted)
	if (!dir) {
		const err = new Error('文章不存在：' + wanted)
		err.status = 404
		throw err
	}
	// 文件夹即归属，不再按 item.slug 二次过滤：文章改 slug 后旧评论依然跟随文件夹可见
	return readStore(path.join(dir, 'comments.json'))
		.comments.filter(function (item) {
			if (!options.includePending && item.approved === false) return false
			return true
		})
		.sort(function (a, b) {
			// 早期在前，符合阅读顺序；时间相同则按 id 稳定排序
			return a.created < b.created ? -1 : a.created > b.created ? 1 : 0
		})
}

/** 文章 slug -> 已通过评论数，列表页/构建期可用（键取文章当前 slug，改 slug 后计数不丢） */
function countBySlug () {
	const out = Object.create(null)
	store.allPosts().forEach(function (post) {
		const file = path.join(store.POSTS_DIR, post.id, 'comments.json')
		const count = readStore(file).comments.filter(function (item) {
			return item.approved !== false
		}).length
		if (count) out[post.slug] = count
	})
	return out
}

function allComments () {
	const list = []
	commentFiles().forEach(function (file) {
		list.push.apply(list, readStore(file).comments)
	})
	return list.sort(function (a, b) {
		return a.created < b.created ? 1 : a.created > b.created ? -1 : 0
	})
}

function findById (id) {
	const found = locate(id)
	return found ? found.item : null
}

/* ---------------- 写入 ---------------- */

/** 同一 IP 在窗口内的提交次数（用于节流，内存计数即可，重启清零可接受） */
const rateHits = new Map()

function rateLimited (ipHash) {
	const now = Date.now()
	const hits = (rateHits.get(ipHash) || []).filter(function (t) {
		return now - t < RATE_WINDOW_MS
	})
	if (hits.length >= RATE_MAX) {
		rateHits.set(ipHash, hits)
		return true
	}
	hits.push(now)
	rateHits.set(ipHash, hits)
	return false
}

/**
 * 新增评论。
 * @param {string} slug 文章 slug（必须是已存在的文章）
 * @param {object} data { nick, email, url, content, parent }
 * @param {object} [ctx] { ip }
 * @returns {object} 公开字段的评论对象
 */
function addComment (slug, data, ctx) {
	const input = data || {}
	const wanted = clean(slug, LIMITS.slug)
	if (!wanted) {
		const err = new Error('缺少文章 slug')
		err.status = 400
		throw err
	}
	const dir = postDir(wanted)
	if (!dir) {
		const err = new Error('文章不存在：' + wanted)
		err.status = 404
		throw err
	}

	const nick = clean(input.nick, LIMITS.nick) || '匿名'
	const email = clean(input.email, LIMITS.email)
	const content = clean(input.content, LIMITS.content)

	if (!content) {
		const err = new Error('评论内容不能为空')
		err.status = 400
		throw err
	}
	if (!validEmail(email)) {
		const err = new Error('邮箱格式不正确')
		err.status = 400
		throw err
	}

	const ipHash = hashIp((ctx || {}).ip)
	if (rateLimited(ipHash)) {
		const err = new Error('提交过于频繁，请稍后再试')
		err.status = 429
		throw err
	}

	const item = {
		id: newId(),
		slug: wanted,
		nick: nick,
		email: email,
		url: normalizeUrl(input.url),
		content: content,
		created: new Date().toISOString(),
		ipHash: ipHash,
		parent: clean(input.parent, 64),
		// 默认即时可见；置 BLOG_COMMENT_REVIEW=1 可切换为先审后发。
		approved: process.env.BLOG_COMMENT_REVIEW !== '1'
	}

	const file = path.join(dir, 'comments.json')
	const existing = readStore(file)
	// 复制而非原地 push：readStore 可能返回缓存对象，先解开引用再写，避免异常时缓存被污染
	writeStore(file, { version: VERSION, comments: existing.comments.concat([item]) })
	return item
}

/** 通过审核 */
function approveComment (id) {
	const found = locate(id)
	if (!found) {
		const err = new Error('评论不存在：' + id)
		err.status = 404
		throw err
	}
	const next = found.data.comments.slice()
	next[found.index] = Object.assign({}, next[found.index], { approved: true })
	writeStore(found.file, { version: VERSION, comments: next })
	return next[found.index]
}

/** 删除 */
function deleteComment (id) {
	const found = locate(id)
	if (!found) {
		const err = new Error('评论不存在：' + id)
		err.status = 404
		throw err
	}
	writeStore(
		found.file,
		{
			version: VERSION,
			comments: found.data.comments.filter(function (item) {
				return item.id !== id
			})
		}
	)
	return found.item
}

/** 文章改 slug 后同步该文件夹内评论的 slug 字段，保持后台列表的跳转链接有效 */
function syncSlug (id, newSlug) {
	const file = path.join(store.POSTS_DIR, id, 'comments.json')
	const data = readStore(file)
	if (!data.comments.length) return
	let changed = false
	const next = data.comments.map(function (item) {
		if (item.slug === newSlug) return item
		changed = true
		return Object.assign({}, item, { slug: newSlug })
	})
	if (changed) writeStore(file, { version: VERSION, comments: next })
}

/** 仅测试用：清空节流计数与内存缓存，避免用例之间互相影响 */
function resetRateLimit () {
	rateHits.clear()
}

/** 仅测试用：丢弃缓存，强制下次从磁盘重读 */
function resetCache () {
	cache.clear()
}

module.exports = {
	LIMITS: LIMITS,
	listBySlug: listBySlug,
	countBySlug: countBySlug,
	allComments: allComments,
	findById: findById,
	addComment: addComment,
	approveComment: approveComment,
	deleteComment: deleteComment,
	syncSlug: syncSlug,
	publicComment: publicComment,
	adminComment: adminComment,
	resetRateLimit: resetRateLimit,
	resetCache: resetCache
}
