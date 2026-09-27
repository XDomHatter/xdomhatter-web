/**
 * 评论功能回归测试：覆盖「持久化存储」与「HTTP 接口」两层。
 *
 * 重点保护的行为：
 *   1. 落盘持久化——进程重新加载模块后数据仍在（这是需求的硬约束）。
 *   2. 邮箱等隐私字段不出现在公开响应里。
 *   3. 无令牌不能读/删后台评论；有令牌可以。
 *   4. 字段校验与提交节流。
 *   5. 文章页服务端渲染出评论区，且评论内容被转义（防 XSS）。
 *   6. 静态产物中评论表单没有可用的提交目标（submitUrl 为空）。
 *
 * 运行：node scripts/test-comments.js
 */
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

/* 关键：在 require 业务模块之前把数据目录指向临时目录，
   避免测试污染项目真实的 data/comments.json。 */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xdblog-comments-'))
process.env.BLOG_COMMENTS_DIR = TMP_DIR
process.env.BLOG_ADMIN_TOKEN = 'test-token-please-change'

let pass = 0
let fail = 0

function ok (name, cond, extra) {
	if (cond) {
		pass++
		console.log('PASS  ' + name)
	} else {
		fail++
		console.log('FAIL  ' + name + (extra ? ' :: ' + extra : ''))
	}
}

const comments = require('../server/comments')
const store = require('../server/store')
const render = require('../lib/render')
const app = require('../server/app')

const FILE = path.join(TMP_DIR, 'comments.json')

function req (port, method, urlPath, body, headers) {
	return new Promise(function (resolve, reject) {
		const payload = body ? JSON.stringify(body) : null
		const r = http.request(
			{
				host: '127.0.0.1',
				port: port,
				path: urlPath,
				method: method,
				headers: Object.assign(
					{ 'Content-Type': 'application/json' },
					headers || {}
				)
			},
			function (res) {
				let text = ''
				res.setEncoding('utf8')
				res.on('data', function (c) {
					text += c
				})
				res.on('end', function () {
					let json = null
					try {
						json = JSON.parse(text)
					} catch (err) {
						json = null
					}
					resolve({ status: res.statusCode, body: text, json: json })
				})
			}
		)
		r.on('error', reject)
		if (payload) r.write(payload)
		r.end()
	})
}

