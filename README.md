# SciHub · 科研工作台

静态科研记录工作台：**纯静态前端（HTML/CSS/JS）+ Supabase 认证与数据库 + GitHub Pages 部署**。打开网页注册/登录后，即可按账号记录科研条目（实验日志、文献笔记、表征数据、结果分析、待办），数据存在 Supabase 云端、按账号隔离、多设备同步。

这是本仓库的第一版最小可用骨架：**登录注册 + 一张数据表 CRUD + 云端持久化**。

## 架构

```
index.html      页面骨架（登录视图 / 应用视图）
style.css       样式
app.js          Supabase 接线、认证流程、记录 CRUD
supabase_schema.sql   数据库建表脚本（表 + RLS + 触发器 + 自检）
manifest.json / sw.js / version.json   PWA 与版本标记（可选增强）
```

- 前端是纯静态的，**没有任何服务端**，可直接托管在 GitHub Pages / Vercel / Netlify。
- Supabase 的 `publishable key` 写在 `app.js` 顶部：这类 key 本来就是公开的，只用来标识项目；真正的安全边界是数据库 **RLS（行级安全）** —— `research_records` 的策略是 `auth.uid() = user_id`，任何账号都只能读写自己的行。
- **绝不要把 `service_role` key 放进前端**，它会绕过 RLS。

## 首次配置（必做，否则无法注册 / 写入数据）

1. 打开 <https://supabase.com/dashboard>，进入本项目使用的 Supabase 项目。
2. 左侧 **SQL Editor** → 新建查询 → 粘贴本仓库 `supabase_schema.sql` 的全部内容 → **Run**。
   执行完会输出两行自检：`tables=1, policies=1, indexes=1, triggers=1` 与 `profile_tables=1, profile_functions=2`。
3. **关闭邮箱验证**：**Authentication → Providers → Email** → 关掉 **Confirm email**。
   本站按需求不做二次验证 —— 不关这个开关，注册后拿不到会话，必须先去邮箱点确认链接。
4. 回到网页用「邮箱 + 用户名 + 电话（选填）」注册，即可开始记录。

脚本是幂等的，可重复执行；它只创建 `research_` 前缀的对象。

## 可选：启用 AI 解析实验方案（DeepSeek）

导入 `.docx` 方案时默认用**规则解析**（正则拆章节与填空），大多数情况够用，但对
「同一节里多个试剂分别称量」「表格形式的汇总」这类内容容易出错或漏项。启用 AI 解析后由
DeepSeek 完成结构化，字段更准确（例如能分清 `2-MIM 实际称量质量` 与 `Fe(acac)₃ 实际称量质量`）。

**密钥安全**：DeepSeek 的 API key **绝不能写进前端**（静态站源码人人可见，等于公开密钥）。
因此本仓库用一个 Supabase Edge Function 做代理，key 只存在 Supabase 服务端。

### 部署步骤

1. **创建函数**：Supabase Dashboard → **Edge Functions** → *Deploy a new function*
   → 名称填 `parse-plan` → 把 `supabase/functions/parse-plan/index.ts` 的内容粘进去 → **Deploy**。
   （已装 Supabase CLI 的话也可 `supabase functions deploy parse-plan`。）
2. **配置密钥**：Dashboard → **Project Settings → Edge Functions → Secrets** → 新增
   `DEEPSEEK_API_KEY`，值填你在 DeepSeek 平台申请的 key。**不要把 key 发给任何人或写进仓库。**
3. 前端无需改动：函数部署好后再导入 `.docx` 就会自动走 AI 解析；若调用失败（未部署、
   密钥缺失、网络异常），会**自动回退规则解析**并给出提示，不影响使用。

## 账号体系

- **注册**：填「邮箱 + 用户名 + 电话 + 密码 + 确认密码」。用户名、邮箱、电话在库内唯一，重复会在注册前被 `research_check_signup` 拦下。
- **登录**：填「账号（邮箱 / 用户名 / 电话 任一）」+ 密码即可。
  - 输入含 `@` 时直接按邮箱走标准密码登录；
  - 否则先用 `research_lookup_login_email` 这个 RPC 把用户名 / 电话映射成邮箱，再走同一套密码登录。
- 界面上密码框支持「显示 / 隐藏」切换，注册需二次确认密码。
- 这两个 RPC 是 `security definer` 且 `revoke all ... from public` 后再单独授权给 `anon` / `authenticated`，只做「查重」与「标识符→邮箱」；`research_profiles` 表本身受 RLS 保护，任何人只能读写自己那一行。
- 前端不再校验密码长度；**实际强度由 Supabase 服务端控制**（Authentication → Settings → Minimum password length，最低只到 6 位，无法调更低）。

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
| `created_at` / `updated_at` | timestamptz | 创建/更新时间，后者由触发器自动维护 |

`research_profiles`（账号档案，一人一行）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | uuid | 主键，关联 `auth.users`，RLS 依据 |
| `username` | text | 登录用用户名，库内唯一（忽略大小写与首尾空格） |
| `phone` | text | 登录用电话，选填；填了则库内唯一（比较时忽略非数字字符） |
| `email` | text | 注册邮箱，库内唯一（忽略大小写） |
| `created_at` | timestamptz | 登记时间 |

## 本地预览

静态站不需要构建。用任意静态服务器打开即可（Supabase 登录依赖浏览器 `localStorage`，建议走 HTTP 而不是 `file://`）：

```bash
# 任选其一
python -m http.server 8080
npx serve .
```

然后访问 <http://localhost:8080>。

## 部署（GitHub Pages）

本仓库已开启 GitHub Pages，从 `master` 分支根目录发布：

- 线上地址：<https://teslacui.github.io/SciHub/>
- 更新方式：改完文件 `git push`，Pages 会自动重新发布（约 1 分钟）。
- `.nojekyll` 用于让 Pages 跳过 Jekyll 处理，直接原样发布静态文件。
- 改版后如果看到旧内容，是 Service Worker 缓存：`sw.js` 的 `CACHE` 名带版本号，改版时同步更新 `version.json` 与 `sw.js` 里的版本号，或强制刷新（Ctrl+F5）。

## Supabase 项目

本站使用**独立的 Supabase 项目**（`ttjnxndmjwhwpamyeuva`），与其它应用完全隔离：

- 独立的数据库、独立的登录账号池、独立的免费额度（数据库 500 MB / 带宽 5 GB 每月 / MAU）。
- 前端 `app.js` 顶部的 `SUPABASE_URL` 与 `SUPABASE_KEY` 指向这个项目；`publishable key` 本来就是公开的，安全边界仍由 RLS 承担。
- 浏览器登录态使用本项目专用的 `storageKey`（`scihub-research-auth`），不会与其它站点互相顶掉。

### 换用另一个 Supabase 项目

1. 在新项目的 SQL Editor 执行本仓库的 `supabase_schema.sql`。
2. 修改 `app.js` 顶部两行：

```js
const SUPABASE_URL = '<新项目 URL>';
const SUPABASE_KEY = '<新项目 publishable / anon key>';
```

3. `git push`，其余代码无需改动。

## 边界与后续

- 当前版本只有一张表、无附件上传、无审核流；原 SciHub 的「样品—方法—实验—表征—结果—决策」证据网络模型尚未搬过来。
- 附件/图片上传需要 Supabase Storage 与配套 RLS 策略，属于下一步。
- 所有科学结论建议在 `content` 里写明条件、不确定性与适用边界，保持可追溯。
