---
title: 这个 Blog 是怎么搭起来的
date: 2026-09-13
tags: [meta, build-tools]
summary: 用 markdown-it + KaTeX 在 Gulp 静态站上做一个零后端的博客模块，支持标签与标题检索。
---

这个站点原本是一个纯静态的单页：Gulp 4 负责把 `src/` 下的 Pug、Less、Babel 编译到 `dist/`，部署时由 express 直接托管静态文件。没有后端，也没有数据库。

所以博客模块的技术选择其实很有限——**Markdown 与 LaTeX 必须在构建阶段就渲染成 HTML**。

## 渲染管线

构建脚本 `scripts/build-blog.js` 做四件事：

1. 用 `gray-matter` 解析每篇文章的 front-matter，拿到标题、日期、标签；
2. 用 `markdown-it` 把正文渲染成 HTML，`highlight.js` 负责代码高亮；
3. 用 `@vscode/markdown-it-katex` 把 `$...$` 和 `$$...$$` 渲染成 KaTeX；
4. 套 Pug 模板，输出静态页与 `posts.json` 索引。

```js
const md = new MarkdownIt({ html: true, linkify: true, highlight })
md.use(anchorPlugin, { slugify, permalink: false })
md.use(katexPlugin, { throwOnError: false })
```

## 为什么不做客户端渲染

把 `markdown-it` 和 `katex` 塞进浏览器当然更简单，但代价是要额外下载约 250KB 的 JS，而且首屏必须等 JS 执行完才能看到正文。构建期渲染之后，浏览器拿到的就是纯 HTML。

## 检索

标签与标题检索都在浏览器里完成，直接过滤 DOM 节点：

```js
const ok = (!activeTag || tags.indexOf(activeTag) >= 0) &&
           (!query || title.indexOf(query) >= 0 || summary.indexOf(query) >= 0)
item.style.display = ok ? '' : 'none'
```

个人博客的文章量级下，这种朴素匹配是微秒级的，不需要引入 Lunr 或 Fuse.js。

## 下一步

- [x] Markdown 与 LaTeX 渲染
- [x] 标签与标题检索
- [ ] 全文搜索
- [ ] 评论
