/**
 * 主页（dist/index.html）结构回归测试。
 *
 * 起因（真实 bug）：src/components/main.pug 里第五、第六个导航项
 *   （Blog / Games）的 `if fifth` / `if sixth` 缩进与 `ul` 平级，
 *   导致这两个 <li> 被渲染到 <ul> **外面**。
 *   结果：它们不再是 ul 的 flex 子项，拿不到 `list-style: none`，
 *   变成带项目符号的独立块，与前面四个按钮挤在一起，显示错乱。
 *
 * 这类缩进错误在代码评审里几乎看不出来（pug 的层级只由空格决定），
 * 所以这里把它固化成断言：文档里不允许存在「不在 ul/ol 里的 li」。
 *
 * 运行：node scripts/test-home-nav.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PAGE = path.join(ROOT, 'dist', 'index.html')
const config = require(path.join(ROOT, 'config.json'))

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

if (!fs.existsSync(PAGE)) {
	console.error('缺少构建产物：' + path.relative(ROOT, PAGE) + '，请先执行 npx gulp build')
	process.exit(1)
}

const html = fs.readFileSync(PAGE, 'utf8')

/* ---------------- 1. 所有 li 必须在列表容器内 ---------------- */

const totalLi = (html.match(/<li[\s>]/g) || []).length
let liInList = 0
const listBlocks = html.match(/<(ul|ol)[\s>][\s\S]*?<\/\1>/g) || []
listBlocks.forEach(function (block) {
	liInList += (block.match(/<li[\s>]/g) || []).length
})

ok('主页存在导航列表 <ul>', listBlocks.length >= 1, '找到 ' + listBlocks.length + ' 个')
ok(
	'所有 <li> 都位于 <ul>/<ol> 内部（不允许游离的列表项）',
	totalLi === liInList,
	'共 ' + totalLi + ' 个 <li>，其中 ' + liInList + ' 个在列表内，游离 ' + (totalLi - liInList) + ' 个'
)

/* ---------------- 2. 导航项数量与 config 对齐 ---------------- */

const navKeys = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']
const configured = navKeys
	.map(function (k) {
		return config.main.ul[k]
	})
	.filter(Boolean)

const navUl = listBlocks.find(function (b) {
	return b.indexOf('aria-label') >= 0
})
ok('能定位到导航 <ul>', !!navUl)

const navLis = navUl ? navUl.match(/<li[\s>][\s\S]*?<\/li>/g) || [] : []
ok(
	'导航按钮数量与 config.main.ul 一致',
	navLis.length === configured.length,
	'渲染 ' + navLis.length + ' 个，配置 ' + configured.length + ' 个'
)

/* ---------------- 3. 每个按钮的链接与文案来自 config ---------------- */

configured.forEach(function (item, index) {
	const li = navLis[index] || ''
	const hasHref = li.indexOf('href="' + item.href + '"') >= 0
	const hasText = li.indexOf('>' + item.text + '<') >= 0
	const hasIcon = li.indexOf('icon-' + item.icon) >= 0
	ok(
		'第 ' + (index + 1) + ' 个按钮（' + item.text + '）链接/文案/图标正确',
		hasHref && hasText && hasIcon,
		'[' + (hasHref ? 'href✓' : 'href✗') + ' ' + (hasText ? 'text✓' : 'text✗') +
			' ' + (hasIcon ? 'icon✓' : 'icon✗') + ']'
	)
})

/* ---------------- 4. 图标类名有对应样式定义 ---------------- */

const iconCss = fs.readFileSync(path.join(ROOT, 'dist', 'css', 'style.css'), 'utf8')
const iconNames = configured
	.map(function (i) {
		return i.icon
	})
	.filter(function (name, i, arr) {
		return arr.indexOf(name) === i
	})
const missingIcons = iconNames.filter(function (name) {
	// iconfont 字形用 .icon-x:before，内联 svg 用 .icon-x { svg {...} }
	return (
		iconCss.indexOf('.icon-' + name + ':before') < 0 &&
		iconCss.indexOf('.icon-' + name) < 0
	)
})
ok(
	'每个导航图标都有对应的样式定义',
	missingIcons.length === 0,
	missingIcons.length ? '缺少: ' + missingIcons.join(', ') : ''
)

/* ---------------- 5. 静态资源引用的大小写必须与文件一致 ---------------- */

// Windows 文件系统大小写不敏感，写错大小写本地也能跑；
// 但部署到 Linux 会 404，所以这里按真实文件名逐个核对。
const assetRefs = html.match(/(?:src|href)="(assets\/[^"]+)"/g) || []
const wrongCase = assetRefs
	.map(function (ref) {
		return ref.replace(/^(?:src|href)="/, '').replace(/"$/, '')
	})
	.filter(function (rel) {
		const dir = path.dirname(path.join(ROOT, 'dist', rel))
		const base = path.basename(rel)
		if (!fs.existsSync(dir)) return true
		const names = fs.readdirSync(dir)
		// 大小写完全一致才算命中
		return names.indexOf(base) < 0
	})
ok(
	'assets 引用的大小写与磁盘文件名一致（避免 Linux 上 404）',
	wrongCase.length === 0,
	wrongCase.length ? '不匹配: ' + wrongCase.join(', ') : ''
)

console.log('\n==> ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
