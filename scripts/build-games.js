/**
 * 游戏模块静态构建。
 *
 * 与 build-blog.js 保持同一套约定：
 *   - 内容来自 config.json 的 games.catalog，模板只负责排版；
 *   - css/js 已编译产物内联进页面，产物不依赖相对路径，file:// 与任意静态根都能渲染；
 *   - 产物未生成时（例如单独执行 `node scripts/build-games.js`）回退为外链。
 *
 * 产出：
 *   dist/games/index.html            游戏列表（导航）
 *   dist/games/gomoku3d/index.html   三维连珠对局页
 */
const fs = require('fs')
const path = require('path')

const render = require('../lib/render')
const Rules = require('../lib/gomoku3d-rules')

const ROOT = render.ROOT
const OUT_DIR = path.join(ROOT, 'dist', 'games')
const DIST_DIR = path.join(ROOT, 'dist')

const config = require(path.join(ROOT, 'config.json'))
const gamesConf = config.games || {}

// 三维连珠依赖 three.js（CDN 全局 THREE），与项目既有 CDN 引入习惯一致
const THREE_URL =
	'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js'

function ensureDir (dir) {
	fs.mkdirSync(dir, { recursive: true })
}

function readAsset (relPath, forbidden) {
	const file = path.join(DIST_DIR, relPath)
	if (!fs.existsSync(file)) return null
	const content = fs.readFileSync(file, 'utf8')
	if (forbidden && content.indexOf(forbidden) >= 0) return null
	return content
}

function buildNav (catalog, cssInline, jsInline) {
	const title = gamesConf.title || 'Games'
	const html = render.renderGames({
		// 静态产物位于 /games/index.html，站点根需上溯一级
		root: '../',
		homeHref: 'index.html',
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
		cssInline: cssInline,
		jsInline: jsInline
	})
	fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html, 'utf8')
}

function buildGomoku3D (cssInline) {
	const jsInline = readAsset('js/game3d.js', '</script')
	if (!jsInline) {
		console.warn('[games] 未找到 dist/js/game3d.js，回退为外链（请先执行 gulp js）')
	}
	const rulesInline = readAsset('js/gomoku3d-rules.js', '</script')
	if (!rulesInline) {
		console.warn(
			'[games] 未找到 dist/js/gomoku3d-rules.js，回退为外链（请先执行 gulp js）'
		)
	}

	const html = render.renderGomoku3D({
		root: '../../',
		suffix: 'index.html',
		title: '三维连珠 · ' + (gamesConf.title || config.head.title),
		description:
			'N³ 立方棋盘上的 M 子连珠，双方输入 (x, y, z) 坐标落子，13 个方向判定胜负，支持房间号联机。',
		gameTitle: '三维连珠',
		gameSub: 'N³ 立方棋盘 · 坐标落子 · 13 个方向判定 · 房间号联机',
		axes: Rules.AXES,
		cssInline: cssInline,
		jsInline: jsInline,
		rulesInline: rulesInline,
		rulesSrc: 'js/gomoku3d-rules.js',
		extraCss: 'css/game3d.css',
		extraHead: '<script src="' + THREE_URL + '"></script>'
	})

	const dir = path.join(OUT_DIR, 'gomoku3d')
	ensureDir(dir)
	fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8')
}

function build () {
	const catalog = render.buildGamesCatalog(gamesConf.catalog)

	fs.rmSync(OUT_DIR, { recursive: true, force: true })
	ensureDir(OUT_DIR)

	const navCss = readAsset('css/games.css', '</style')
	const navJs = readAsset('js/games.js', '</script')
	if (!navCss) {
		console.warn('[games] 未找到 dist/css/games.css，回退为外链（请先执行 gulp css）')
	}
	if (!navJs) {
		console.warn('[games] 未找到 dist/js/games.js，回退为外链（请先执行 gulp js）')
	}

	buildNav(catalog, navCss, navJs)
	buildGomoku3D(readAsset('css/game3d.css', '</style'))

	console.log(
		'[games] ' +
			catalog.list.length +
			' 个条目，' +
			catalog.categories.length +
			' 个分类，2 个页面 -> ' +
			path.relative(ROOT, OUT_DIR).replace(/\\/g, '/')
	)

	return { games: catalog.list, categories: catalog.categories }
}

module.exports = build
module.exports.build = build

if (require.main === module) {
	Promise.resolve()
		.then(build)
		.catch(function (err) {
			console.error('[games] 构建失败:', err)
			process.exit(1)
		})
}
