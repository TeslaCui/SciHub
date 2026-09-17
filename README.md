# SciHub · 科研工作台

科研记录 + 实验执行工作台：**纯静态前端（HTML/CSS/JS）+ Supabase 认证、数据库与 Storage + GitHub Pages 部署**。
登录后即可记录科研条目（实验日志、文献笔记、表征数据、结果分析、待办），导入实验方案并**按步执行**——边做边填数据、拍照、自动存云端，做完自动生成实验日志。

线上地址：<https://teslacui.github.io/SciHub/>

当前版本 **v0.97.0**（2026-09-14）。

## 架构

```
index.html            页面骨架（登录视图 / 应用视图 / 模态框）
style.css             样式
app.js                认证、科研记录 CRUD、主页（进行中的实验 + 日历 + 待办）、路由、小工具入口
experiment.js         实验模块：方案导入/编辑、按步执行、拍照、导出、关联实验、热解程序计算器
supabase_schema.sql   数据库结构参考（与 migrations 基线等价，含自检查询，可手工整段执行）
supabase/migrations/  数据库迁移（结构以这里为准；push 后由 GitHub Actions 自动应用）
supabase/config.toml  Supabase 项目标识 + 要部署的 Edge Functions 声明
supabase/functions/   Edge Function（DeepSeek 代理）：parse-plan / match-params / check-link / todo-plan
.github/workflows/    GitHub Actions：push 自动「应用迁移 + 部署 Edge Functions」
manifest.json / sw.js / version.json   PWA 与版本标记
tools/sync.sh|.cmd    一键「语法检查 → 提交 → 推送」（可选）
```

- 前端纯静态，**没有任何自建服务端**，可直接托管在 GitHub Pages / Vercel / Netlify。
- Supabase 的 `publishable key` 写在 `app.js` 顶部：这类 key 本就是公开的，只用来标识项目；**真正的安全边界是 RLS**——每张表的策略都是 `auth.uid() = user_id`，任何账号都只能读写自己的行。
- **绝不要把 `service_role` key 放进前端**，它会绕过 RLS。DeepSeek 的 API key 同样不进前端，只存在 Supabase 服务端（见「AI 能力」）。

## Supabase 自动化（push 即同步）

`.github/workflows/supabase.yml` 在 **push 到 `master` 且改动涉及 `supabase/`** 时自动执行：

1. `supabase db push` —— 应用 `supabase/migrations/` 里还没跑过的迁移；
2. `supabase functions deploy` —— 部署 `supabase/config.toml` 声明的 4 个 Edge Function。

因此：**以后改数据库结构 = 新增一个迁移文件；改 Edge Function = 直接改代码**，push 即可，不必再进 Dashboard 手贴 SQL 或手动部署。

### 一次性配置（3 个 GitHub Secret）

仓库 **Settings → Secrets and variables → Actions → New repository secret**：

| Secret | 取值位置 |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Supabase Dashboard → Account → **Access Tokens** → 新建令牌 |
| `SUPABASE_PROJECT_ID` | 项目 ref（本项目：`ttjnxndmjwhwpamyeuva`） |
| `SUPABASE_DB_PASSWORD` | Dashboard → Project Settings → **Database** → 数据库密码（忘了可在那里重置） |

配好后：**Actions → Sync Supabase → Run workflow** 手动跑一次确认（workflow 会先校验三个 secret 是否齐全，缺了会直接报「缺少 GitHub Secret: …」）。

### 以后怎么改结构

```bash
# 例：给 run_steps 加一列
printf 'alter table public.run_steps add column if not exists foo text;\n' \
  > supabase/migrations/$(date +%Y%m%d%H%M%S)_add_run_steps_foo.sql
git add supabase/migrations && git commit -m "db: add run_steps.foo" && git push
```

约定：
- 迁移文件名用**时间戳前缀**（`YYYYMMDDHHMMSS_说明.sql`），CLI 按名字排序执行；
- 每份迁移都要**幂等**（`if not exists` / `drop … if exists`），这样基线在新环境重跑也安全；
- 结构改完记得同步 `supabase_schema.sql`（它作为人读的参考，与迁移基线保持一致）；
- **基线（`*_init.sql`）不要改**，新变更一律新增文件 —— 已应用过的迁移不会再执行，改了也不会生效。

## 功能一览

### 账号体系

- **注册**：「邮箱 + 用户名 + 电话（选填）+ 密码 + 确认密码」。用户名、邮箱、电话在库内唯一（忽略大小写与首尾空格；电话比较时忽略非数字字符），重复会被 `research_check_signup` 在注册前拦下。
- **登录**：账号填「邮箱 / 用户名 / 电话」任一 + 密码。
  - 含 `@` 直接按邮箱走标准密码登录；
  - 否则先用 `research_lookup_login_email` 把用户名 / 电话映射成邮箱，再走同一套密码登录（不需要邮箱验证码）。
