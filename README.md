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

## 首次配置（必做，否则无法写入数据）

1. 打开 <https://supabase.com/dashboard>，进入本项目使用的 Supabase 项目。
2. 左侧 **SQL Editor** → 新建查询 → 粘贴本仓库 `supabase_schema.sql` 的全部内容 → **Run**。
3. 结果里应看到 `tables=1, policies=1, indexes=1, triggers=1`。
4. 回到网页点右上角「刷新」，即可开始记录。

脚本是幂等的，可重复执行；它只创建 `research_` 前缀的对象，不会动同一项目里其它应用的表。

> 若注册后无法登录，说明项目开启了 **Confirm email**：到邮箱点确认链接即可，或在 **Authentication → Providers → Email** 里关闭该选项。

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

## 与「拾光题库」共用同一个 Supabase 项目

本站当前复用了同一个 Supabase 项目（`wcnmufiabeftlsregamh`）。要点：

| 维度 | 是否共享 | 说明 |
| --- | --- | --- |
| 业务数据 | **不共享** | 本站只用 `research_*` 表，与题库的 `practice_history` / `wrong_questions` / `profiles` 完全不同，且都由 RLS 按 `user_id` 隔离。 |
| 浏览器登录态 | **不共享** | 本站的 `storageKey` 是 `scihub-research-auth`，题库是 `shiguang-quiz-auth`，互不覆盖。 |
| 登录账号池 | 共享 | 同一个邮箱在两站是同一个 `user_id`（同一账号），对单人使用是便利。 |
| 免费额度 | 共享 | 数据库 500 MB、带宽 5 GB/月、MAU 由两站共用。 |
| 表名空间 | 共享 | 新增表需避免与既有表重名，故本站统一用 `research_` 前缀。 |

### 想换成完全独立的 Supabase 项目

1. 在 Supabase 新建项目，SQL Editor 执行本仓库的 `supabase_schema.sql`。
2. 修改 `app.js` 顶部两行：

```js
const SUPABASE_URL = '<新项目 URL>';
const SUPABASE_KEY = '<新项目 publishable / anon key>';
```

3. `git push` 即可，其余代码无需改动。

## 边界与后续

- 当前版本只有一张表、无附件上传、无审核流；原 SciHub 的「样品—方法—实验—表征—结果—决策」证据网络模型尚未搬过来。
- 附件/图片上传需要 Supabase Storage 与配套 RLS 策略，属于下一步。
- 所有科学结论建议在 `content` 里写明条件、不确定性与适用边界，保持可追溯。
