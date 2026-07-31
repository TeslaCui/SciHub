# SciHub 科研记录工作台

SciHub 是一个本地优先的科研记录工具，只保留四项核心能力：

- **实验方案**：以项目内的版本文件夹和子实验文件夹组织实验设计，并与日志建立明确关联。
- **实验日志**：按日期保存实验过程、观察和结论草稿。
- **对话记录**：新建、手动整理或导入各类 AI 对话，并可携带项目记忆继续提问。
- **项目记忆**：维护项目说明和关键信息，供后续检索或交给 AI 作为上下文。

所有项目资料都保存为可直接阅读和编辑的 Markdown 文件；不会创建专有数据库或锁定你的数据。

## 启动

在 Windows 中双击 [启动 SciHub.cmd](启动%20SciHub.cmd)。脚本会使用本机 Python 启动服务，并在服务就绪后打开：

`http://127.0.0.1:8770/index.html`

保持命令窗口开启即可继续使用；关闭窗口会停止服务。

也可以在此目录手动运行（Windows 已安装 Python Launcher 时）：

```powershell
py -3 .\scihub_server.py
```

启动脚本会依次使用 Windows Python Launcher（`py -3`）和环境变量 `PATH` 中的 `python`，不会依赖某个用户的安装路径。PDF 导入和 Word/PDF 导出需要 `pypdf`、`python-docx` 与 `reportlab`；在新电脑上可运行：

```powershell
py -3 -m pip install pypdf python-docx reportlab
```

若未安装 `py`，请使用 `python` 替换上述命令。启动脚本无法自动找到 Python 时，会让该用户粘贴自己电脑上 `python.exe` 的完整路径；也可预先设置环境变量 `SCIHUB_PYTHON` 为该路径，再双击启动脚本。

## 使用方式

1. 打开“项目主页”，点击“新建项目”，填写项目名称与说明；主页可管理多个彼此独立的研究项目。
2. 点击“进入项目”后，在“实验方案”中新建方案名称和版本（如 V1、V2），并按行录入子实验；每个版本都会保存为项目根目录中的独立文件夹。
3. 在“实验日志”中选择日期、关联的方案与子实验，再在单一输入框填写原始内容，或导入 Word / Markdown / 文本文档。
4. 在“对话记录”中新建、手动整理或导入 AI 对话；每段对话单独保存为 Markdown。
5. 在“项目记忆”中维护项目说明和重要信息。系统会同步更新 `README.md` 与 `AGENTS.md`。
6. 在“AI 设置”中选择 GPT、Gemini、Claude 或 DeepSeek，并选择模型与其原生推理强度。配置 API Key 后，可润色实验日志或把项目 `AGENTS.md` 作为上下文继续对话。

## 实验日志整理、导入与导出

每份日志只有一个“实验日志内容”输入框。默认勾选“保存时使用 AI 自动整理与润色”：点击保存后，SciHub 会保留原始输入，并自动生成“实验现象”和“实验记录”板块。润色允许修正错别字、语病、表达和结构，但不得改变原意、实验事实、数据、条件、现象或不确定性。取消勾选后，原始输入会直接保存为实验记录。

“导入文档”支持 `.docx`、`.md` 和 `.txt`。导入后会自动生成当前日期的日志；Word 内的图片会以文件名、类型和大小写入“导入文档图片信息”板块，项目目录不会额外复制图片二进制文件。

点击“导出 .md”会先保存当前内容，再下载对应日期的 Markdown 实验日志。

选择实验方案后，日志的 Markdown front matter 和正文都会标明“方案名称 · 版本 · 子实验”。同一天记录不同方案或子实验时，SciHub 会保存为不同 Markdown 文件，因而不会把 V1、V2 的记录覆盖或混在一起。

“更新项目记忆 MD”会先更新项目内的 `scihub-memory/项目记忆.md`，再下载同一份完整 Markdown 文件。其中会先以目录树列出项目的 Markdown 文件，再按原目录路径逐一汇总所有内容，因此版本、子实验、日志、对话和导入资料的层级关系都能保留，适合检索或作为后续 AI 对话的上下文。为避免文件无限嵌套，汇总时会排除 `scihub-memory/` 自身。

## 方案目录与附加文件

创建项目时，SciHub 会同时创建固定子文件夹 `scihub-memory/`，其中的 `项目记忆.md` 用于给 Codex 或其他 AI 作为项目上下文读取。新建版本 `V1` 后，目录会直接位于项目根目录：`项目/V1/`。每个子实验是 `V1` 下的独立文件夹；关联到该子实验的日志会保存到它的 `实验日志/` 目录。