- 密码框支持「显示 / 隐藏」，注册需二次确认；密码强度由 Supabase 服务端控制（Authentication → Settings → Minimum password length）。
- 右上角用户菜单：**账号信息 / 修改密码 / 退出登录**。

### 主页

- **进行中的实验**：卡片显示进度与当前步骤，卡片上可直接重命名、删除、关联 / 取消关联、导出 Word。
- **实验日历**：按月聚合实验，支持翻月与「回到本月」；悬停（手机点按）某天可看当天的步骤与进度——不只是实验开始那天，**当天做过的操作**（例如 14 号做离心）也会出现在那一天。
- **待办**：
  - 进行中的实验自动出待办，文案由**本地确定性规则**生成：「已完成第 X 步…，等待进行第 Y 步…」；步骤带时长提示时显示「开始 · 持续 · 结束 · 倒计时」，过期显示超时多久。
  - 「这一步做没做」统一按**当前字段有值或传过照片**判定。
  - 手动待办：与实验无关的事（「明天 10:00 取样品」）可自己添加（可设时间）与删除，存在 `research_todos`。
- 订阅 `run_steps` 实时变化：进度一更新就重算待办。
- 顺带显示最近方案与最近科研记录；进主页时对缺失「时长提示」的方案做一次自愈补齐（每个方案每会话只补一次）。

### 实验方案

- **导入 `.docx`**：前端用 JSZip 解 Word，按章节拆步骤，自动识别「xxx：____ g」这类需要现场填写的字段。
- **两条解析路线**：优先 AI 解析（`parse-plan`，能区分同名药品、能读表格），不可用时**自动回退规则解析**并在界面上提示。
- **校对 / 编辑**：拖动排序步骤、字段与注意事项；给字段指定填写方式（文本 / 数字 / 时间 / 日期 / 日期 + 时间）；填写每步的时长提示、热解程序、注意事项（多条用「；」分隔）。
- **解析规则版本**：方案记下导入时用的规则版本（当前 v4：v1 基础字段 → v2 注意事项 + 同名药品前缀 → v3 热解程序 + 字段填写方式 → v4 步骤粒度按工序归并）。落后就在列表上标「有新版本 / 更新」，一键**重新解析**；重新解析不影响已开始的实验，已填数据会按字段名迁移（优先 `match-params` 语义配对，失败则本地字符串比对）。
- **开始一次实验**：把方案步骤**快照**进 `run_steps`，之后改方案不会篡改历史记录。

### 执行实验

- 按步执行：填数据、写备注、**拍照上传**；字段按类型给出原生控件（数字键盘、日期 / 时间选择器），关键数值（g/mL/℃/h/rpm…）高亮。
- **自动保存**：输入停下 1 秒写库；实验与「当前进行到第几步」都存在云端，**换设备、跨天都能接着做**。
- **多端实时同步**：订阅该实验的 `run_steps` 变化。
- **热解程序计算器**：识别 `C30-T60-C30-T184-C950-T60-C950--121` 形式的程序，按「初始温度 / 升温速率 / 最终温度」重算各段耗时与总时长（室温一变升温段就要重算）。
- **照片**：一次多张，可拖动排序（桌面原生拖拽，手机长按拖动），点开灯箱放大、播放与存到设备；导出时按当前顺序嵌入文档。
- **关联实验**：把两个实验在某个步骤上合并（`link_run_id` / `link_note`），主页合并成一条显示；`check-link` 会先判断「合并点之后的步骤是否一致」，拿不准就拦下让人确认。
- **导出 Word**：只导出到当前进行到的步骤（做完即全量），含每步时间、数据、备注与照片；关联在一起的实验写进同一份文档。
- **完成实验**：生成实验日志并自动写入「科研记录」（类别＝实验日志）。

### 科研记录

- 新建 / 编辑 / 删除；字段：标题、类别（实验日志 / 文献笔记 / 表征数据 / 结果分析 / 待办 / 其他）、发生日期、标签、正文。
- 搜索（标题 / 内容 / 标签）、按类别筛选、显示条数。
- **导出 CSV**：导出当前筛选结果，带 BOM，Excel 打开中文不乱码。

### 小工具与版本

- 右上角「小工具」：目前是**热解程序计算器**（与执行界面里的是同一个），后续新增的也挂这里。
- PWA：`manifest.json` + Service Worker（全部 network-first，离线回退缓存）。
- 版本自检：页脚显示当前运行的 `vX.Y.Z`，与服务器 `version.json` 不一致时提示「有新版本，点击更新」（清缓存 + 注销 SW + 刷新）。

## 首次配置（必做，否则无法注册 / 写入数据）

