# SciHub · 项目协作说明

本文件是仓库级说明，不是某个研究项目的 AI 记忆。每个研究项目自己的记忆文件位于：

`科研项目/<项目名称>/AGENTS.md`

## 产品范围

SciHub 是本地优先的科研记录工具，仅提供：

- 项目化实验日志
- 项目化 AI 对话记录（含手动记录与导入）
- 项目记忆（`README.md` 与 `AGENTS.md`）
- 可选的 AI 接口设置，用于润色日志或基于项目记忆继续对话

不再维护概览、知识卡片、参考文献或浏览器本地对话库等界面功能。

## 运行

- 双击 `启动 SciHub.cmd`，或运行 `D:\LeStoreDownload\Anaconda\python.exe scihub_server.py`。
- 服务地址为 `http://127.0.0.1:8770/index.html`，仅监听 `127.0.0.1`。
- 依赖仅为 Python 3 标准库；前端不需要构建步骤或 CDN。
- `SCIHUB_NO_BROWSER=1` 可禁止启动时自动打开浏览器，便于测试。

## 代码结构

- `scihub_server.py`：本地 HTTP 服务与项目、日志、对话、项目记忆、AI 转发 API；日志导出接口为 `/api/projects/<slug>/logs/<date>/export`，DOCX 导入接口为 `/api/projects/<slug>/logs/<date>/import`。
- `index.html`：只包含实验日志、对话记录、项目记忆三个视图。
- `app.js`：轻量导航、提示消息和项目创建入口。
- `records.js`：项目、Markdown 文件和三个核心视图的逻辑；也负责 GPT、Gemini、Claude、DeepSeek 的 AI 设置、当前表单配置的连通性测试、GPT / DeepSeek 原生推理强度、单输入框的自动日志整理、DOCX/Markdown/文本导入、Markdown 导出和 `AGENTS.md` 预览。
- `styles.css`：现有鼠尾草绿主题及界面样式。

## 数据约定

- 用户资料默认写入 `科研项目/`，也可写入用户创建或编辑项目时选择的本地项目文件夹；项目生成内容全部使用 `.md` 文件。外部项目位置仅登记在 `科研项目/SciHub项目位置索引.md`，该目录在 `.gitignore` 中，不能提交到本仓库。
- 项目记忆导出到项目文件夹内的 `sciMemory/项目记忆.md`；旧版 `scihub-memory/` 仅为兼容读取，不会自动移动或删除。
- 项目 `AGENTS.md` 用 `<!-- AUTO-UPDATE:START -->` 和 `<!-- AUTO-UPDATE:END -->` 标识自动区域；区域外的人工信息必须保留。
- 保存实验日志、对话或项目记忆后，都应更新项目 `AGENTS.md` 的自动区域。
- `AGENTS.md` 是 AI 上下文，不等同于已验证的科研结论；需区分原始观察、模型建议和已验证证据。
- AI 自动整理与润色只允许修正错别字、语病、表达和结构；不得改变实验原意、事实、数据、条件、现象或不确定性。原始输入必须与自动生成板块一同保留在日志 Markdown 中。
- DOCX 导入仅提取文本和内嵌图片元数据（文件名、类型、大小）；不得额外写入图片二进制文件，确保项目生成内容保持 Markdown 为主。