方案卡片可编辑方案名称和说明。版本目录保持不变，以确保已有子实验和日志的路径稳定；删除时会先展示该方案目录下的完整文件清单，只有输入版本目录名确认后才会逐项删除。

## 方案文件导入、AI 生成与导出

在已有方案卡片中点击“导入方案文件”，可选择 `.docx`、`.pdf`、`.md`、`.markdown` 或 `.txt`。SciHub 不保存原始 Word/PDF 二进制文件，只把提取出的文字和图片/页面信息转换为 `项目/V1/导入资料/*.md`。随后点击“AI 生成标准方案”，模型会读取这份 Markdown，并生成包含实验目的、设计、材料与仪器、分组变量、操作步骤、记录与数据处理、预期判定、风险和待确认项的可编辑草稿；缺失事实会标为“待补充”，不会被编造。

审核并保存后，方案正文仍写入 `项目/V1/方案.md`。方案卡片还可以按需导出 Word 或 PDF，这些导出文件仅在下载时生成，不会保存到项目目录，因此后台持久化内容始终是 Markdown。

在“对话记录”中，`AGENTS.md` 作为短基线，Conversation Agent 再从本地记忆索引中按当前问题召回相关方案、日志、踩坑和对话片段。勾选“本次同时附带精简项目记忆”会扩大召回范围，但不会默认把整个原始文件树发送给模型。

新建方案时，可将“上一次方案文件”载入为草稿，再使用已配置的 GPT、Gemini、Claude 或 DeepSeek 接口一键润色生成新的实验方案。AI 仅应改善错别字、表达与结构，不会被要求编造实验事实。创建下一版本后，点击“查看版本改动”可逐行对比：上一次方案中删除或替换的内容显示为灰色划线，当前方案新增内容显示为绿色高亮。

## AI 服务商

SciHub 在本机统一转发请求，支持下列服务商的原生消息格式：

- GPT（OpenAI）
- Gemini（Google）
- Claude（Anthropic）
- DeepSeek

模型下拉列表提供常用示例，并支持填写服务商提供的自定义模型 ID。GPT 与 DeepSeek 可选择“模型默认、低、中、高、极高”推理强度；当所选模型原生支持时，SciHub 会发送 `reasoning_effort`。DeepSeek 会启用其官方思考模式，其中低/中映射为高、极高映射为 `max`；Gemini、Claude 当前不使用此参数。

DeepSeek 的当前预设为 `deepseek-v4-pro` 和 `deepseek-v4-flash`；`deepseek-chat` 与 `deepseek-reasoner` 已于 2026-07-24 弃用。若服务商测试提示了其他允许的模型名，请使用“自定义模型”填写错误提示中给出的名称。

填写服务商、模型和 API Key 后，可点击“测试连接”。测试会使用当前表单内容发送一条最短请求，不要求先保存设置，并在窗口中显示成功结果或服务商返回的错误信息。

AI 设置支持“默认配置”和各专职 Agent 的独立配置。未单独配置的 Agent 使用默认模型；日志整理、历史日志导入、方案生成、方案辅助、方案对比、选中文字修改和项目对话可以分别选择服务商、模型、推理强度与 API Key。所有 Key 仍只保存在当前浏览器。

## Agent 路由与项目记忆索引

SciHub 使用进程内的确定性 Router，把明确的界面操作路由给对应 Agent，不使用额外模型判断任务类型。Agent 只获得其任务需要的上下文；项目检索结果作为带来源的参考资料处理，不能改变系统规则或触发文件操作。

SciHub 也提供本地 MCP Memory Gateway。建议为每个 Codex/Claude 项目使用绑定模式启动：`scihub_mcp_server.py --project-dir <项目目录>`。这样工具无需反复传 `projectSlug`，并且进程只能访问这个项目，项目外的 Codex/Claude 对话不会读取或修改它。Codex 或 Claude 可通过 `scihub_memory_context`、`scihub_memory_search` 和 `scihub_memory_read` 按问题读取相关片段，不需要把整个项目文件树一次性发送给模型。MCP 工具只返回当前项目的有限参考资料，并要求保留来源路径和证据状态。

可通过环境变量 `SCIHUB_AGENT_MODE=legacy|shadow|active` 控制切换：`legacy` 强制使用旧调用，`shadow` 同时验证新 Agent 但实际采用旧结果，`active` 使用新 Agent 并仅在本机服务不支持新接口时回退。当前默认是已经过回归验证的 `active`。