1. 打开 <https://supabase.com/dashboard>，进入本项目使用的 Supabase 项目。
2. 建库结构，二选一：
   - **自动化（推荐）**：按上面「Supabase 自动化」配好 3 个 GitHub Secret，然后在 Actions 里手动跑一次 **Sync Supabase** —— 迁移会自动应用，不用手贴 SQL；Edge Functions 也一并部署。
   - **手动**：左侧 **SQL Editor** → 新建查询 → 粘贴 `supabase_schema.sql` 全部内容 → **Run**（或按顺序粘贴 `supabase/migrations/*.sql`）。脚本幂等，可重复执行，只创建 `research_` / `experiment_` / `plan_` / `run_` 前缀的对象。执行完会依次输出 9 段自检，预期：

   | 自检 | 预期输出 |
   | --- | --- |
   | 1 科研记录 | `tables=1, policies=1, indexes=1, triggers=1` |
   | 2 账号档案 | `profile_tables=1, profile_functions=2` |
   | 3 实验模块 | `exp_tables=4, exp_policies=4, exp_bucket=1, exp_image_policies=4` |
   | 4 Realtime | `realtime_tables=2` |
   | 5 注意事项列 | `notice_columns=2` |
   | 6 解析规则版本 | `parse_version_columns=1` |
   | 7 热解程序列 | `pyro_seq_columns=2` |
   | 8 手动待办 | `todos_table=1, todos_rls=1` |
   | 9 关联列 | `link_columns=2` |

3. **关闭邮箱验证**：**Authentication → Providers → Email** → 关掉 **Confirm email**。本站不做二次验证——不关这个开关，注册后拿不到会话，必须先去邮箱点确认链接。
4. 回到网页用「邮箱 + 用户名 + 电话（选填）」注册，即可开始记录。

## AI 能力（可选）与回退

前端是静态站，DeepSeek 的 key 绝不能写进前端（等于公开密钥），因此用 Supabase Edge Function 做代理：key 只存在 Supabase 服务端，浏览器只调用函数。

| 函数 | 作用 | 不部署时的表现 |
| --- | --- | --- |
| `parse-plan` | 把方案正文结构化（步骤 + 需现场记录的字段 + 注意事项 + 时长提示） | 回退规则解析（正则拆章节与填空），对「同一节多个试剂分别称量」「表格汇总」容易出错或漏项 |
| `match-params` | 判断「旧字段 ↔ 新字段」里哪些是同一个参数，用于重新解析后的数据迁移 | 回退本地字符串比对（去掉「记录 / 实际 / 称量」等修饰词后比较） |
| `check-link` | 判断两个实验「从某一合并点往后」的后续步骤是否一致，用于关联实验 | 回退本地比对 |
| `todo-plan` | AI 待办（历史功能） | 前端自 v0.88 起**已不再调用**，待办完全由本地规则生成；函数保留在仓库中，未部署也不影响任何功能 |

部署方式（各函数同理，示例用 `parse-plan`）：

1. **创建函数**：Supabase Dashboard → **Edge Functions** → *Deploy a new function* → 名称填 `parse-plan` → 把 `supabase/functions/parse-plan/index.ts` 的内容粘进去 → **Deploy**（装了 CLI 也可 `supabase functions deploy parse-plan`）。
2. **配置密钥**：Dashboard → **Project Settings → Edge Functions → Secrets** → 新增 `DEEPSEEK_API_KEY`，值填你在 DeepSeek 平台申请的 key。**不要把 key 发给任何人或写进仓库。**
3. 前端无需改动：函数部署好后再导入 `.docx` 就会自动走 AI 解析；调用失败（未部署、密钥缺失、网络异常）会**自动回退**并给出提示，不影响使用。

## 数据模型

`research_records`（每行属于一个账号）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `user_id` | uuid | 归属账号，默认 `auth.uid()`，RLS 依据 |
| `title` | text | 标题（非空） |
| `category` | text | 类别：实验日志 / 文献笔记 / 表征数据 / 结果分析 / 待办 / 其他 |
| `content` | text | 正文 |
| `tags` | text[] | 标签 |
| `occurred_on` | date | 发生日期（默认今天） |
| `created_at` / `updated_at` | timestamptz | 创建 / 更新时间，后者由触发器自动维护 |

`research_profiles`（账号档案，一人一行）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | uuid | 主键，关联 `auth.users`，RLS 依据 |
| `username` | text | 登录用用户名，库内唯一（忽略大小写与首尾空格） |
| `phone` | text | 登录用电话，选填；填了则库内唯一（比较时忽略非数字字符） |
| `email` | text | 注册邮箱，库内唯一（忽略大小写） |
| `created_at` | timestamptz | 登记时间 |

