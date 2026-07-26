# SciHub · 项目协作说明（AGENTS.md）

面向后续在此仓库工作的人或 AI 的说明。**注意：这是仓库级说明。** 每个具体研究项目还各有一份自动更新的 `AGENTS.md`，位于 `科研项目/<项目>/AGENTS.md`，那才是交给 AI 当作项目记忆的文件。

## 这是什么

本地优先的科研知识工作台。把 AI 对话与知识卡片分开管理，并集成了实验日志 / 对话记录 / 项目记忆三个模块，全部保存为 Markdown 文件，同时为每个项目维护可交给 AI 的 `AGENTS.md`。

## 运行

- 启动：双击「启动 SciHub.cmd」，或 `python scihub_server.py`。
- 地址：`http://127.0.0.1:8770/index.html`，端口 `8770`，仅监听 `127.0.0.1`。
- 依赖：仅 Python 3 标准库，无第三方包，前端无构建、无 CDN。
- 环境变量：`SCIHUB_NO_BROWSER=1` 可禁止自动打开浏览器（用于测试）。

## 代码结构

- `scihub_server.py` — Python HTTP 服务。REST：`/api/projects`（增/查/改）、`/api/projects/<slug>/logs[/<date>]`、`/api/projects/<slug>/conversations[/<id>]`、`/api/projects/<slug>/agents`（GET），以及 `/api/proxy`（转发到 HTTPS 模型接口，绕过 CORS）。同时作为静态文件服务器。
- `index.html` — 单页结构与所有视图容器。
- `app.js` — 原有知识卡片 / 概览逻辑（localStorage）。对外暴露 `window.SciHubApp = { renderAll, toast, escapeHtml, switchView }`。
- `records.js` — 文件后端集成层。对外暴露 `window.SciHubRecords = { projects, renderProjectSidebar, selectProject, openProjectDialog, onViewActivated }`。负责实验日志 / 对话记录 / 项目记忆三视图、AI 设置、AGENTS.md 查看器。
- `styles.css` — 全部样式（鼠尾草绿主题，`--green:#3e6f5b`）。新记录视图样式集中在 `.record-*` / `.agents-preview` 等类。

## 数据与约定

- 用户数据写入 `科研项目/`，均为 `.md`（带 YAML 风格 front-matter）。该目录已被 `.gitignore` 排除，不要提交。
- 项目 slug 允许中文（正则 `^[\w一-鿿-]+$`）；前端请求路径统一用 `encodeURIComponent` 编码。
- 每个项目的 `AGENTS.md` 用 `<!-- AUTO-UPDATE:START -->` / `<!-- AUTO-UPDATE:END -->` 包裹自动区块；区块外的手工内容会被保留。任何保存日志/对话/记忆的操作都会刷新自动区块。
- 界面文案保持中文；与用户沟通用英文。

## 边界

- `AGENTS.md` 是项目上下文，不等同已验证的科研结论；AI 回答须区分原始观察、模型建议与已验证证据。
- 服务不主动联网；仅在用户显式发送且已配置接口时，才把该次消息经本机转发到用户自己的 HTTPS 接口。API Key 仅存于浏览器。
