/**
 * 路由层回归测试：验证「游戏列表页的卡片链接不会因为 URL 缺少结尾斜杠而 404」。
 *
 * 背景（真实 bug）：
 *   config.json 里游戏条目的 href 是相对路径 "gomoku3d/"，模板直接把它写进 <a href>。
 *   从 /games/ 打开时浏览器解析为 /games/gomoku3d/（正确）；
 *   但直接从 /games 打开时，浏览器以 / 为基准解析成 /gomoku3d/，落到 404。
 *   Express 默认 strict routing 关闭，/games 与 /games/ 会命中同一个 handler，
 *   所以必须在 handler 里显式把不带斜杠的地址 301 到带斜杠的规范形式。
 *
 * 运行：node scripts/test-routes.js
 */
const http = require('http')
const app = require('../server/app')

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

/** 发一个不自动跟随重定向的 GET */
function get (port, path) {
	return new Promise(function (resolve, reject) {
		const req = http.request(
			{ host: '127.0.0.1', port: port, path: path, method: 'GET' },
			function (res) {
				let body = ''
				res.setEncoding('utf8')
				res.on('data', function (chunk) {
					body += chunk
				})
				res.on('end', function () {
					resolve({
						status: res.statusCode,
						location: res.headers.location || '',
						body: body
					})
				})
			}
		)
		req.on('error', reject)
		req.end()
	})
}

async function main () {
	const server = http.createServer(app)
	await new Promise(function (r) {
		server.listen(0, '127.0.0.1', r)
	})
	const port = server.address().port

	/* ---------- 1. 列表页 URL 规范化 ---------- */
	const gamesNoSlash = await get(port, '/games')
	ok('GET /games 返回 301', gamesNoSlash.status === 301, '实际 ' + gamesNoSlash.status)
	ok(
		'GET /games 重定向到 /games/',
		/\/games\/$/.test(gamesNoSlash.location),
		gamesNoSlash.location
	)

	const gamesSlash = await get(port, '/games/')
	ok('GET /games/ 返回 200', gamesSlash.status === 200, '实际 ' + gamesSlash.status)

	/* ---------- 2. 卡片链接必须是绝对可解析的 ---------- */
	// 关键断言：从 /games（无斜杠）出发也能正确跳到对局页。
	// 相对链接 "gomoku3d/" 会被解析成 /gomoku3d/，所以这里必须是 /games/gomoku3d/。
	const cardHrefs = gamesSlash.body.match(/<a class="games-item-link"[^>]*href="([^"]*)"/g) || []
	ok('列表页渲染出至少一个游戏卡片链接', cardHrefs.length > 0)
	ok(
		'卡片链接指向 /games/gomoku3d/（不再依赖结尾斜杠）',
		cardHrefs.length > 0 && cardHrefs.join('').indexOf('href="/games/gomoku3d/"') >= 0,
		cardHrefs.join(' | ')
	)

	/* ---------- 3. 对局页 URL 规范化 ---------- */
	const playNoSlash = await get(port, '/games/gomoku3d')
	ok('GET /games/gomoku3d 返回 301', playNoSlash.status === 301, '实际 ' + playNoSlash.status)
	ok(
		'GET /games/gomoku3d 重定向到 /games/gomoku3d/',
		/\/games\/gomoku3d\/$/.test(playNoSlash.location),
		playNoSlash.location
	)

	const playSlash = await get(port, '/games/gomoku3d/')
	ok('GET /games/gomoku3d/ 返回 200', playSlash.status === 200, '实际 ' + playSlash.status)
	ok('对局页含画布 #canvas3d', playSlash.body.indexOf('id="canvas3d"') >= 0)

	/* ---------- 4. 记录旧行为的失败面（防止误以为该路径可用） ---------- */
	const legacy = await get(port, '/gomoku3d/')
	ok('GET /gomoku3d/ 仍是 404（该路径从未存在）', legacy.status === 404, '实际 ' + legacy.status)

	/* ---------- 5. 回归：规范化不能破坏其它路由 ---------- */
	// 注意：Express 默认 strict routing 关闭，/timer 与 /timer/ 必须都可用，
	// 因为主页链接写的是相对路径 "timer/"。
	const root = await get(port, '/')
	ok('GET / 返回 200', root.status === 200, '实际 ' + root.status)
	ok(
		'主页 Timer 链接仍是相对路径 timer/',
		root.body.indexOf('href="timer/"') >= 0
	)
	ok('GET /timer 返回 200', (await get(port, '/timer')).status === 200)
	ok('GET /timer/ 返回 200（strict routing 保持关闭）', (await get(port, '/timer/')).status === 200)
	ok('GET /blog/ 返回 200', (await get(port, '/blog/')).status === 200)
	ok('GET /blog 返回 200', (await get(port, '/blog')).status === 200)

	/* ---------- 6. 查询串在重定向中不丢失 ---------- */
	const withQuery = await get(port, '/games?cat=Board')
	ok(
		'GET /games?cat=Board 重定向时保留查询串',
		withQuery.status === 301 && withQuery.location.indexOf('cat=Board') >= 0,
		withQuery.status + ' ' + withQuery.location
	)

	await new Promise(function (r) {
		server.close(r)
	})

	console.log('\n==> ' + pass + ' passed, ' + fail + ' failed')
	process.exit(fail ? 1 : 0)
}

main().catch(function (e) {
	console.error('测试异常:', e)
	process.exit(1)
})