项目 Markdown 始终是唯一事实源。`.scihub/memory.sqlite3`、`memory-state.json` 与 `index-status.json` 仅是可重建的派生索引；SQLite 支持 FTS5 时使用全文检索，不支持时自动改用纯 Python 检索。实验相关问题会优先召回 `PITFALLS_SUMMARY.md` 和“实验异常与踩坑点”段落。

本地 Agent 接口为 `POST /api/projects/<slug>/agents/run`；记忆检索、状态和重建接口分别为 `POST .../memory/search`、`GET .../memory/status` 和 `POST .../memory/rebuild`。`GET /api/projects/<slug>/mcp/config` 会返回当前项目专属的 Codex TOML 和 Claude JSON 配置。以上接口是现有日志、方案、对话和 `/api/proxy` 接口之外的兼容扩展。

记忆提取 Agent 会把对话中的候选事实、决策、踩坑或待办追加到 `.scihub/memory-events.jsonl`，不会未经确认写入正式记忆。用户确认后才会生成 `memory/confirmed/*.md` 并刷新索引。长对话达到阈值后可生成 `.scihub/conversation-state.json` 摘要；原始对话 Markdown 不会删除，后续请求默认使用摘要、近期消息和按需检索片段。

Codex 或 Claude 在思考过程中可以调用 `scihub_memory_record` 实时记录候选事实、决定、踩坑或待办；该工具只写入待确认 JSONL。只有用户在 SciHub“待确认记忆”面板中确认，或显式调用 `scihub_memory_confirm` 后，才会写入 `memory/confirmed/*.md`。因此模型可以实时记录，但不能未经确认篡改正式科研资料。

### 外部 AI 与 Google Drive 同步

可将本地 MCP Server 配置到 Codex 或 Claude 的 MCP 设置中（命令路径按本机 Python 修改）。项目绑定配置示例：

```json
{
  "mcpServers": {
    "scihub-memory": {
      "command": "D:\\LeStoreDownload\\Anaconda\\python.exe",
      "args": ["D:\\myApp\\SciHub\\scihub_mcp_server.py", "--project-dir", "D:\\myApp\\SciHub\\科研项目\\<项目 slug>"]
    }
  }
}
```

Codex 的项目配置可参考 [codex-project-config.example.toml](D:/myApp/SciHub/codex-project-config.example.toml)。SciHub 界面或 `GET /api/projects/<slug>/mcp/config` 可生成当前机器的实际路径。绑定配置只服务当前研究项目；其他 Codex 任务、其他工作区和普通对话不受影响。

Google Drive 同步使用 Google Drive for desktop 提供的本地目录。进入“项目记忆”，选择项目专属同步目录后点击“立即同步”。SciHub 使用 SHA-256 清单处理单边变更；双边同时修改时保留双方文件并报告冲突，不自动删除文件。SQLite 索引不上传，另一台设备会从 Markdown 自动重建。

## 文件结构

每个项目位于 `科研项目/<项目名称>/`：

```text
科研项目/<项目名称>/
├── README.md          # 项目说明与重要信息
├── AGENTS.md          # 可提供给 AI 的项目记忆
├── PITFALLS_SUMMARY.md # 保留人工区域的自动踩坑索引
├── memory/              # 用户确认后的正式记忆 Markdown
│   └── confirmed/
├── .scihub/            # 可重建的派生记忆索引，不是事实源
│   ├── memory.sqlite3
│   ├── memory-state.json
│   └── index-status.json
│   ├── memory-events.jsonl       # 待确认记忆事件
│   ├── conversation-state.json   # 对话摘要和指针
│   └── sync-manifest.json        # 本地同步哈希清单
├── V1/
│   ├── 方案.md          # V1 的方案说明
│   ├── 子实验 A/
│   │   ├── README.md    # 子实验说明
│   │   ├── 实验日志/
│   │   │   └── YYYY-MM-DD.md
│   │   └── 分析记录.md  # 可在界面新增
│   └── 附加资料/        # 可在界面新增
├── 实验日志/
│   └── YYYY-MM-DD.md   # 未关联方案的实验日志
└── 对话记录/
    └── c-*.md         # 每段导入或新建的对话
```

`AGENTS.md` 的自动更新区域会随日志、对话和项目记忆的保存而刷新；自动区域外的手动内容会被保留。

## 隐私

服务只监听本机地址 `127.0.0.1`。只有当你主动发送消息并配置 AI 接口时，SciHub 才会将该次消息转发到你指定的 HTTPS 模型接口。API Key 仅保存在当前浏览器的本地存储中。
