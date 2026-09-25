/**
 * 把服务端权威的规则模块同步一份到 src/js/，供 gulp 编译并在页面内联。
 * 规则只有一份真实来源：lib/gomoku3d-rules.js。
 * 运行：npm run sync-rules
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'lib', 'gomoku3d-rules.js')
const DEST = path.join(ROOT, 'src', 'js', 'gomoku3d-rules.js')

const HEADER =
	'/* 由 lib/gomoku3d-rules.js 同步而来，请勿直接编辑；\n' +
	'   修改请改 lib 下的源文件，然后运行 npm run sync-rules */\n'

const code = fs.readFileSync(SRC, 'utf8')
fs.writeFileSync(DEST, HEADER + code, 'utf8')

console.log(
	'[sync-rules] -> ' +
		path.relative(ROOT, DEST).replace(/\\/g, '/') +
		' (' +
		(HEADER + code).length +
		' bytes)'
)
