# XDomHatter Web Page

> 一个「静态首页 + 动态博客 + 联机小游戏」三合一的个人网站。
>
> 首页基于 [SimonAKing/HomePage](https://github.com/SimonAKing/HomePage) 的 Gulp + Pug + Less 流体动画方案，在此基础上扩展出博客模块、评论系统、游戏中心与 Node 服务端。

[在线访问](http://xdomhatter.cn) · [问题反馈](https://github.com/XDomHatter/xdomhatter-web/issues)

## 功能特性

**首页**
- WebGL 流体模拟动画背景，响应式设计，移动端可用
- 所有展示内容由 `config.json` 一处配置驱动（标题、签名、导航图标等）
- Gulp 4 构建管线：Pug / Less / Babel 编译压缩，产物体积极小

**博客 `/blog`**
- 文章以 Markdown 文件为数据源（`src/blog/posts/*.md`），front-matter 声明标题、日期、标签、摘要
- `markdown-it` + KaTeX 数学公式 + highlight.js 代码高亮 + 标题锚点
- 标签索引与筛选、文章检索、阅读时长估算
- 评论系统：无需注册即可评论，支持回复、节流限频、IP 加盐哈希落盘、先审后发（可选）
- RSS 订阅（`/blog/feed.xml`）与 JSON 索引（`/blog/posts.json`）
- 同一套渲染管线支持两种模式：纯静态构建 或 服务端请求时渲染（见下文「两种运行模式」）

**游戏中心 `/games`**
- 游戏目录由 `config.json` 驱动，支持搜索、分类筛选与计数
- 内置 [三维连珠（Gomoku3D）](http://xdomhatter.cn/games/gomoku3d/)：N³ 立方棋盘上的 M 子连珠，13 条方向（含体对角线）全部判胜，three.js 渲染
- 联机对战：4 位数字房间号邀请加入，服务端权威裁决落子与胜负，断线重连、单步限时、超时判负

**服务端与管理后台**
- Express 单进程同时承载：静态资源、动态博客、评论接口、游戏 WebSocket（`/ws/gomoku3d`）
- `/admin` 后台：文章增删改查、Markdown 实时预览、评论审核与删除，全部接口由令牌鉴权

## 快速开始

```sh
git clone https://github.com/XDomHatter/xdomhatter-web.git
cd xdomhatter-web
npm install

npm run dev      # 开发模式：构建 + watch + livereload，浏览器打开 http://localhost:8080
```

生产运行（完整功能：动态博客、评论、联机对战）：

```sh
npm run build
BLOG_ADMIN_TOKEN=你的令牌 npm start   # 默认监听 80 端口，可用 XDHPAGE_PORT 改
```

然后访问：

| 路径 | 说明 |
| --- | --- |
| `/` | 首页 |
| `/blog` | 博客（文章列表、标签、检索） |
| `/games` | 游戏中心 |
| `/games/gomoku3d/` | 三维连珠（支持房间号联机） |
| `/timer` | 计时器 |
| `/admin` | 管理后台（需 `BLOG_ADMIN_TOKEN`） |

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 构建 + watch + livereload（:8080），改动 `src/` 自动增量重建 |
| `npm run build` | 一次性构建全部产物到 `dist/` |
| `npm start` | 启动完整站点服务（Express + WebSocket），默认端口 80 |
| `npm run serve` | 仅静态托管 `dist/`（:80），无博客动态渲染与评论 |
| `npm run blog` / `npm run games` | 单独构建博客 / 游戏页面 |
| `npm run sync-rules` | 将 `lib/gomoku3d-rules.js` 同步到 `src/js/`（改规则后必跑） |
| `npm test` | 运行全部单元测试（规则、对局、渲染、路由、评论等 7 组） |
| `npm run test:live` | 联机冒烟测试：真实开一局从创建房间下到分出胜负 |

## 两种运行模式

博客渲染核心在 `lib/render.js`，静态构建与动态服务共用同一条 Markdown / KaTeX 管线，行为完全一致：

1. **纯静态模式**：`npm run build` 把所有文章预渲染成 `dist/blog/` 下的 HTML（含 `posts.json` 与 `feed.xml`）。静态产物同样展示已有评论，但没有可用的提交接口。适合部署到 GitHub Pages 等任意静态托管。
2. **动态模式**（`npm start`）：`server/app.js` 在请求时实时渲染 Markdown，评论读写、后台管理、联机对局全部可用。修改 `src/blog/posts/` 下的文件立即生效，无需重新构建。

## 写博客

在 `src/blog/posts/` 下新建 `YYYY-MM-DD-slug.md`：

```markdown
---
title: 文章标题
date: 2026-09-13
tags: [meta, build-tools]
summary: 一句话摘要，显示在列表页与 RSS 中。
---

正文支持 GFM、代码高亮与行内/块级数学公式：$E = mc^2$
```

- 文件名中日期之后的路径即文章 slug（如 `2026-09-13-hello-blog.md` → `/blog/posts/hello-blog`）
- 加 `draft: true` 的文章不会发布
- 动态模式下也可以直接在 `/admin` 后台写文章与管理评论

## 配置

**站点配置 `config.json`**：`head`（标题/描述/图标）、`intro`（首屏文案与流体背景开关）、`main`（头像、签名、导航链接）、`blog`（标题、站点 URL、评论开关）、`games`（页面文案与游戏目录 `catalog`）。键名与 Pug 组件一一对应，详见文件内注释与 [README-old.md](README-old.md)。

**环境变量**：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `BLOG_ADMIN_TOKEN` | `/admin` 与 `/api` 管理接口的鉴权令牌，**生产环境必须设置** | 未设置时管理接口一律返回 503 |
| `XDHPAGE_PORT` | 服务监听端口 | `80` |
| `BLOG_POSTS_DIR` | 文章目录 | `src/blog/posts/` |
| `BLOG_COMMENTS_DIR` | 评论数据目录 | `data/` |
| `BLOG_COMMENT_REVIEW` | 设为 `1` 开启评论先审后发 | 关闭（即时可见） |
| `BLOG_COMMENT_SALT` | 评论 IP 哈希盐值 | 内置默认值 |

## 目录结构

```
├── config.json            # 全站配置（首页、博客、游戏目录）
├── gulpfile.js            # Gulp 构建管线与本地开发服务
├── src/                   # 源码
│   ├── index.pug          # 首页模板
│   ├── components/        # 首页组件（head / intro / main / scripts）
│   ├── css/               # Less 样式
│   ├── js/                # 前端脚本（流体背景、博客交互、游戏）
│   ├── assets/            # 图片、音频等静态资源
│   ├── timer.html         # 计时器页面
│   ├── blog/              # 博客：posts/*.md + Pug 模板
│   └── games/             # 游戏 Pug 模板
├── lib/                   # 前后端共享模块
│   ├── render.js          # Markdown / Pug 渲染核心（静态与动态共用一条管线）
│   └── gomoku3d-rules.js  # 三维连珠规则（唯一真实来源）
├── scripts/               # 构建脚本与测试脚本
├── server/                # Express 服务端（动态博客、评论、后台、联机对局）
├── data/                  # 运行时数据（评论 JSON）
└── dist/                  # 构建产物
```

## 架构要点

- **单一规则来源**：三维连珠的胜负判定只在 `lib/gomoku3d-rules.js` 维护一份，`npm run sync-rules` 同步给浏览器端，服务端与客户端永远用同一套规则。
- **服务端权威对局**：联机落子的合法性、回合与胜负全部由服务端裁决，客户端只发送意图；房间号 4 位数字，掉线保留座位 60 秒，单步限时 120 秒，空房间 30 分钟回收，无持久化。
- **评论数据安全**：IP 只存加盐哈希；写操作采用「临时文件 + rename」原子落盘；数据文件损坏时降级只读，不覆盖用户数据。
- **产物自包含**：博客与游戏静态页把编译后的 CSS/JS 内联进 HTML，不依赖相对路径，`file://` 与任意静态根下都能正常渲染。

## API 概览

评论（公开）：

- `GET /api/comments/:slug` — 读取某篇文章已通过的评论
- `POST /api/comments/:slug` — 发表评论（节流：同 IP 每分钟 3 条）

管理（需请求头 `x-admin-token`）：

- `GET/POST /api/posts`、`GET/PUT/DELETE /api/posts/:slug` — 文章增删改查
- `POST /api/preview` — Markdown 实时预览
- `GET /api/admin/comments`、`POST /api/admin/comments/:id/approve`、`DELETE /api/admin/comments/:id` — 评论审核与删除

联机对局：WebSocket `ws://<host>/ws/gomoku3d`，协议为 JSON 消息（创建/加入房间、落子、认输等），完整行为见 `server/gomoku3d.js` 与 `scripts/smoke-live.js`。

## 部署

**动态部署（推荐，功能完整）**：构建后以 `npm start` 常驻运行，可用 pm2 / systemd 等守护：

```sh
npm run build
BLOG_ADMIN_TOKEN=你的令牌 XDHPAGE_PORT=3000 pm2 start server/app.js --name xdomhatter-web
```

**纯静态部署**：`npm run build` 后把 `dist/` 目录发布到任意静态托管（GitHub Pages、对象存储等）即可，博客、游戏页面均可正常浏览，仅评论提交与联机对战不可用。

## 测试

```sh
npm test              # 全部 7 组测试：三维连珠规则、对局流程、数学公式渲染、
                      # 路由、落子输入、首页导航、评论模块
npm run test:live     # 联机冒烟：先 npm start，再模拟两名玩家真实下一整局
```

## 致谢

- [SimonAKing/HomePage](https://github.com/SimonAKing/HomePage) — 首页设计与流体动画背景
- [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation/) — WebGL 流体模拟
- [three.js](https://threejs.org/)、[markdown-it](https://github.com/markdown-it/markdown-it)、[KaTeX](https://katex.org/)、[Express](https://expressjs.com/)、[ws](https://github.com/websockets/ws)

## 许可证

[LGPL-3.0](LICENSE)