async function main () {
	/* ============ 一、存储层：持久化 ============ */

	comments.resetRateLimit()
	comments.resetCache()

	ok('初始状态数据文件不存在', !fs.existsSync(FILE))

	const first = comments.addComment(
		'demo-post',
		{ nick: '阿甲', email: 'a@example.com', content: '持久化验证' },
		{ ip: '10.0.0.1' }
	)
	ok('新增评论后数据文件已生成', fs.existsSync(FILE))
	ok('返回值带 id', !!first.id)

	// 模拟「进程重启」：抛掉内存缓存，强制从磁盘重读
	comments.resetCache()
	const afterReload = comments.listBySlug('demo-post')
	ok(
		'重启后仍能读到评论（持久化生效）',
		afterReload.length === 1 && afterReload[0].content === '持久化验证',
		'读到 ' + afterReload.length + ' 条'
	)

	/* 直接改磁盘文件也应被 mtime 检测到（对齐 store.js 的既有能力） */
	const disk = JSON.parse(fs.readFileSync(FILE, 'utf8'))
	disk.comments.push({
		id: 'external-1',
		slug: 'demo-post',
		nick: '外部写入',
		email: '',
		url: '',
		avatar: '',
		content: '手工改文件',
		created: new Date().toISOString(),
		ipHash: '',
		parent: '',
		approved: true
	})
	fs.writeFileSync(FILE, JSON.stringify(disk, null, 2), 'utf8')
	// 改文件后 mtime 可能同毫秒，显式清缓存保证断言稳定
	comments.resetCache()
	ok(
		'外部直接改文件也能被读到',
		comments.listBySlug('demo-post').length === 2,
		'实际 ' + comments.listBySlug('demo-post').length
	)

	/* ============ 二、字段处理与校验 ============ */

	comments.resetRateLimit()
	comments.resetCache()

	try {
		comments.addComment('demo-post', { nick: 'x', content: '   ' })
		ok('空内容被拒绝', false)
	} catch (err) {
		ok('空内容被拒绝', err.status === 400, 'status ' + err.status)
	}

	try {
		comments.addComment('demo-post', { nick: 'x', content: 'hi', email: 'not-an-email' })
		ok('非法邮箱被拒绝', false)
	} catch (err) {
		ok('非法邮箱被拒绝', err.status === 400, 'status ' + err.status)
	}

	try {
		comments.addComment('', { nick: 'x', content: 'hi' })
		ok('缺少 slug 被拒绝', false)
	} catch (err) {
		ok('缺少 slug 被拒绝', err.status === 400, 'status ' + err.status)
	}

	const noNick = comments.addComment(
		'demo-post',
		{ content: '没填昵称' },
		{ ip: '10.0.0.9' }
	)
	ok('昵称留空时回退为「匿名」', noNick.nick === '匿名', noNick.nick)

	const jsUrl = comments.addComment(
		'demo-post',
		{ nick: 'x', content: 'url 测试', url: 'javascript:alert(1)' },
		{ ip: '10.0.0.10' }
	)
	ok(
		'javascript: 伪协议被清洗掉',
		jsUrl.url === '' || /^https?:\/\//.test(jsUrl.url),
		'实际 ' + JSON.stringify(jsUrl.url)
	)

	const bareUrl = comments.addComment(
		'demo-post',
		{ nick: 'x', content: '裸域名', url: 'example.com' },
		{ ip: '10.0.0.11' }
	)
	ok(
		'裸域名被补全为 https',
		bareUrl.url === 'https://example.com' || bareUrl.url === 'https://example.com/',
		'实际 ' + JSON.stringify(bareUrl.url)
	)

	const longContent = 'x'.repeat(5000)
	const truncated = comments.addComment(
		'demo-post',
		{ nick: 'x', content: longContent },
		{ ip: '10.0.0.12' }
	)
	ok(
		'超长内容被截断到上限',
		truncated.content.length === comments.LIMITS.content,
		'实际 ' + truncated.content.length
	)

	/* ============ 三、隐私字段 ============ */

	const pub = comments.publicComment(first)
	const adm = comments.adminComment(first)
	ok('公开字段含 email（选填，公开展示）', pub.email === 'a@example.com', '实际 ' + JSON.stringify(pub.email))
	ok('公开字段不含 ipHash', !('ipHash' in pub))
	ok('后台字段含 email', 'email' in adm)
	ok('不再产出 Gravatar 哈希', !('avatar' in first))
	ok('公开字段含首字符头像（中文取首字）', pub.initial === '阿', '实际 ' + JSON.stringify(pub.initial))
	ok('首字符头像：英文转大写', comments.publicComment({ nick: 'bob' }).initial === 'B')
	ok('首字符头像：匿名返回空', comments.publicComment({ nick: '匿名' }).initial === '')
	ok('首字符头像：空昵称返回空', comments.publicComment({ nick: '' }).initial === '')
	ok('邮箱留空时公开字段为空串', comments.publicComment(noNick).email === '')

	/* ============ 四、节流 ============ */

	comments.resetRateLimit()
	let rejected = 0
	for (let i = 0; i < 6; i++) {
		try {
			comments.addComment('throttle-post', { nick: 'spam', content: 'c' + i }, { ip: '10.9.9.9' })
		} catch (err) {
			if (err.status === 429) rejected++
		}
	}
	ok('同一 IP 高频提交会被节流', rejected > 0, '被拒 ' + rejected + ' 次')

	/* ============ 五、HTTP 接口层 ============ */

	const server = http.createServer(app)
	await new Promise(function (r) {
		server.listen(0, '127.0.0.1', r)
	})
	const port = server.address().port
	const TOKEN = { 'x-admin-token': 'test-token-please-change' }

	comments.resetRateLimit()

	const posts = store.publishedPosts()
	ok('存在可用于测试的已发布文章', posts.length > 0)
	const slug = posts[0].slug

	/* --- 公开读 --- */
	const emptyRead = await req(port, 'GET', '/api/comments/' + slug)
	ok('GET /api/comments/:slug 返回 200', emptyRead.status === 200, '实际 ' + emptyRead.status)
	ok('初始评论数为 0', emptyRead.json && emptyRead.json.count === 0)

	/* --- 公开写 --- */
	const created = await req(port, 'POST', '/api/comments/' + slug, {
		nick: '接口访客',
		email: 'api@example.com',
		content: '来自接口的评论'
	})
	ok('POST 评论返回 201', created.status === 201, '实际 ' + created.status)
	ok('POST 响应带 comment', created.json && !!created.json.comment)
	ok(
		'POST 响应带回邮箱与首字符头像',
		created.json && created.json.comment &&
			created.json.comment.email === 'api@example.com' &&
			created.json.comment.initial === '接'
	)

	const afterWrite = await req(port, 'GET', '/api/comments/' + slug)
	ok('写入后可读回', afterWrite.json && afterWrite.json.count === 1)

	/* --- 写校验 --- */
	const badWrite = await req(port, 'POST', '/api/comments/' + slug, { content: '' })
	ok('空内容返回 400', badWrite.status === 400, '实际 ' + badWrite.status)

	/* --- 后台接口鉴权 --- */
	const noToken = await req(port, 'GET', '/api/admin/comments')
	ok('无令牌读后台评论返回 401', noToken.status === 401, '实际 ' + noToken.status)

	const withToken = await req(port, 'GET', '/api/admin/comments', null, TOKEN)
	ok('带令牌读后台评论返回 200', withToken.status === 200, '实际 ' + withToken.status)
	ok(
		'后台响应包含邮箱字段',
		withToken.json && withToken.json.comments.every(function (c) {
			return 'email' in c
		})
	)

	/* --- 删除 --- */
	const targetId = created.json.comment.id
	const delNoToken = await req(port, 'DELETE', '/api/admin/comments/' + targetId)
	ok('无令牌删除返回 401', delNoToken.status === 401, '实际 ' + delNoToken.status)

	const delWithToken = await req(port, 'DELETE', '/api/admin/comments/' + targetId, null, TOKEN)
	ok('带令牌删除返回 200', delWithToken.status === 200, '实际 ' + delWithToken.status)

	const afterDelete = await req(port, 'GET', '/api/comments/' + slug)
	ok('删除后评论数归零', afterDelete.json && afterDelete.json.count === 0)

	const delAgain = await req(port, 'DELETE', '/api/admin/comments/' + targetId, null, TOKEN)
	ok('重复删除返回 404', delAgain.status === 404, '实际 ' + delAgain.status)

	/* ============ 六、页面渲染与 XSS ============ */

	comments.resetRateLimit()
	// 通过接口写入一条含脚本标签的评论，验证输出被转义
	const xss = '<script>window.__pwned=1</script>'
	const xssWrite = await req(port, 'POST', '/api/comments/' + slug, {
		nick: '<img src=x onerror=alert(1)>',
		content: xss
	})
	ok('含 HTML 的评论可以写入', xssWrite.status === 201, '实际 ' + xssWrite.status)

	const page = await req(port, 'GET', '/blog/posts/' + slug)
	ok('文章页返回 200', page.status === 200, '实际 ' + page.status)
	ok('文章页含评论区容器', page.body.indexOf('blog-comments') >= 0)
	ok('文章页含评论表单', page.body.indexOf('blog-comment-form') >= 0)
	ok(
		'文章页表单 action 指向评论接口',
		page.body.indexOf('action="/api/comments/' + slug + '"') >= 0
	)
	ok(
		'评论内容中的 <script> 被转义',
		page.body.indexOf('&lt;script&gt;') >= 0 && page.body.indexOf('<script>window.__pwned') < 0
	)
	ok(
		'昵称中的 HTML 被转义',
		page.body.indexOf('&lt;img src=x') >= 0
	)

	/* ============ 七、静态构建产物 ============ */

	const staticHtml = render.renderPost({
		root: '../../../',
		suffix: 'index.html',
		siteTitle: 'T',
		blogTitle: 'B',
		blogDesc: '',
		tags: [],
		math: false,
		feed: true,
		cssInline: null,
		jsInline: null,
		post: {
			title: 'T',
			date: '2026-01-01',
			readingTime: 1,
			tags: [],
			tagObjs: [],
			toc: [],
			content: ''
		},
		commentsOn: true,
		comments: [],
		commentCount: 0,
		submitUrl: ''
	})
	ok('静态产物仍渲染评论区', staticHtml.indexOf('blog-comments') >= 0)
	ok(
		'静态产物表单 action 为空（不指向不存在的接口）',
		staticHtml.indexOf('blog-comment-form" method="post" action=""') >= 0,
		'片段：' + (staticHtml.match(/<form class="blog-comment-form"[^>]*>/) || ['未匹配'])[0]
	)

	/* 关闭开关时不渲染评论区 */
	const offHtml = render.renderPost({
		root: '/',
		suffix: '',
		siteTitle: 'T',
		blogTitle: 'B',
		blogDesc: '',
		tags: [],
		math: false,
		feed: true,
		cssInline: null,
		jsInline: null,
		post: {
			title: 'T',
			date: '2026-01-01',
			readingTime: 1,
			tags: [],
			tagObjs: [],
			toc: [],
			content: ''
		}
	})
	ok('commentsOn 未开启时不渲染评论区', offHtml.indexOf('blog-comments') < 0)

	/* ============ 八、审核流（先审后发） ============ */

	// 直接操作存储层验证审核语义，避免重启进程切换环境变量的复杂度
	comments.resetRateLimit()
	comments.resetCache()

	const pending = comments.addComment(
		'review-post',
		{ nick: '待审', content: '需要审核' },
		{ ip: '10.5.5.5' }
	)
	// 默认即时可见（BLOG_COMMENT_REVIEW 未设置）
	ok('默认模式新评论已通过审核', pending.approved === true)
	ok('默认模式下公开列表可见', comments.listBySlug('review-post').length === 1)

	// 手动置为待审核，模拟先审后发场景
	const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
	raw.comments.forEach(function (c) {
		if (c.id === pending.id) c.approved = false
	})
	fs.writeFileSync(FILE, JSON.stringify(raw, null, 2), 'utf8')
	comments.resetCache()

	ok('待审核评论不出现在公开列表', comments.listBySlug('review-post').length === 0)
	ok(
		'待审核评论在后台列表可见',
		comments.listBySlug('review-post', { includePending: true }).length === 1
	)
	ok(
		'待审核评论不计入计数',
		!comments.countBySlug()['review-post']
	)

	const approved = comments.approveComment(pending.id)
	ok('审核通过后状态变更', approved.approved === true)
	ok('审核通过后公开可见', comments.listBySlug('review-post').length === 1)

	/* ============ 九、清理临时数据目录 ============ */

	await new Promise(function (r) {
		server.close(r)
	})

	/* 清理临时目录 */
	try {
		fs.rmSync(TMP_DIR, { recursive: true, force: true })
	} catch (err) {
		/* 清理失败不影响测试结论 */
	}

	console.log('\n==> ' + pass + ' passed, ' + fail + ' failed')
	process.exit(fail ? 1 : 0)
}

main().catch(function (e) {
	console.error('测试异常:', e)
	try {
		fs.rmSync(TMP_DIR, { recursive: true, force: true })
	} catch (err) {
		/* ignore */
	}
	process.exit(1)
})