实验模块（四张表，各自 `enable row level security` + 「只能读写自己行」策略）：

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `experiment_plans` | `title` / `source` / `parse_version` | 方案；`source` 记来源文件名，`parse_version` 记导入时的解析规则版本 |
| `plan_steps` | `position` / `title` / `instruction` / `fields`(jsonb) / `duration_hint` / `notice` / `pyro_seq` | 方案步骤；`fields` 形如 `[{label, unit, type}]` |
| `experiment_runs` | `plan_id` / `status`(running·done·aborted) / `current_step` / `started_at` / `finished_at` | 一次实验；`status='running'` 时可跨天继续 |
| `run_steps` | `position` / `fields` / `values`(jsonb) / `note` / `images`(jsonb) / `status`(pending·done) / `started_at` / `finished_at` / `notice` / `pyro_seq` / `link_run_id` / `link_note` / `duration_hint` | 执行快照，起跑时从方案复制；做过的数据都在这里 |

`research_todos`（只存手动添加的待办）：`title` / `due_at` / `done` / `created_at`，同样 RLS 只允许读写自己行。

其它数据库对象：

- **RPC**：`research_check_signup`（注册查重）、`research_lookup_login_email`（标识符 → 邮箱）。两者都是 `security definer`，并先 `revoke all ... from public` 再单独授权给 `anon` / `authenticated`。
- **触发器**：`research_touch_updated_at()` 挂在这些表的 `before update` 上，自动维护 `updated_at`。
- **Storage**：私有 bucket `experiment-images`，路径约定 `<user_id>/<run_id>/<step_position>/<文件名>`，四条策略确保每人只读写自己 `user_id` 目录下的文件。
- **Realtime**：`run_steps` 与 `experiment_runs` 加入 `supabase_realtime` 发布，用于多端实时同步。

## 本地预览

静态站不需要构建。用任意静态服务器打开即可（登录依赖浏览器 `localStorage`，建议走 HTTP 而不是 `file://`）：

```bash
# 任选其一
python -m http.server 8080
npx serve .
```

然后访问 <http://localhost:8080>。

## 部署（GitHub Pages）

本仓库已开启 GitHub Pages，从 `master` 分支根目录发布：

- 线上地址：<https://teslacui.github.io/SciHub/>
- 更新方式：改完文件 `git push`，Pages 会自动重新发布（约 1 分钟）；也可用 `tools/sync.sh "提交说明"`（语法检查 → 提交 → 推送，直连失败会自动走代理）。
- `.nojekyll` 让 Pages 跳过 Jekyll 处理，直接原样发布静态文件。

### 发版约定

改前端资源（`app.js` / `experiment.js` / `style.css` / `index.html`）后，**四处版本号要一起更新**，否则用户会拿到旧缓存：

1. `version.json` 的 `version`；
2. `sw.js` 的 `CACHE` 名与 `ASSETS` 里的 `?v=`；
3. `index.html` 里各资源的 `?v=`；
4. `app.js` 的 `APP_VERSION`（它「烧」进 JS，代表浏览器实际运行的版本）。

`README.md` 不在 Service Worker 缓存列表里，改文档无需动版本号。

## Supabase 项目

本站使用**独立的 Supabase 项目**（`ttjnxndmjwhwpamyeuva`），与其它应用完全隔离：独立数据库、独立账号池、独立免费额度。

- 前端 `app.js` 顶部的 `SUPABASE_URL` 与 `SUPABASE_KEY` 指向这个项目。
- 浏览器登录态用本项目专用的 `storageKey`（`scihub-research-auth`），不会与其它站点互相顶掉。

### 换用另一个 Supabase 项目

1. 在新项目的 SQL Editor 执行 `supabase_schema.sql`。
2. 修改 `app.js` 顶部两行：

```js
const SUPABASE_URL = '<新项目 URL>';
const SUPABASE_KEY = '<新项目 publishable / anon key>';
```

3. `git push`，其余代码无需改动。

## 安全红线

1. 前端只允许出现 Supabase 的 `publishable` / `anon` key；**`service_role` key、数据库连接串、任何私钥都不得进入仓库或前端代码**。
2. 页面里的一切数据可见性依赖 RLS；**新增表必须同时给出 `enable row level security` 与「只能读写自己行」的策略**。
3. 不得把用户数据写入公开静态文件。
4. `supabase_schema.sql` 与前端代码的表名、字段名必须保持一致，改其一要同步另一处。

## 当前边界与后续

- 原 SciHub 的「样品—方法—实验—表征—结果—决策」证据网络模型尚未搬过来；当前是「一条科研记录 + 一条实验流水线」的实用形态。
- 附件目前只有实验照片（走 Storage）；其它附件类型未做。
- 无审核流、无协作 / 共享（数据按账号完全隔离，只有自己能看到）。
- 所有科学结论建议在 `content` / 备注里写明条件、不确定性与适用边界，保持可追溯。
