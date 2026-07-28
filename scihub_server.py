"""SciHub 本地服务：把科研项目、实验日志、对话记录保存为 Markdown 文件。

- 仅监听回环地址 127.0.0.1，不会把项目文件上传到网络。
- 每个项目保存在 `科研项目/项目名-时间戳/` 下，均为可读的 .md 文件。
- 每次保存都会实时更新该项目的 AGENTS.md（自动区块），供 AI 作为项目记忆使用。
- `/api/proxy` 只把用户显式发送的对话转发给你自己配置的 HTTPS 模型接口。

PDF 导入与 Word/PDF 导出使用本地 Python 包 pypdf、python-docx、reportlab；
这些包只在本机读取和生成文档，不会上传项目资料。
"""

from __future__ import annotations

import base64
import difflib
import hashlib
import io
import json
import mimetypes
import re
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from xml.etree import ElementTree
from xml.sax.saxutils import escape as xml_escape

ROOT = Path(__file__).resolve().parent
PROJECTS_ROOT = ROOT / "科研项目"
HOST = "127.0.0.1"
PORT = 8770
MAX_BODY_SIZE = 24 * 1024 * 1024
APP_VERSION = "2026.07.27"

INDEX_FILE = "index.html"
SLUG_RE = re.compile(r"^[\w一-鿿-]+$", re.UNICODE)
CONVERSATION_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
PLAN_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FRONT_MATTER_RE = re.compile(r"(?s)^---\r?\n(.*?)\r?\n---\r?\n?")
META_LINE_RE = re.compile(r'^([A-Za-z_]+):\s*"?(.*?)"?$')
MESSAGE_RE = re.compile(
    r"(?ms)^### (user|assistant) \| ([^\r\n]+)\r?\n(.*?)(?=^### (?:user|assistant) \||\Z)"
)
SUBEXPERIMENT_RE = re.compile(
    r"(?ms)^### \[([A-Za-z0-9_-]+)\] ([^\r\n]+)\r?\n(.*?)(?=^### \[|\Z)"
)
PLAN_STYLE_RE = re.compile(r"<!--\s*SCIHUB-PLAN-STYLE:\s*({.*?})\s*-->", re.IGNORECASE | re.DOTALL)
PLAN_FONT_NAMES = {"Microsoft YaHei", "SimSun", "KaiTi", "Noto Serif SC"}
PLAN_FONT_SIZES = {9, 10, 11, 12, 13, 14, 16}
PLAN_LAYOUT_MODES = {"compact", "spacious"}
PLAN_ANALYSIS_META_KEY = "version_analysis"
PLAN_ANALYSIS_MAX_CHANGES = 80

AUTO_START = "<!-- AUTO-UPDATE:START -->"
AUTO_END = "<!-- AUTO-UPDATE:END -->"
AUTO_BLOCK_RE = re.compile(r"(?s)" + re.escape(AUTO_START) + r".*?" + re.escape(AUTO_END))

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class SciHubServer(ThreadingHTTPServer):
    """拒绝重复监听同一端口，防止多个版本随机处理同一请求。"""

    allow_reuse_address = False


class ApiError(Exception):
    """用于返回给前端的可读错误。"""

    def __init__(self, message: str, status: int = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------------- #
# 工具函数
# --------------------------------------------------------------------------- #
def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def one_line(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"[\r\n]+", " ", str(value)).strip()


def escape_meta(value: Any) -> str:
    return one_line(value).replace('"', "'")


def read_markdown_document(path: Path) -> dict:
    """读取 Markdown，拆出 front-matter 元数据与正文。"""
    if not path.is_file():
        return {"meta": {}, "content": ""}
    raw = path.read_text(encoding="utf-8")
    meta: dict[str, str] = {}
    content = raw
    match = FRONT_MATTER_RE.match(raw)
    if match:
        for line in match.group(1).splitlines():
            entry = META_LINE_RE.match(line)
            if entry:
                meta[entry.group(1)] = one_line(entry.group(2))
        content = raw[match.end():]
    return {"meta": meta, "content": content}


def write_markdown(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def front_matter(meta: dict) -> str:
    lines = ["---"]
    for key, value in meta.items():
        lines.append(f'{key}: "{escape_meta(value)}"')
    lines.append("---")
    lines.append("")
    return "\n".join(lines)


def meta_value(meta: dict, key: str, fallback: str = "") -> str:
    value = meta.get(key)
    if value is None or value == "":
        return fallback
    return str(value)


def get_section(content: str, heading: str) -> str:
    pattern = re.compile(
        r"(?ms)^## " + re.escape(heading) + r"\r?\n(.*?)(?=^## |\Z)"
    )
    match = pattern.search(content)
    return match.group(1).strip() if match else ""


def safe_slug(slug: str) -> str:
    if not slug or not SLUG_RE.match(slug):
        raise ApiError("项目标识无效。")
    return slug


def make_slug(name: str) -> str:
    base = re.sub(r"[^\w一-鿿-]+", "-", name, flags=re.UNICODE).strip("-")
    if not base:
        base = "research-project"
    return f"{base}-{datetime.now().strftime('%Y%m%d%H%M%S')}"


# --------------------------------------------------------------------------- #
# 项目文件读写
# --------------------------------------------------------------------------- #
def project_dir(slug: str) -> Path:
    slug = safe_slug(slug)
    root = PROJECTS_ROOT.resolve()
    path = (PROJECTS_ROOT / slug).resolve()
    if path.parent != root:
        raise ApiError("项目路径无效。")
    if not path.is_dir():
        raise ApiError("未找到该项目。", HTTPStatus.NOT_FOUND)
    return path


def load_project(slug: str) -> dict:
    directory = project_dir(slug)
    doc = read_markdown_document(directory / "README.md")
    if doc["meta"].get("kind") != "research_project":
        raise ApiError("项目元数据无效。")
    if meta_value(doc["meta"], "slug", slug) != slug:
        raise ApiError("项目标识与项目文件夹不一致。")
    project = {"slug": slug, "dir": directory, "meta": doc["meta"], "content": doc["content"]}
    project["compatibilityUpdates"] = synchronise_existing_project(project)
    return project


def write_project_readme(project: dict, name: str, description: str, important: str) -> None:
    now = now_iso()
    created = meta_value(project["meta"], "created_at", now)
    meta = {
        "kind": "research_project",
        "slug": project["slug"],
        "name": name,
        "description": description,
        "important_info": important,
        "created_at": created,
        "updated_at": now,
    }
    body = f"# {name}\n\n{description}\n\n## 项目重要信息\n\n{important}\n"
    write_markdown(project["dir"] / "README.md", front_matter(meta) + body)
    project["meta"] = meta


def project_summary(project: dict) -> dict:
    conversations_dir = project["dir"] / "对话记录"
    logs = list_log_paths(project)
    conversations = list(conversations_dir.glob("*.md")) if conversations_dir.is_dir() else []
    meta = project["meta"]
    return {
        "slug": project["slug"],
        "name": meta_value(meta, "name", project["slug"]),
        "description": meta_value(meta, "description"),
        "importantInfo": meta_value(meta, "important_info"),
        "createdAt": meta_value(meta, "created_at"),
        "updatedAt": meta_value(meta, "updated_at"),
        "logCount": len(logs),
        "conversationCount": len(conversations),
    }


def validate_export_directory(value: Any) -> Path:
    """验证用户明确选择的导出目录；项目资料本身不会写到这里。"""
    raw = one_line(value)
    if not raw:
        raise ApiError("请选择项目记忆的导出文件夹。")
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise ApiError("导出文件夹必须是本机绝对路径，例如 D:\\导出资料。")
    try:
        return candidate.resolve()
    except OSError as error:
        raise ApiError(f"无法读取导出文件夹：{error}") from error


def choose_export_directory() -> str:
    """只返回用户选择的导出目录，不会修改项目内容。"""
    root = None
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        root.update()
        selected = filedialog.askdirectory(title="选择项目记忆导出文件夹")
    except Exception as error:
        raise ApiError(f"无法打开本机文件夹选择器：{error}") from error
    finally:
        if root is not None:
            root.destroy()
    return str(validate_export_directory(selected)) if selected else ""


def project_deletion_paths(project: dict) -> tuple[Path, list[Path], list[Path]]:
    """列出项目内的全部待删除条目；链接或异常类型会被拒绝，避免误删。"""
    projects_root = PROJECTS_ROOT.resolve()
    target = project["dir"].resolve()
    if target.parent != projects_root or not target.is_dir() or target.is_symlink():
        raise ApiError("项目目录无效，已拒绝删除。")
    files: list[Path] = []
    directories: list[Path] = []
    for item in sorted(target.rglob("*"), key=lambda path: path.relative_to(target).as_posix().casefold()):
        if item.is_symlink():
            raise ApiError("项目目录包含链接文件，为避免误删已拒绝删除。")
        if item.is_file():
            files.append(item)
        elif item.is_dir():
            directories.append(item)
        else:
            raise ApiError("项目目录包含无法安全识别的条目，已拒绝删除。")
    return target, files, directories


def project_deletion_preview(project: dict) -> dict:
    target, files, directories = project_deletion_paths(project)
    root = PROJECTS_ROOT.resolve()
    items = [{"path": target.relative_to(root).as_posix() + "/", "kind": "folder"}]
    items.extend({"path": path.relative_to(root).as_posix() + "/", "kind": "folder"} for path in directories)
    items.extend({"path": path.relative_to(root).as_posix(), "kind": "file"} for path in files)
    return {"project": project_summary(project), "folder": target.name, "items": items}


def delete_project(project: dict, confirmation: str) -> None:
    """删除用户已明确确认的项目；按清单逐项处理，不使用递归删除。"""
    target, files, directories = project_deletion_paths(project)
    if confirmation != target.name:
        raise ApiError("请准确输入项目文件夹名以确认删除。")
    for path in files:
        path.unlink()
    for path in sorted(directories, key=lambda item: len(item.parts), reverse=True):
        path.rmdir()
    target.rmdir()


def legacy_update_agents(project: dict) -> None:
    """实时更新项目 AGENTS.md 的自动区块。"""
    readme = read_markdown_document(project["dir"] / "README.md")
    conversations_dir = project["dir"] / "对话记录"

    recent_logs = sorted(
        list_log_paths(project), key=lambda p: p.stat().st_mtime, reverse=True
    )[:6]
    recent_conversations = sorted(
        conversations_dir.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True
    )[:6] if conversations_dir.is_dir() else []

    if recent_logs:
        log_lines = [
            f"- [{p.stem}](实验日志/{p.name}) · 最后更新 "
            f"{datetime.fromtimestamp(p.stat().st_mtime).strftime('%Y-%m-%d %H:%M')}"
            for p in recent_logs
        ]
    else:
        log_lines = ["- 暂无实验日志。"]

    if recent_logs:
        log_lines = []
        for p in recent_logs:
            doc = read_markdown_document(p)
            date = meta_value(doc["meta"], "date", p.stem[:10])
            plan_name = meta_value(doc["meta"], "plan_name")
            plan_version = meta_value(doc["meta"], "plan_version")
            subexperiment_name = meta_value(doc["meta"], "subexperiment_name")
            relation = ""
            if plan_name:
                relation = f" · 方案：{plan_name}{(' · ' + plan_version) if plan_version else ''}"
                if subexperiment_name:
                    relation += f" · 子实验：{subexperiment_name}"
            updated = datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
            relative_path = p.relative_to(project["dir"]).as_posix()
            log_lines.append(f"- [{date}]({relative_path}){relation} · 最后更新 {updated}")

    plans = list_plans(project)
    if plans:
        plan_lines = []
        for plan in plans[:8]:
            sub_count = len(plan["subexperiments"])
            plan_lines.append(
                f"- [{plan['name']} · {plan['version']}]({plan['relativePath']})"
                f" · {sub_count} 个子实验"
            )
    else:
        plan_lines = ["- 暂无实验方案。"]

    if recent_conversations:
        conversation_lines = []
        for p in recent_conversations:
            doc = read_markdown_document(p)
            title = meta_value(doc["meta"], "title", p.stem)
            model = meta_value(doc["meta"], "model", "手工记录")
            updated = datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
            conversation_lines.append(
                f"- [{title}](对话记录/{p.name}) · {model} · 最后更新 {updated}"
            )
    else:
        conversation_lines = ["- 暂无对话记录。"]

    auto = "\n".join(
        [
            AUTO_START,
            "## 自动更新的项目上下文",
            "",
            f"- 项目名称：{meta_value(readme['meta'], 'name')}",
            f"- 项目说明：{meta_value(readme['meta'], 'description')}",
            f"- 最近同步：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            "",
            "## 项目重要信息",
            "",
            meta_value(readme["meta"], "important_info", "尚未填写。"),
            "",
            "## 实验方案",
            "",
            *plan_lines,
            "",
            "## 最近实验日志",
            "",
            *log_lines,
            "",
            "## 近期对话更新",
            "",
            *conversation_lines,
            "",
            "## 提供给 AI 的使用边界",
            "",
            "- 以上内容是项目上下文，不等同于已经验证的科研结论。",
            "- 回答时必须区分原始观察、模型建议和已验证证据；不确定时明确说明。",
            "- 如需细节，请先阅读相应 Markdown 原始记录。",
            AUTO_END,
        ]
    )

    path = project["dir"] / "AGENTS.md"
    if path.is_file():
        old = path.read_text(encoding="utf-8")
    else:
        name = meta_value(readme["meta"], "name", project["slug"])
        old = (
            f"# {name} · 项目协作记忆\n\n"
            "此文件可作为后续 AI 对话的项目记忆。自动区块会随实验日志和对话记录更新；"
            "可在其他位置手工补充长期有效信息。\n"
        )
    stripped = AUTO_BLOCK_RE.sub("", old).rstrip()
    write_markdown(path, stripped + "\n\n" + auto + "\n")


def memory_is_placeholder(value: Any) -> bool:
    text = one_line(value).strip(" 。；;，,")
    return not text or text in {"待补充", "尚未填写", "暂无", "无", "—", "-"}


def memory_text(value: Any, limit: int = 360) -> str:
    """移除 Markdown 装饰并截取语义完整的短文本，控制项目记忆长度。"""
    text = PLAN_STYLE_RE.sub("", str(value or ""))
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    text = re.sub(r"(?m)^\s{0,3}#{1,6}\s+", "", text)
    text = re.sub(r"(?m)^\s*(?:[-*+]\s+|\d+[.)、]\s+)", "", text)
    text = re.sub(r"[*_`]", "", text)
    text = re.sub(r"\s+", " ", text).strip(" -；;，,")
    if not text or limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    floor = max(0, int(limit * 0.58))
    cut = max((text.rfind(mark, floor, limit + 1) for mark in "。；;！？!?"), default=-1)
    if cut >= floor:
        return text[:cut + 1].rstrip()
    return text[:max(1, limit - 1)].rstrip() + "…"


def memory_heading_blocks(content: str) -> list[tuple[int, str, str]]:
    """按 Markdown 标题返回正文块；嵌套标题保留在父板块中。"""
    source = PLAN_STYLE_RE.sub("", content or "")
    source = re.sub(r"<!--.*?-->", "", source, flags=re.DOTALL)
    headings = []
    for match in re.finditer(r"(?m)^(#{1,6})\s+(.+?)\s*$", source):
        headings.append((match.start(), match.end(), len(match.group(1)), re.sub(r"[*_`]", "", match.group(2)).strip()))
    blocks = []
    for index, (_, end, level, title) in enumerate(headings):
        stop = len(source)
        for next_start, _, next_level, _ in headings[index + 1:]:
            if next_level <= level:
                stop = next_start
                break
        blocks.append((level, title, source[end:stop].strip()))
    return blocks


def memory_section(content: str, title_pattern: str) -> str:
    for _, title, body in memory_heading_blocks(content):
        if re.search(title_pattern, title, re.IGNORECASE):
            return body
    return ""


def memory_bullets(content: str, max_items: int = 4, item_limit: int = 150) -> list[str]:
    """优先保留列表项；没有列表时从段落中摘取短句。"""
    candidates = []
    for raw in (content or "").splitlines():
        line = raw.strip()
        if not line or re.match(r"^#{1,6}\s+", line):
            continue
        if not re.match(r"^(?:[-*+]\s+|\d+[.)、]\s+)", line):
            continue
        text = memory_text(line, item_limit)
        if text and not memory_is_placeholder(text):
            candidates.append(text)
    if not candidates:
        normalized = memory_text(content, item_limit * max_items)
        candidates = [memory_text(part, item_limit) for part in re.split(r"(?<=[。；;！？!?])\s*", normalized) if part.strip()]
    result = []
    seen = set()
    for item in candidates:
        key = re.sub(r"\s+", "", item).casefold()
        if not item or key in seen or memory_is_placeholder(item):
            continue
        seen.add(key)
        result.append(item)
        if len(result) >= max_items:
            break
    return result


def memory_step_items(content: str, max_items: int = 5) -> list[str]:
    """只摘取方案步骤中带数值或执行警示的句子，避免复制整段方案。"""
    steps = plan_analysis_sections(content).get("steps", "")
    if not steps:
        return []
    numeric = re.compile(r"(?:\d+(?:\.\d+)?\s*(?:mg|g|kg|μg|µg|mL|L|μL|µL|rpm|min|h|hr|℃|°C|K|MPa|kPa|bar|%|V|mA|A|s)|\b\d+\s*(?:x|×)\s*g\b)", re.IGNORECASE)
    caution = re.compile(r"必须|不得|避免|配平|确认|置换|通入|密闭|暂停|回收|记录实际|安全", re.IGNORECASE)
    current_step = ""
    numeric_items, caution_items = [], []
    for raw in steps.splitlines():
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", raw.strip())
        if heading:
            title = re.sub(r"[*_`]", "", heading.group(2)).strip()
            if not re.search(r"操作步骤|实验步骤|操作流程|实验流程", title):
                current_step = title
            continue
        text = memory_text(raw, 102)
        if not text or memory_is_placeholder(text):
            continue
        candidate = f"{current_step}：{text}" if current_step and not text.startswith(current_step) else text
        candidate = memory_text(candidate, 124)
        if numeric.search(text):
            numeric_items.append(candidate)
        elif caution.search(text):
            caution_items.append(candidate)
    result = []
    seen = set()
    for item in numeric_items + caution_items:
        key = re.sub(r"\s+", "", item).casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
        if len(result) >= max_items:
            break
    return result


def compact_plan_baseline(content: str) -> list[str]:
    """生成单个子实验的首版基线，保留目标、关键参数、风险与未决项。"""
    lines = []
    purpose = memory_text(memory_section(content, r"实验目的|研究目的|目标"), 170)
    if purpose and not memory_is_placeholder(purpose):
        lines.append(f"目的：{purpose}")
    design = memory_text(memory_section(content, r"研究假设|实验设计|实验分组|变量"), 170)
    if design and not memory_is_placeholder(design):
        lines.append(f"设计/变量：{design}")
    step_items = memory_step_items(content)
    if step_items:
        lines.append("关键步骤参数：" + "；".join(step_items))
    risks = memory_bullets(memory_section(content, r"风险|注意事项|安全"), 2, 105)
    if risks:
        lines.append("执行警示：" + "；".join(risks))
    pending = memory_bullets(memory_section(content, r"待确认|待补充|未决"), 2, 100)
    if pending:
        lines.append("待确认：" + "；".join(pending))
    return lines or ["方案正文尚未填写关键执行信息。"]


def plan_scope_items(plan: dict) -> list[dict]:
    scopes = plan.get("subexperiments") or []
    if scopes:
        return [{"id": item.get("id", ""), "name": item.get("name", "未命名子实验")} for item in scopes]
    return [{"id": "", "name": "整体方案"}]


def plan_scope_key(scope: dict) -> str:
    return one_line(scope.get("name") or "整体方案").casefold()


def compact_version_delta(project: dict, previous_plan_data: dict, previous_scope: dict, current_plan_data: dict, current_scope: dict) -> list[str]:
    """仅使用仍匹配正文的 AI 参数分析；不退化为大段文本 diff。"""
    try:
        _, previous_content = plan_markdown_content(project, previous_plan_data["id"], previous_scope.get("id", ""))
        _, current_content = plan_markdown_content(project, current_plan_data["id"], current_scope.get("id", ""))
        if not current_content:
            return ["当前版本尚未填写独立方案书；不可默认沿用上一版。"]
        if previous_content == current_content:
            return []
        _, _, current_path = plan_content_target(project, current_plan_data["id"], current_scope.get("id", ""))
        stored = decode_plan_version_analysis(read_markdown_document(current_path)["meta"].get(PLAN_ANALYSIS_META_KEY))
        basis = stored.get("basis", {}) if isinstance(stored, dict) else {}
        if (
            basis.get("current_plan_id") != current_plan_data.get("id")
            or basis.get("previous_plan_id") != previous_plan_data.get("id")
            or basis.get("current_content") != plan_analysis_fingerprint(current_content)
            or basis.get("previous_content") != plan_analysis_fingerprint(previous_content)
        ):
            return ["方案正文已改动，但尚未生成可复用的参数分析；请在方案书中点击“查看版本改动”。"]
        analysis = normalize_plan_version_analysis(stored)
    except (ApiError, OSError, KeyError):
        return ["方案正文已改动，但尚未生成可复用的参数分析；请在方案书中点击“查看版本改动”。"]
    changes = analysis.get("changes", [])
    if not changes:
        return ["AI 未识别出实验步骤中的实际参数改动。"]
    priority = re.compile(r"热解|煅烧|烧结|升温|保温|反应温度|干燥|洗涤|质量|体积|浓度|比例|转速|压力|气氛|溶剂")
    ordered_changes = sorted(changes, key=lambda change: (0 if priority.search(str(change.get("parameter", ""))) else 1))
    result = []
    for change in ordered_changes[:12]:
        parameter = memory_text(change.get("parameter"), 90)
        before = memory_text(change.get("before"), 100) or "—"
        after = memory_text(change.get("after"), 100) or "—"
        kind = change.get("kind", "调整")
        if kind == "新增":
            result.append(f"新增 {parameter}={after}")
        elif kind == "删除":
            result.append(f"删除 {parameter}（原为 {before}）")
        else:
            result.append(f"{parameter}：{before} → {after}")
    if len(ordered_changes) > len(result):
        result.append(f"另有 {len(ordered_changes) - len(result)} 项低优先级步骤变动，详见原始方案")
    return result


def compact_plan_memory_sections(project: dict, heading_level: int) -> list[str]:
    plans = sorted(list_plans(project), key=lambda item: item.get("createdAt", ""))
    if not plans:
        return [f"{'#' * heading_level} 当前实验方案\n\n- 暂无实验方案。"]
    families: dict[str, list[dict]] = {}
    for plan in plans:
        key = one_line(plan.get("name") or plan.get("id")).casefold()
        families.setdefault(key, []).append(plan)
    sections = [f"{'#' * heading_level} 当前有效实验方案（执行基线，非实验结果）"]
    for versions in families.values():
        versions.sort(key=lambda item: item.get("createdAt", ""))
        current = versions[-1]
        versions_text = " → ".join(one_line(item.get("version") or "未命名版本") for item in versions)
        lines = [f"{'#' * (heading_level + 1)} {current.get('name') or '未命名方案'} · 当前 {current.get('version') or '未命名版本'}", "", f"- 版本链：{versions_text}"]
        description = memory_text(current.get("description"), 220)
        if description and not memory_is_placeholder(description):
            lines.append(f"- 方案说明：{description}")
        occurrences_by_scope: dict[str, list[tuple[dict, dict]]] = {}
        for version in versions:
            for candidate in plan_scope_items(version):
                occurrences_by_scope.setdefault(plan_scope_key(candidate), []).append((version, candidate))
        for scope in plan_scope_items(current):
            occurrences = occurrences_by_scope.get(plan_scope_key(scope), [])
            if not occurrences:
                continue
            baseline_plan, baseline_scope = occurrences[0]
            lines.extend(["", f"{'#' * (heading_level + 2)} {scope['name']} · 基线 {baseline_plan.get('version') or '未命名版本'}"])
            try:
                _, baseline_content = plan_markdown_content(project, baseline_plan["id"], baseline_scope.get("id", ""))
                lines.extend(f"- {item}" for item in compact_plan_baseline(baseline_content))
            except (ApiError, OSError):
                lines.append("- 未找到可读取的方案正文。")
            for index in range(1, len(occurrences)):
                previous_plan_data, previous_scope = occurrences[index - 1]
                current_plan_data, current_scope = occurrences[index]
                delta = compact_version_delta(project, previous_plan_data, previous_scope, current_plan_data, current_scope)
                if delta:
                    lines.append(f"- {current_plan_data.get('version') or '未命名版本'} 相较 {previous_plan_data.get('version') or '上一版本'}：" + "；".join(delta))
        sections.append("\n".join(lines))
    return sections


def compact_log_summary(content: str) -> str:
    important = []
    for _, title, body in memory_heading_blocks(content):
        if re.search(r"现象|结果|结论|问题|异常|偏差|注意|实验记录|数据", title):
            important.extend(memory_bullets(body, 2, 150))
    if not important:
        for _, title, body in memory_heading_blocks(content):
            if re.search(r"原始输入|导入|图片", title):
                continue
            important.extend(memory_bullets(body, 2, 150))
    unique = []
    seen = set()
    for item in important:
        key = re.sub(r"\s+", "", item).casefold()
        if key and key not in seen and not memory_is_placeholder(item):
            seen.add(key)
            unique.append(item)
        if len(unique) >= 4:
            break
    return "；".join(unique)


def compact_log_memory_section(project: dict, heading_level: int) -> Optional[str]:
    paths = sorted(list_log_paths(project), key=lambda path: path.stat().st_mtime, reverse=True)[:4]
    if not paths:
        return None
    lines = [f"{'#' * heading_level} 近期实验事实、问题与踩坑点（原始记录）", ""]
    for path in paths:
        doc = read_markdown_document(path)
        date = meta_value(doc["meta"], "date", path.stem[:10])
        relation = " · ".join(filter(None, [meta_value(doc["meta"], "plan_name"), meta_value(doc["meta"], "plan_version"), meta_value(doc["meta"], "subexperiment_name")]))
        summary = compact_log_summary(doc["content"])
        label = f"{date}{(' · ' + relation) if relation else ''}"
        lines.append(f"- {label}：{summary or '尚未提取到现象、问题或结论；请查阅原始日志。'}")
    return "\n".join(lines)


def compact_conversation_memory_section(project: dict, heading_level: int) -> Optional[str]:
    directory = project["dir"] / CONVERSATIONS_FOLDER
    if not directory.is_dir():
        return None
    paths = sorted(directory.glob("*.md"), key=lambda path: path.stat().st_mtime, reverse=True)[:3]
    keyword = re.compile(r"结论|问题|异常|失败|风险|注意|待验证|下一步|建议|原因|优化")
    lines = []
    for path in paths:
        doc = read_markdown_document(path)
        fragments = []
        for match in MESSAGE_RE.finditer(doc["content"]):
            for part in re.split(r"(?<=[。；;！？!?])\s*", match.group(3)):
                text = memory_text(part, 160)
                if text and keyword.search(text):
                    fragments.append(text)
                if len(fragments) >= 2:
                    break
            if len(fragments) >= 2:
                break
        if fragments:
            lines.append(f"- {meta_value(doc['meta'], 'title', path.stem)}：{'；'.join(fragments)}")
    if not lines:
        return None
    return f"{'#' * heading_level} 近期讨论要点（未验证）\n\n" + "\n".join(lines)


def compact_manual_memory(project: dict) -> str:
    path = project["dir"] / "AGENTS.md"
    if not path.is_file():
        return ""
    content = AUTO_BLOCK_RE.sub("", path.read_text(encoding="utf-8"))
    lines = []
    for raw in content.splitlines():
        line = raw.strip()
        if not line or re.match(r"^#\s+", line) or "此文件可作为后续 AI 对话" in line:
            continue
        lines.append(line)
    return memory_text(" ".join(lines), 700)


def compact_project_memory_sections(project: dict, heading_level: int = 2) -> list[str]:
    readme = read_markdown_document(project["dir"] / "README.md")
    project_lines = []
    description = memory_text(meta_value(readme["meta"], "description"), 320)
    important = memory_text(meta_value(readme["meta"], "important_info"), 520)
    manual = compact_manual_memory(project)
    if description and not memory_is_placeholder(description):
        project_lines.append(f"- 研究目标/范围：{description}")
    if important and not memory_is_placeholder(important):
        project_lines.append(f"- 固定信息与约束：{important}")
    if manual and not memory_is_placeholder(manual):
        project_lines.append(f"- 人工补充：{manual}")
    sections = [f"{'#' * heading_level} 项目要点\n\n" + ("\n".join(project_lines) if project_lines else "- 项目目标与固定约束尚未填写。")]
    sections.extend(compact_plan_memory_sections(project, heading_level))
    logs = compact_log_memory_section(project, heading_level)
    if logs:
        sections.append(logs)
    conversations = compact_conversation_memory_section(project, heading_level)
    if conversations:
        sections.append(conversations)
    return sections


def compact_project_memory_markdown(project: dict) -> str:
    name = meta_value(project["meta"], "name", project["slug"])
    return "\n\n".join([
        f"# {name} · 精简项目记忆",
        "> 用于补充模型上下文：仅保留当前执行基线、后续版本参数增量，以及近期事实、问题和待确认项。",
        "> 这不是完整 SOP 或行为指令；请结合当前用户问题独立推理。原始 Markdown 仍保留在项目目录中供追溯。",
        *compact_project_memory_sections(project, 2),
        "## 证据状态与使用建议\n\n- 方案基线与版本变动是当前计划/操作条件，不代表实验已完成或结论已成立。\n- 日志摘要来自原始记录；对话摘录属于未验证讨论。\n- 将本记忆作为参考而非约束：优先响应当前用户问题，独立判断；信息冲突或不足时说明原因并建议回查原始资料。",
    ]).strip() + "\n"


def update_agents(project: dict) -> None:
    """实时更新 AGENTS.md：默认 AI 上下文也使用精简、增量式策略。"""
    readme = read_markdown_document(project["dir"] / "README.md")
    auto = "\n".join([
        AUTO_START,
        "## 自动更新的精简项目上下文",
        "",
        *compact_project_memory_sections(project, 3),
        "",
        "### 使用建议",
        "",
        "- 此处是分层参考上下文，不替代当前用户问题或模型的独立推理。",
        "- 方案是执行基线；日志是原始记录；对话摘录是未验证讨论。信息不足或冲突时请说明并回查原始 Markdown。",
        AUTO_END,
    ])
    path = project["dir"] / "AGENTS.md"
    if path.is_file():
        old = path.read_text(encoding="utf-8")
    else:
        name = meta_value(readme["meta"], "name", project["slug"])
        old = f"# {name} · 项目协作记忆\n\n可在自动区块外手工补充长期有效信息。\n"
    stripped = AUTO_BLOCK_RE.sub("", old).rstrip()
    write_markdown(path, stripped + "\n\n" + auto + "\n")


# --------------------------------------------------------------------------- #
# 实验方案
# --------------------------------------------------------------------------- #
LEGACY_PLANS_FOLDER = "实验方案"
PLAN_FILE_NAME = "方案.md"
SUBEXPERIMENT_FILE_NAME = "README.md"
SUBEXPERIMENT_PLAN_FILE_NAME = "实验方案.md"
LOGS_FOLDER = "实验日志"
CONVERSATIONS_FOLDER = "对话记录"
PLAN_IMPORTS_FOLDER = "导入资料"
LEGACY_MEMORY_FOLDERS = {"scihub-memory", "sciMemory"}
RESERVED_PLAN_FOLDERS = {"实验日志", "对话记录", "实验方案", *LEGACY_MEMORY_FOLDERS, "__pycache__"}
INVALID_FOLDER_CHARS = re.compile(r'[\\/:*?"<>|]+')


def legacy_plans_dir(project: dict) -> Path:
    """旧版本方案文件位置；只读取，不自动迁移或删除。"""
    return project["dir"] / LEGACY_PLANS_FOLDER


def safe_folder_name(value: Any, label: str) -> str:
    name = INVALID_FOLDER_CHARS.sub("-", one_line(value)).strip(" .-")
    if not name or name in {".", ".."}:
        raise ApiError(f"{label}无效。")
    if name.casefold() in {item.casefold() for item in RESERVED_PLAN_FOLDERS}:
        raise ApiError(f"{label}与项目保留目录冲突。")
    return name[:80]


def project_plan_paths(project: dict) -> list[Path]:
    paths = []
    for child in project["dir"].iterdir():
        if not child.is_dir() or child.name.casefold() in {item.casefold() for item in RESERVED_PLAN_FOLDERS}:
            continue
        plan_file = child / PLAN_FILE_NAME
        if read_markdown_document(plan_file)["meta"].get("kind") == "experiment_plan":
            paths.append(plan_file)
    return paths


def parse_subexperiments(content: str) -> list[dict]:
    """兼容旧版单文件方案中的 Markdown 标题结构。"""
    subexperiments = []
    for match in SUBEXPERIMENT_RE.finditer(content):
        subexperiments.append({
            "id": match.group(1),
            "name": match.group(2).strip(),
            "description": match.group(3).strip(),
            "folder": "",
            "entries": [],
        })
    return subexperiments


def list_workspace_entries(directory: Path, hidden_names: set[str]) -> list[dict]:
    if not directory.is_dir():
        return []
    entries = []
    for path in sorted(directory.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold())):
        if path.name in hidden_names or path.name.startswith("."):
            continue
        entries.append({"name": path.name, "kind": "folder" if path.is_dir() else "file"})
    return entries


def read_folder_subexperiments(plan_dir: Path, plan_id: str) -> list[dict]:
    subexperiments = []
    for child in sorted(plan_dir.iterdir(), key=lambda item: item.name.casefold()):
        if not child.is_dir() or child.name == LOGS_FOLDER:
            continue
        doc = read_markdown_document(child / SUBEXPERIMENT_FILE_NAME)
        if doc["meta"].get("kind") != "experiment_subexperiment":
            continue
        if meta_value(doc["meta"], "plan_id") != plan_id:
            continue
        subexperiments.append({
            "id": meta_value(doc["meta"], "id", child.name),
            "name": meta_value(doc["meta"], "name", child.name),
            "description": meta_value(doc["meta"], "description"),
            "folder": child.name,
            "entries": list_workspace_entries(child, {SUBEXPERIMENT_FILE_NAME, SUBEXPERIMENT_PLAN_FILE_NAME, LOGS_FOLDER}),
        })
    return subexperiments


def read_folder_plan(path: Path) -> dict:
    doc = read_markdown_document(path)
    if doc["meta"].get("kind") != "experiment_plan":
        raise ApiError("实验方案文件无效。", HTTPStatus.NOT_FOUND)
    plan_dir = path.parent
    plan_id = meta_value(doc["meta"], "id")
    subexperiments = read_folder_subexperiments(plan_dir, plan_id)
    return {
        "id": plan_id,
        "name": meta_value(doc["meta"], "name", plan_dir.name),
        "version": meta_value(doc["meta"], "version", plan_dir.name),
        "description": meta_value(doc["meta"], "description"),
        "createdAt": meta_value(doc["meta"], "created_at"),
        "updatedAt": meta_value(doc["meta"], "updated_at"),
        "folder": plan_dir.name,
        "relativePath": f"{plan_dir.name}/{PLAN_FILE_NAME}",
        "storage": "folder",
        "entries": list_workspace_entries(plan_dir, {PLAN_FILE_NAME, LOGS_FOLDER, *(item["folder"] for item in subexperiments)}),
        "subexperiments": subexperiments,
    }


def read_legacy_plan(path: Path) -> dict:
    doc = read_markdown_document(path)
    if doc["meta"].get("kind") != "experiment_plan":
        raise ApiError("实验方案文件无效。", HTTPStatus.NOT_FOUND)
    plan_id = meta_value(doc["meta"], "id", path.stem)
    return {
        "id": plan_id,
        "name": meta_value(doc["meta"], "name", plan_id),
        "version": meta_value(doc["meta"], "version"),
        "description": meta_value(doc["meta"], "description"),
        "createdAt": meta_value(doc["meta"], "created_at"),
        "updatedAt": meta_value(doc["meta"], "updated_at"),
        "folder": "",
        "relativePath": f"{LEGACY_PLANS_FOLDER}/{path.name}",
        "storage": "legacy",
        "entries": [],
        "subexperiments": parse_subexperiments(doc["content"]),
    }


def read_plan(project: dict, plan_id: str) -> dict:
    if not plan_id or not PLAN_ID_RE.match(plan_id):
        raise ApiError("实验方案标识无效。")
    for path in project_plan_paths(project):
        plan = read_folder_plan(path)
        if plan["id"] == plan_id:
            return plan
    legacy_path = legacy_plans_dir(project) / f"{plan_id}.md"
    return read_legacy_plan(legacy_path)


def list_plans(project: dict) -> list[dict]:
    items = []
    migrated_sources, folder_plan_ids = migrated_legacy_plan_sources(project)
    for path in project_plan_paths(project):
        try:
            items.append(read_folder_plan(path))
        except ApiError:
            continue
    legacy_dir = legacy_plans_dir(project)
    if legacy_dir.is_dir():
        for path in legacy_dir.glob("*.md"):
            try:
                legacy = read_legacy_plan(path)
                relative_source = path.relative_to(project["dir"]).as_posix()
                if relative_source in migrated_sources or legacy["id"] in folder_plan_ids:
                    continue
                items.append(legacy)
            except ApiError:
                continue
    return sorted(items, key=lambda item: item.get("updatedAt", ""), reverse=True)


def normalise_subexperiments(value: Any) -> list[dict]:
    if not isinstance(value, list):
        return []
    result = []
    used_folders: set[str] = set()
    used_names: set[str] = set()
    for index, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            continue
        name = one_line(item.get("name"))
        if not name:
            continue
        name_key = name.casefold()
        if name_key in used_names:
            continue
        used_names.add(name_key)
        base = safe_folder_name(name, "子实验文件夹名称")
        folder = base
        suffix = 2
        while folder.casefold() in used_folders:
            folder = f"{base}-{suffix}"
            suffix += 1
        used_folders.add(folder.casefold())
        result.append({
            "id": f"sub-{index}",
            "name": name,
            "description": str(item.get("description", "")).strip(),
            "folder": folder,
        })
    return result


def migrated_legacy_plan_sources(project: dict) -> tuple[set[str], set[str]]:
    """返回已无损升级的旧方案来源和当前文件夹方案 ID。"""
    sources: set[str] = set()
    plan_ids: set[str] = set()
    for plan_path in project_plan_paths(project):
        doc = read_markdown_document(plan_path)
        plan_id = meta_value(doc["meta"], "id")
        if plan_id:
            plan_ids.add(plan_id)
        source = meta_value(doc["meta"], "scihub_migrated_from").replace("\\", "/")
        if source:
            sources.add(source)
    return sources, plan_ids


def migrated_legacy_folder_name(project: dict, legacy_plan: dict, legacy_path: Path) -> str:
    """为旧版单文件方案选择一个绝不覆盖现有目录的目标名称。"""
    preferred = legacy_plan["version"] or legacy_plan["name"] or legacy_path.stem
    base = safe_folder_name(preferred, "旧版实验方案文件夹名称")
    candidate = base
    index = 2
    while (project["dir"] / candidate).exists():
        candidate = safe_folder_name(f"{base[:62]}-旧版{index}", "旧版实验方案文件夹名称")
        index += 1
    return candidate


def migrate_legacy_plan_file(project: dict, legacy_path: Path, known_sources: set[str], known_plan_ids: set[str]) -> str:
    """把可识别的旧版方案复制为当前目录结构，原 Markdown 始终保留不动。"""
    if legacy_path.is_symlink() or not legacy_path.is_file():
        return ""
    relative_source = legacy_path.relative_to(project["dir"]).as_posix()
    if relative_source in known_sources:
        return ""
    legacy_plan = read_legacy_plan(legacy_path)
    if legacy_plan["id"] in known_plan_ids:
        return ""

    legacy_doc = read_markdown_document(legacy_path)
    folder = migrated_legacy_folder_name(project, legacy_plan, legacy_path)
    target_dir = project["dir"] / folder
    target_path = target_dir / PLAN_FILE_NAME
    target_meta = dict(legacy_doc["meta"])
    target_meta.update({
        "kind": "experiment_plan",
        "id": legacy_plan["id"],
        "name": legacy_plan["name"],
        "version": legacy_plan["version"] or folder,
        "description": legacy_plan["description"],
        "created_at": legacy_plan["createdAt"] or now_iso(),
        "updated_at": legacy_plan["updatedAt"] or now_iso(),
        "scihub_migrated_from": relative_source,
    })
    content = legacy_doc["content"].strip()
    if not content:
        content = (
            f"# {legacy_plan['name']} · {target_meta['version']}\n\n"
            f"## 方案说明\n\n{legacy_plan['description'] or '尚未填写。'}\n"
        )
    write_markdown(target_path, front_matter(target_meta) + content.rstrip() + "\n")

    used_folders: set[str] = set()
    for index, subexperiment in enumerate(legacy_plan["subexperiments"], start=1):
        name = one_line(subexperiment.get("name"))
        if not name:
            continue
        base = safe_folder_name(name, "子实验文件夹名称")
        sub_folder = base
        suffix = 2
        while sub_folder.casefold() in used_folders:
            sub_folder = safe_folder_name(f"{base[:62]}-{suffix}", "子实验文件夹名称")
            suffix += 1
        used_folders.add(sub_folder.casefold())
        sub_id = one_line(subexperiment.get("id")) or f"sub-{index}"
        sub_description = str(subexperiment.get("description", "")).strip()
        sub_meta = {
            "kind": "experiment_subexperiment",
            "id": sub_id,
            "plan_id": legacy_plan["id"],
            "name": name,
            "description": sub_description,
            "created_at": target_meta["created_at"],
            "scihub_migrated_from": f"{relative_source}#{sub_id}",
        }
        sub_content = f"# {name}\n\n{sub_description or '尚未填写子实验说明。'}\n"
        write_markdown(target_dir / sub_folder / SUBEXPERIMENT_FILE_NAME, front_matter(sub_meta) + sub_content)

    known_sources.add(relative_source)
    known_plan_ids.add(legacy_plan["id"])
    return folder


def synchronise_existing_project(project: dict) -> list[str]:
    """为旧项目补齐可逆的结构升级，不删除、移动或覆盖原始 Markdown。"""
    changes: list[str] = []
    for folder in (LOGS_FOLDER, CONVERSATIONS_FOLDER):
        path = project["dir"] / folder
        if not path.exists():
            path.mkdir(parents=True, exist_ok=False)
            changes.append(folder)

    known_sources, known_plan_ids = migrated_legacy_plan_sources(project)
    legacy_dir = legacy_plans_dir(project)
    if legacy_dir.is_dir() and not legacy_dir.is_symlink():
        for legacy_path in sorted(legacy_dir.glob("*.md"), key=lambda path: path.name.casefold()):
            try:
                folder = migrate_legacy_plan_file(project, legacy_path, known_sources, known_plan_ids)
            except (ApiError, OSError, ValueError):
                continue
            if folder:
                changes.append(f"旧版方案 → {folder}")

    agents_path = project["dir"] / "AGENTS.md"
    agents_missing = not agents_path.is_file()
    agents_needs_memory_upgrade = agents_missing or "自动更新的精简项目上下文" not in agents_path.read_text(encoding="utf-8")
    if changes or agents_needs_memory_upgrade:
        update_agents(project)
        if agents_missing:
            changes.append("AGENTS.md")
        elif agents_needs_memory_upgrade:
            changes.append("AGENTS.md（精简记忆升级）")
    return changes


def synchronise_all_existing_projects() -> dict[str, list[str]]:
    """启动时扫描已存在项目，使升级不依赖用户逐个重新创建项目。"""
    updated: dict[str, list[str]] = {}
    if not PROJECTS_ROOT.is_dir():
        return updated
    for child in sorted(PROJECTS_ROOT.iterdir(), key=lambda path: path.name.casefold()):
        if not child.is_dir() or child.is_symlink():
            continue
        try:
            project = load_project(child.name)
        except (ApiError, OSError, ValueError):
            continue
        changes = project.get("compatibilityUpdates") or []
        if changes:
            updated[child.name] = changes
    return updated


def write_plan(project: dict, payload: dict) -> dict:
    name = one_line(payload.get("name"))
    version = one_line(payload.get("version"))
    if not name:
        raise ApiError("请填写实验方案名称。")
    if not version:
        raise ApiError("请填写方案版本，例如 V1 或 V2。")
    folder = safe_folder_name(version, "方案版本文件夹名称")
    plan_dir = project["dir"] / folder
    if plan_dir.exists():
        raise ApiError(f"项目中已存在“{folder}”文件夹；请使用新的方案版本名称。")
    plan_id = "plan-" + datetime.now().strftime("%Y%m%d%H%M%S%f")[:-3]
    now = now_iso()
    description = str(payload.get("description", "")).strip()
    plan_content = str(payload.get("planContent", "")).strip()
    source_plan_id = one_line(payload.get("inheritSubexperimentsFromPlanId"))
    inherited_subexperiments = []
    if source_plan_id:
        source_plan = read_plan(project, source_plan_id)
        inherited_subexperiments = [{"name": item["name"]} for item in source_plan["subexperiments"]]
    # Explicitly entered entries take priority over inherited titles.  The inherited
    # entries intentionally contain no description or plan content.
    subexperiments = normalise_subexperiments(list(payload.get("subexperiments") or []) + inherited_subexperiments)
    meta = {
        "kind": "experiment_plan",
        "id": plan_id,
        "name": name,
        "version": version,
        "description": description,
        "created_at": now,
        "updated_at": now,
    }
    sections = [f"# {name} · {version}", f"## 方案说明\n\n{description or '尚未填写。'}"]
    if plan_content:
        sections.append(
            "## 实验方案\n\n<!-- PLAN-CONTENT:START -->\n"
            + plan_content
            + "\n<!-- PLAN-CONTENT:END -->"
        )
    sections.append("## 子实验")
    if subexperiments:
        sections.extend(f"- [{item['name']}]({item['folder']}/{SUBEXPERIMENT_FILE_NAME})" for item in subexperiments)
    else:
        sections.append("尚未添加子实验。")
    write_markdown(plan_dir / PLAN_FILE_NAME, front_matter(meta) + "\n\n".join(sections) + "\n")
    for item in subexperiments:
        sub_meta = {
            "kind": "experiment_subexperiment",
            "id": item["id"],
            "plan_id": plan_id,
            "name": item["name"],
            "description": item["description"],
            "created_at": now,
        }
        content = f"# {item['name']}\n\n{item['description'] or '尚未填写子实验说明。'}\n"
        write_markdown(plan_dir / item["folder"] / SUBEXPERIMENT_FILE_NAME, front_matter(sub_meta) + content)
    return read_plan(project, plan_id)


def plan_workspace_dir(project: dict, plan_id: str, subexperiment_id: str = "") -> Path:
    plan = read_plan(project, plan_id)
    if plan["storage"] != "folder" or not plan["folder"]:
        raise ApiError("旧版单文件方案不能新增目录；请新建 V1/V2 文件夹方案。")
    directory = project["dir"] / plan["folder"]
    if subexperiment_id:
        subexperiment = next((item for item in plan["subexperiments"] if item["id"] == subexperiment_id), None)
        if not subexperiment:
            raise ApiError("未找到所选子实验。")
        directory = directory / subexperiment["folder"]
    return directory


def plan_content_target(project: dict, plan_id: str, subexperiment_id: str = "") -> tuple[dict, Optional[dict], Path]:
    """返回指定方案正文的安全存储位置。

    根方案没有子实验时保存到 ``Vx/方案.md``；一旦创建子实验，方案正文必须
    保存到对应子实验目录的 ``实验方案.md``，避免不同子实验的资料混在一起。
    """
    plan = read_plan(project, plan_id)
    subexperiment_id = one_line(subexperiment_id)
    if plan["storage"] != "folder" or not plan["folder"]:
        if subexperiment_id:
            raise ApiError("旧版单文件方案不支持子实验方案。")
        return plan, None, legacy_plans_dir(project) / f"{plan_id}.md"

    plan_dir = project["dir"] / plan["folder"]
    if subexperiment_id:
        subexperiment = next((item for item in plan["subexperiments"] if item["id"] == subexperiment_id), None)
        if not subexperiment:
            raise ApiError("未找到所选子实验。")
        return plan, subexperiment, plan_dir / subexperiment["folder"] / SUBEXPERIMENT_PLAN_FILE_NAME
    return plan, None, plan_dir / PLAN_FILE_NAME


def subexperiment_plan_document(
    plan: dict, subexperiment: dict, plan_content: str, existing_meta: Optional[dict] = None, existing_content: str = ""
) -> str:
    """为子实验创建独立的方案 Markdown，或保留原有元数据后更新正文。"""
    meta = dict(existing_meta or {})
    meta.update({
        "kind": "experiment_subexperiment_plan",
        "plan_id": plan["id"],
        "subexperiment_id": subexperiment["id"],
        "name": subexperiment["name"],
        "updated_at": now_iso(),
    })
    if not meta.get("created_at"):
        meta["created_at"] = now_iso()
    heading = f"# {subexperiment['name']} · 实验方案\n\n"
    content = existing_content or heading
    if not re.search(r"(?m)^# [^\r\n]*", content):
        content = heading + content.lstrip()
    return front_matter(meta) + replace_plan_content(content, plan_content).rstrip() + "\n"


def write_plan_entry(project: dict, plan_id: str, payload: dict) -> dict:
    entry_kind = one_line(payload.get("kind"))
    if entry_kind not in {"file", "folder"}:
        raise ApiError("只能新增 Markdown 文件或子文件夹。")
    name = safe_folder_name(payload.get("name"), "文件或文件夹名称")
    directory = plan_workspace_dir(project, plan_id, one_line(payload.get("subexperimentId")))
    target = directory / (f"{name}.md" if entry_kind == "file" and not name.lower().endswith(".md") else name)
    if target.exists():
        raise ApiError("同名文件或文件夹已存在。")
    if entry_kind == "folder":
        target.mkdir(parents=False)
    else:
        title = one_line(payload.get("title"),) or name.removesuffix(".md")
        content = str(payload.get("content", "")).strip()
        write_markdown(target, f"# {title}\n\n{content}\n")
    return read_plan(project, plan_id)


def add_subexperiment(project: dict, plan_id: str, payload: dict) -> dict:
    plan = read_plan(project, plan_id)
    if plan["storage"] != "folder" or not plan["folder"]:
        raise ApiError("旧版单文件方案不能新增子实验；请新建 V1/V2 文件夹方案。")
    name = one_line(payload.get("name"))
    if not name:
        raise ApiError("请填写子实验名称。")
    folder = safe_folder_name(name, "子实验文件夹名称")
    plan_dir = project["dir"] / plan["folder"]
    target = plan_dir / folder
    if target.exists():
        raise ApiError("同名子实验文件夹已存在。")
    now = now_iso()
    sub_meta = {
        "kind": "experiment_subexperiment",
        "id": "sub-" + datetime.now().strftime("%Y%m%d%H%M%S%f")[:-3],
        "plan_id": plan_id,
        "name": name,
        "description": str(payload.get("description", "")).strip(),
        "created_at": now,
    }
    content = f"# {name}\n\n{sub_meta['description'] or '尚未填写子实验说明。'}\n"
    write_markdown(target / SUBEXPERIMENT_FILE_NAME, front_matter(sub_meta) + content)
    plan_path = plan_dir / PLAN_FILE_NAME
    plan_doc = read_markdown_document(plan_path)
    plan_meta = dict(plan_doc["meta"])
    plan_meta["updated_at"] = now
    plan_content = plan_doc["content"].rstrip() + f"\n\n- [{name}]({folder}/{SUBEXPERIMENT_FILE_NAME})\n"
    write_markdown(plan_path, front_matter(plan_meta) + plan_content)
    return read_plan(project, plan_id)


def replace_plan_content(content: str, plan_content: str) -> str:
    """只替换 SciHub 管理的方案正文区，不影响子实验目录和用户其他笔记。"""
    section = (
        "## 实验方案\n\n<!-- PLAN-CONTENT:START -->\n"
        + (plan_content.strip() or "尚未填写实验方案正文。")
        + "\n<!-- PLAN-CONTENT:END -->"
    )
    marker_pattern = re.compile(
        r"(?s)## 实验方案\r?\n\r?\n<!-- PLAN-CONTENT:START -->.*?<!-- PLAN-CONTENT:END -->"
    )
    if marker_pattern.search(content):
        return marker_pattern.sub(section, content, count=1)
    # 兼容旧版本创建的方案：正文区位于“子实验”标题之前。
    old_section = re.compile(r"(?ms)^## 实验方案\r?\n.*?(?=^## 子实验\r?$|\Z)")
    if old_section.search(content):
        return old_section.sub(section + "\n\n", content, count=1)
    subexperiment_heading = re.search(r"(?m)^## 子实验\r?$", content)
    if subexperiment_heading:
        return content[:subexperiment_heading.start()].rstrip() + "\n\n" + section + "\n\n" + content[subexperiment_heading.start():]
    return content.rstrip() + "\n\n" + section + "\n"


def update_plan(project: dict, plan_id: str, payload: dict) -> dict:
    """更新由 SciHub 创建的方案说明，同时保留用户在方案文件中的其他内容。"""
    plan = read_plan(project, plan_id)
    if plan["storage"] != "folder" or not plan["folder"]:
        raise ApiError("旧版单文件方案暂不支持在界面编辑；请新建文件夹方案后继续维护。")
    name = one_line(payload.get("name"))
    if not name:
        raise ApiError("请填写实验方案名称。")
    description = str(payload.get("description", "")).strip()
    has_plan_content = "planContent" in payload
    plan_content = str(payload.get("planContent", "")).strip()
    source_plan_id = one_line(payload.get("inheritSubexperimentsFromPlanId"))
    source_plan = None
    inherited_titles: list[str] = []
    if source_plan_id:
        if source_plan_id == plan_id:
            raise ApiError("不能从当前方案版本自身沿用子实验。")
        source_plan = read_plan(project, source_plan_id)
        existing_names = {item["name"].casefold() for item in plan["subexperiments"]}
        inherited_folders: set[str] = set()
        plan_dir = project["dir"] / plan["folder"]
        for item in source_plan["subexperiments"]:
            title = item["name"]
            title_key = title.casefold()
            if title_key in existing_names:
                continue
            folder = safe_folder_name(title, "子实验文件夹名称")
            if folder.casefold() in inherited_folders or (plan_dir / folder).exists():
                raise ApiError(f"无法沿用子实验“{title}”：当前方案已存在同名目录。")
            inherited_titles.append(title)
            existing_names.add(title_key)
            inherited_folders.add(folder.casefold())
    path = project["dir"] / plan["folder"] / PLAN_FILE_NAME
    doc = read_markdown_document(path)
    meta = dict(doc["meta"])
    meta.update({
        "name": name,
        "description": description,
        "updated_at": now_iso(),
    })
    content = doc["content"]
    heading = f"# {name} · {plan['version']}"
    if re.search(r"(?m)^# [^\r\n]*", content):
        content = re.sub(r"(?m)^# [^\r\n]*", heading, content, count=1)
    else:
        content = heading + "\n\n" + content.lstrip()
    description_section = "## 方案说明\n\n" + (description or "尚未填写。")
    if re.search(r"(?ms)^## 方案说明\r?\n.*?(?=^## |\Z)", content):
        content = re.sub(
            r"(?ms)^## 方案说明\r?\n.*?(?=^## |\Z)",
            description_section + "\n\n",
            content,
            count=1,
        )
    else:
        remaining = content.split("\n", 1)[1] if "\n" in content else ""
        content = heading + "\n\n" + description_section + "\n\n" + remaining.lstrip()
    if has_plan_content:
        content = replace_plan_content(content, plan_content)
    write_markdown(path, front_matter(meta) + content.rstrip() + "\n")
    if source_plan:
        for title in inherited_titles:
            # Only the title is inherited.  ``add_subexperiment`` creates a fresh
            # Markdown folder and never copies the source description or plan body.
            add_subexperiment(project, plan_id, {"name": title})
    return read_plan(project, plan_id)


def update_plan_content(project: dict, plan_id: str, plan_content: str, subexperiment_id: str = "") -> dict:
    """保存 AI 生成或用户审核后的方案正文；持久化内容始终为 Markdown。"""
    plan, subexperiment, path = plan_content_target(project, plan_id, subexperiment_id)
    if plan["storage"] != "folder" or not plan["folder"]:
        raise ApiError("旧版单文件方案暂不支持写入方案正文；请新建 V1/V2 文件夹方案。")
    doc = read_markdown_document(path)
    if subexperiment:
        # 正文一旦保存，原有 AI 版本参数分析不再对应当前文本，必须重新同步。
        doc["meta"].pop(PLAN_ANALYSIS_META_KEY, None)
        write_markdown(
            path,
            subexperiment_plan_document(plan, subexperiment, plan_content, doc["meta"], doc["content"]),
        )
        return read_plan(project, plan_id)
    meta = dict(doc["meta"])
    meta["updated_at"] = now_iso()
    meta.pop(PLAN_ANALYSIS_META_KEY, None)
    write_markdown(
        path,
        front_matter(meta) + replace_plan_content(doc["content"], plan_content).rstrip() + "\n",
    )
    return read_plan(project, plan_id)


def plan_deletion_paths(project: dict, plan_id: str) -> tuple[dict, Path, list[Path], list[Path]]:
    """列出待删除的已知方案目录内容；任何链接或异常类型均拒绝删除。"""
    plan = read_plan(project, plan_id)
    if plan["storage"] != "folder" or not plan["folder"]:
        raise ApiError("旧版单文件方案不会由本功能删除，请手动核对后处理。")
    project_root = project["dir"].resolve()
    target = (project_root / plan["folder"]).resolve()
    if target.parent != project_root or not target.is_dir() or target.is_symlink():
        raise ApiError("方案目录无效，已拒绝删除。")
    files: list[Path] = []
    directories: list[Path] = []
    for item in sorted(target.rglob("*"), key=lambda path: path.relative_to(target).as_posix().casefold()):
        if item.is_symlink():
            raise ApiError("方案目录包含链接文件，为避免误删已拒绝删除。")
        if item.is_file():
            files.append(item)
        elif item.is_dir():
            directories.append(item)
        else:
            raise ApiError("方案目录包含无法安全识别的条目，已拒绝删除。")
    return plan, target, files, directories


def plan_deletion_preview(project: dict, plan_id: str) -> dict:
    plan, target, files, directories = plan_deletion_paths(project, plan_id)
    root = project["dir"].resolve()
    items = [{"path": target.relative_to(root).as_posix() + "/", "kind": "folder"}]
    items.extend({"path": path.relative_to(root).as_posix() + "/", "kind": "folder"} for path in directories)
    items.extend({"path": path.relative_to(root).as_posix(), "kind": "file"} for path in files)
    return {"plan": plan, "folder": plan["folder"], "items": items}


def delete_plan(project: dict, plan_id: str, confirmation: str) -> None:
    """逐项删除已在确认清单中展示的方案目录；不使用递归删除命令。"""
    plan, target, files, directories = plan_deletion_paths(project, plan_id)
    if confirmation != plan["folder"]:
        raise ApiError("请准确输入方案版本目录名称以确认删除。")
    for path in files:
        path.unlink()
    for path in sorted(directories, key=lambda item: len(item.parts), reverse=True):
        path.rmdir()
    target.rmdir()


def subexperiment_deletion_paths(project: dict, plan_id: str, subexperiment_id: str) -> tuple[dict, dict, Path, list[Path], list[Path]]:
    """列出一个子实验的可核对删除清单，遇到链接或异常条目一律拒绝。"""
    plan = read_plan(project, plan_id)
    if plan["storage"] != "folder" or not plan["folder"]:
        raise ApiError("旧版单文件方案不能由本功能删除子实验。")
    subexperiment = next((item for item in plan["subexperiments"] if item["id"] == subexperiment_id), None)
    if not subexperiment:
        raise ApiError("未找到所选子实验。")
    project_root = project["dir"].resolve()
    plan_dir = (project_root / plan["folder"]).resolve()
    target = (plan_dir / subexperiment["folder"]).resolve()
    if plan_dir.parent != project_root or target.parent != plan_dir or not target.is_dir() or target.is_symlink():
        raise ApiError("子实验目录无效，已拒绝删除。")
    files: list[Path] = []
    directories: list[Path] = []
    for item in sorted(target.rglob("*"), key=lambda path: path.relative_to(target).as_posix().casefold()):
        if item.is_symlink():
            raise ApiError("子实验目录包含链接文件，为避免误删已拒绝删除。")
        if item.is_file():
            files.append(item)
        elif item.is_dir():
            directories.append(item)
        else:
            raise ApiError("子实验目录包含无法安全识别的条目，已拒绝删除。")
    return plan, subexperiment, target, files, directories


def subexperiment_deletion_preview(project: dict, plan_id: str, subexperiment_id: str) -> dict:
    plan, subexperiment, target, files, directories = subexperiment_deletion_paths(project, plan_id, subexperiment_id)
    root = project["dir"].resolve()
    items = [{"path": target.relative_to(root).as_posix() + "/", "kind": "folder"}]
    items.extend({"path": path.relative_to(root).as_posix() + "/", "kind": "folder"} for path in directories)
    items.extend({"path": path.relative_to(root).as_posix(), "kind": "file"} for path in files)
    return {"plan": plan, "subexperiment": subexperiment, "folder": target.relative_to(root).as_posix(), "items": items}


def delete_subexperiment(project: dict, plan_id: str, subexperiment_id: str, confirmation: str) -> dict:
    """逐项删除已展示清单的一个子实验，并保留方案中的其他内容。"""
    plan, subexperiment, target, files, directories = subexperiment_deletion_paths(project, plan_id, subexperiment_id)
    if confirmation != subexperiment["name"]:
        raise ApiError("请准确输入子实验名称以确认删除。")
    plan_path = project["dir"] / plan["folder"] / PLAN_FILE_NAME
    plan_doc = read_markdown_document(plan_path)
    reference = f"- [{subexperiment['name']}]({subexperiment['folder']}/{SUBEXPERIMENT_FILE_NAME})"
    retained_lines = [line for line in plan_doc["content"].splitlines() if line.strip() != reference]
    for path in files:
        path.unlink()
    for path in sorted(directories, key=lambda item: len(item.parts), reverse=True):
        path.rmdir()
    target.rmdir()
    plan_meta = dict(plan_doc["meta"])
    plan_meta["updated_at"] = now_iso()
    write_markdown(plan_path, front_matter(plan_meta) + "\n".join(retained_lines).rstrip() + "\n")
    return read_plan(project, plan_id)


def plan_markdown_content(project: dict, plan_id: str, subexperiment_id: str = "") -> tuple[dict, str]:
    """读取方案正文；不返回 front matter，避免将内部元数据用于版本对比。"""
    plan, _, path = plan_content_target(project, plan_id, subexperiment_id)
    return plan, read_markdown_document(path)["content"].strip()


def previous_plan(project: dict, plan_id: str) -> Optional[dict]:
    """按创建时间找当前方案之前的版本，而不是按最近编辑时间。"""
    plans = sorted(list_plans(project), key=lambda item: item.get("createdAt", ""))
    for index, plan in enumerate(plans):
        if plan["id"] == plan_id:
            return plans[index - 1] if index else None
    return None


def _legacy_text_plan_comparison(project: dict, plan_id: str, subexperiment_id: str = "") -> dict:
    """比较当前方案（或同名子实验）与上一版本的正文。"""
    subexperiment_id = one_line(subexperiment_id)
    current, current_content = plan_markdown_content(project, plan_id, subexperiment_id)
    _, current_subexperiment, _ = plan_content_target(project, plan_id, subexperiment_id)
    current_scope = {"name": current_subexperiment["name"]} if current_subexperiment else None
    previous = previous_plan(project, plan_id)
    if not previous:
        return {"current": current, "previous": None, "currentScope": current_scope, "lines": []}
    previous_subexperiment = None
    if current_subexperiment:
        current_name = current_subexperiment["name"].casefold()
        previous_subexperiment = next(
            (item for item in previous["subexperiments"] if item["name"].casefold() == current_name), None
        )
        if not previous_subexperiment:
            return {
                "current": current,
                "previous": None,
                "currentScope": current_scope,
                "lines": [],
                "message": "上一版本中没有同名子实验，暂无法进行版本对比。",
            }
    previous_plan_data, previous_content = plan_markdown_content(
        project, previous["id"], previous_subexperiment["id"] if previous_subexperiment else ""
    )
    lines = []
    matcher = difflib.SequenceMatcher(
        a=previous_content.splitlines(), b=current_content.splitlines(), autojunk=False
    )
    old_lines = previous_content.splitlines()
    new_lines = current_content.splitlines()
    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        if tag == "equal":
            lines.extend({"kind": "same", "text": line} for line in old_lines[old_start:old_end])
        elif tag == "delete":
            lines.extend({"kind": "removed", "text": line} for line in old_lines[old_start:old_end])
        elif tag == "insert":
            lines.extend({"kind": "added", "text": line} for line in new_lines[new_start:new_end])
        else:
            lines.extend({"kind": "removed", "text": line} for line in old_lines[old_start:old_end])
            lines.extend({"kind": "added", "text": line} for line in new_lines[new_start:new_end])
    previous_scope = {"name": previous_subexperiment["name"]} if previous_subexperiment else None
    return {
        "current": current,
        "previous": previous_plan_data,
        "currentScope": current_scope,
        "previousScope": previous_scope,
        "lines": lines,
    }


def plan_analysis_sections(content: str) -> dict[str, str]:
    """仅摘取供版本分析使用的实验步骤章节。"""
    buckets = {"steps": []}
    active = ""
    active_level = 0
    for raw in content.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", raw)
        if heading:
            level = len(heading.group(1))
            title = re.sub(r"[*_`]", "", heading.group(2)).strip()
            if re.search(r"操作步骤|实验步骤|操作流程|实验流程", title):
                active, active_level = "steps", level
                buckets[active].append(raw)
            elif active and level <= active_level:
                active, active_level = "", 0
            elif active:
                buckets[active].append(raw)
            continue
        if active:
            buckets[active].append(raw)
    return {key: "\n".join(lines).strip() for key, lines in buckets.items()}


def plan_analysis_fingerprint(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def clean_plan_analysis_value(value: Any, limit: int = 320) -> str:
    return one_line(value)[:limit]


def normalize_plan_version_analysis(value: Any) -> dict:
    """校验浏览器端 AI 返回的结构化参数差异，避免任意模型文本写入项目资料。"""
    if not isinstance(value, dict):
        raise ApiError("版本改动分析结果格式无效。")
    raw_changes = value.get("changes", [])
    if not isinstance(raw_changes, list):
        raise ApiError("版本改动分析结果中的 changes 必须是列表。")
    changes = []
    seen = set()
    section_map = {
        "步骤": "实验步骤", "实验步骤": "实验步骤", "step": "实验步骤", "steps": "实验步骤",
    }
    kind_map = {
        "新增": "新增", "添加": "新增", "added": "新增",
        "删除": "删除", "移除": "删除", "removed": "删除",
        "调整": "调整", "修改": "调整", "变更": "调整", "changed": "调整",
    }
    for item in raw_changes[:PLAN_ANALYSIS_MAX_CHANGES]:
        if not isinstance(item, dict):
            continue
        section = section_map.get(clean_plan_analysis_value(item.get("section")).casefold())
        parameter = clean_plan_analysis_value(item.get("parameter"), 180)
        before = clean_plan_analysis_value(item.get("before"), 500)
        after = clean_plan_analysis_value(item.get("after"), 500)
        kind = kind_map.get(clean_plan_analysis_value(item.get("kind")).casefold(), "调整")
        if not section or not parameter or (not before and not after):
            continue
        key = (section, parameter, before, after, kind)
        if key in seen:
            continue
        seen.add(key)
        changes.append({
            "section": section,
            "parameter": parameter,
            "before": before or "—",
            "after": after or "—",
            "kind": kind,
        })
    return {"schema": 1, "changes": changes}


def encode_plan_version_analysis(value: dict) -> str:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_plan_version_analysis(value: Any) -> Optional[dict]:
    if not isinstance(value, str) or not value:
        return None
    try:
        padded = value + "=" * (-len(value) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        return decoded if isinstance(decoded, dict) else None
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return None


def version_comparison_state(project: dict, plan_id: str, subexperiment_id: str = "") -> dict:
    """准备当前方案和上一版本的同一比较范围；子实验按名称对应。"""
    subexperiment_id = one_line(subexperiment_id)
    current, current_content = plan_markdown_content(project, plan_id, subexperiment_id)
    _, current_subexperiment, current_path = plan_content_target(project, plan_id, subexperiment_id)
    current_scope = {"name": current_subexperiment["name"]} if current_subexperiment else None
    previous = previous_plan(project, plan_id)
    state = {
        "current": current, "currentContent": current_content, "currentPath": current_path,
        "currentScope": current_scope, "previous": None, "previousContent": "",
        "previousScope": None, "message": "",
    }
    if not previous:
        state["message"] = "这是当前项目最早创建的方案，暂无上一版本可对比。"
        return state
    previous_subexperiment = None
    if current_subexperiment:
        current_name = current_subexperiment["name"].casefold()
        previous_subexperiment = next(
            (item for item in previous["subexperiments"] if item["name"].casefold() == current_name), None
        )
        if not previous_subexperiment:
            state["message"] = "上一版本中没有同名子实验，暂时无法进行版本对比。"
            return state
    previous_plan_data, previous_content = plan_markdown_content(
        project, previous["id"], previous_subexperiment["id"] if previous_subexperiment else ""
    )
    state.update({
        "previous": previous_plan_data,
        "previousContent": previous_content,
        "previousScope": {"name": previous_subexperiment["name"]} if previous_subexperiment else None,
    })
    return state


def stored_plan_version_analysis(state: dict) -> Optional[dict]:
    stored = decode_plan_version_analysis(read_markdown_document(state["currentPath"])["meta"].get(PLAN_ANALYSIS_META_KEY))
    if not stored or not isinstance(stored.get("basis"), dict):
        return None
    basis = stored["basis"]
    previous = state.get("previous") or {}
    if (
        basis.get("current_plan_id") != state["current"].get("id")
        or basis.get("previous_plan_id") != previous.get("id")
        or basis.get("current_content") != plan_analysis_fingerprint(state["currentContent"])
        or basis.get("previous_content") != plan_analysis_fingerprint(state["previousContent"])
    ):
        return None
    try:
        return normalize_plan_version_analysis(stored)
    except ApiError:
        return None


def plan_comparison(project: dict, plan_id: str, subexperiment_id: str = "") -> dict:
    """返回仅限试剂与操作步骤的 AI 语义参数对比上下文和同步结果。"""
    state = version_comparison_state(project, plan_id, subexperiment_id)
    result = {
        "current": state["current"], "previous": state["previous"],
        "currentScope": state["currentScope"], "previousScope": state["previousScope"],
        "message": state["message"], "analysis": None,
    }
    if not state["previous"]:
        return result
    result["analysis"] = stored_plan_version_analysis(state)
    previous_sections = plan_analysis_sections(state["previousContent"])
    current_sections = plan_analysis_sections(state["currentContent"])
    result["analysisInput"] = {
        "previous": {"version": state["previous"].get("version", ""), **previous_sections},
        "current": {"version": state["current"].get("version", ""), **current_sections},
    }
    return result


def save_plan_version_analysis(project: dict, plan_id: str, payload: dict) -> dict:
    """保存已审核结构的 AI 参数差异，并绑定两版正文指纹以防展示过期结果。"""
    subexperiment_id = one_line(payload.get("subexperimentId"))
    state = version_comparison_state(project, plan_id, subexperiment_id)
    if not state["previous"]:
        raise ApiError(state["message"] or "暂无可分析的上一版本。")
    analysis = normalize_plan_version_analysis(payload.get("analysis"))
    analysis["basis"] = {
        "current_plan_id": state["current"]["id"],
        "previous_plan_id": state["previous"]["id"],
        "current_content": plan_analysis_fingerprint(state["currentContent"]),
        "previous_content": plan_analysis_fingerprint(state["previousContent"]),
        "updated_at": now_iso(),
    }
    doc = read_markdown_document(state["currentPath"])
    meta = dict(doc["meta"])
    meta[PLAN_ANALYSIS_META_KEY] = encode_plan_version_analysis(analysis)
    write_markdown(state["currentPath"], front_matter(meta) + doc["content"].rstrip() + "\n")
    return plan_comparison(project, plan_id, subexperiment_id)


def resolve_plan_association(project: dict, payload: dict) -> dict:
    plan_id = one_line(payload.get("planId"))
    if not plan_id:
        return {"plan_id": "", "plan_name": "", "plan_version": "", "plan_folder": "", "subexperiment_id": "", "subexperiment_name": "", "subexperiment_folder": ""}
    plan = read_plan(project, plan_id)
    subexperiment_id = one_line(payload.get("subexperimentId"))
    subexperiment = next((item for item in plan["subexperiments"] if item["id"] == subexperiment_id), None)
    if subexperiment_id and not subexperiment:
        raise ApiError("未找到所选实验方案中的子实验。")
    return {
        "plan_id": plan["id"],
        "plan_name": plan["name"],
        "plan_version": plan["version"],
        "plan_folder": plan.get("folder", ""),
        "subexperiment_id": subexperiment["id"] if subexperiment else "",
        "subexperiment_name": subexperiment["name"] if subexperiment else "",
        "subexperiment_folder": subexperiment.get("folder", "") if subexperiment else "",
    }


def association_from_meta(meta: dict, fallback: Optional[dict] = None) -> dict:
    """读取日志关联；对于尚未保存的新日志保留前端所选方案。"""
    fallback = fallback or {}
    return {
        "plan_id": meta_value(meta, "plan_id", fallback.get("plan_id", "")),
        "plan_name": meta_value(meta, "plan_name", fallback.get("plan_name", "")),
        "plan_version": meta_value(meta, "plan_version", fallback.get("plan_version", "")),
        "plan_folder": meta_value(meta, "plan_folder", fallback.get("plan_folder", "")),
        "subexperiment_id": meta_value(meta, "subexperiment_id", fallback.get("subexperiment_id", "")),
        "subexperiment_name": meta_value(meta, "subexperiment_name", fallback.get("subexperiment_name", "")),
        "subexperiment_folder": meta_value(meta, "subexperiment_folder", fallback.get("subexperiment_folder", "")),
    }


def association_for_api(association: dict) -> dict:
    return {
        "planId": association.get("plan_id", ""),
        "planName": association.get("plan_name", ""),
        "planVersion": association.get("plan_version", ""),
        "planFolder": association.get("plan_folder", ""),
        "subexperimentId": association.get("subexperiment_id", ""),
        "subexperimentName": association.get("subexperiment_name", ""),
        "subexperimentFolder": association.get("subexperiment_folder", ""),
    }


# --------------------------------------------------------------------------- #
# 实验日志
# --------------------------------------------------------------------------- #
def log_path(project: dict, date: str, association: Optional[dict] = None) -> Path:
    if not DATE_RE.match(date):
        raise ApiError("实验日期无效。")
    association = association or {}
    plan_id = one_line(association.get("plan_id"))
    subexperiment_id = one_line(association.get("subexperiment_id"))
    if not plan_id:
        return project["dir"] / "实验日志" / f"{date}.md"
    if not PLAN_ID_RE.match(plan_id):
        raise ApiError("实验方案标识无效。")
    if subexperiment_id and not PLAN_ID_RE.match(subexperiment_id):
        raise ApiError("子实验标识无效。")
    plan_folder = one_line(association.get("plan_folder"))
    if plan_folder:
        root = project["dir"].resolve()
        directory = (project["dir"] / plan_folder).resolve()
        if root not in directory.parents:
            raise ApiError("实验方案目录无效。")
        subexperiment_folder = one_line(association.get("subexperiment_folder"))
        if subexperiment_id:
            if not subexperiment_folder:
                raise ApiError("子实验目录无效。")
            directory = (directory / subexperiment_folder).resolve()
            if root not in directory.parents:
                raise ApiError("子实验目录无效。")
        return directory / LOGS_FOLDER / f"{date}.md"
    # 兼容此前已经写入项目根目录“实验日志/”的关联日志。
    suffix = f"--{plan_id}" + (f"--{subexperiment_id}" if subexperiment_id else "")
    return project["dir"] / "实验日志" / f"{date}{suffix}.md"


def read_log(project: dict, date: str, association: Optional[dict] = None) -> dict:
    doc = read_markdown_document(log_path(project, date, association))
    image_section = get_section(doc["content"], "导入文档图片信息")
    images = [line[2:].strip() for line in image_section.splitlines() if line.startswith("- ")]
    result = {
        "date": date,
        "source": get_section(doc["content"], "原始输入") or get_section(doc["content"], "原始实验记录"),
        "phenomena": get_section(doc["content"], "实验现象"),
        "record": get_section(doc["content"], "实验记录"),
        "images": images,
        "updatedAt": meta_value(doc["meta"], "updated_at"),
    }
    result.update(association_for_api(association_from_meta(doc["meta"], association)))
    return result


def write_log(project: dict, date: str, payload: dict) -> dict:
    now = now_iso()
    association = resolve_plan_association(project, payload)
    meta = {
        "kind": "experiment_log",
        "date": date,
        "updated_at": now,
        **association,
    }
    source = str(payload.get("source", ""))
    phenomena = str(payload.get("phenomena", ""))
    record = str(payload.get("record", ""))
    raw_images = payload.get("images", [])
    images = [one_line(item) for item in raw_images if one_line(item)][:100] if isinstance(raw_images, list) else []
    # 旧版本的“原始实验记录”仍可读取；新日志统一使用单输入框对应的“原始输入”。
    sections = [f"# {date} 实验日志"]
    if association["plan_id"]:
        association_lines = [
            f"- 实验方案：{association['plan_name']} · {association['plan_version']}"
        ]
        if association["subexperiment_id"]:
            association_lines.append(f"- 子实验：{association['subexperiment_name']}")
        sections.append("## 关联实验方案\n\n" + "\n".join(association_lines))
    if source.strip():
        sections.append(f"## 原始输入\n\n{source}")
    sections.extend([
        f"## 实验现象\n\n{phenomena}",
        f"## 实验记录\n\n{record}",
    ])
    if images:
        sections.append("## 导入文档图片信息\n\n" + "\n".join(f"- {item}" for item in images))
    body = "\n\n".join(sections) + "\n"
    write_markdown(log_path(project, date, association), front_matter(meta) + body)
    update_agents(project)
    return association


def list_log_paths(project: dict) -> list[Path]:
    paths = []
    root_logs = project["dir"] / LOGS_FOLDER
    if root_logs.is_dir():
        paths.extend(root_logs.glob("*.md"))
    for plan in list_plans(project):
        if plan.get("storage") != "folder" or not plan.get("folder"):
            continue
        plan_logs = project["dir"] / plan["folder"] / LOGS_FOLDER
        if plan_logs.is_dir():
            paths.extend(plan_logs.glob("*.md"))
        for subexperiment in plan.get("subexperiments", []):
            folder = subexperiment.get("folder")
            if not folder:
                continue
            sub_logs = project["dir"] / plan["folder"] / folder / LOGS_FOLDER
            if sub_logs.is_dir():
                paths.extend(sub_logs.glob("*.md"))
    return list({path.resolve() for path in paths})


def list_logs(project: dict) -> list:
    items = []
    for p in sorted(list_log_paths(project), key=lambda x: x.stat().st_mtime, reverse=True):
        doc = read_markdown_document(p)
        date = meta_value(doc["meta"], "date", p.stem[:10])
        item = {
            "id": p.stem,
            "date": date,
            "updatedAt": meta_value(doc["meta"], "updated_at"),
        }
        item.update(association_for_api(association_from_meta(doc["meta"])))
        items.append(item)
    return items


def legacy_export_project_markdown(project: dict) -> bytes:
    """把项目内全部 Markdown 合并为一份保留目录层级的 Markdown。"""
    root = project["dir"]
    markdown_paths = sorted(
        (
            path for path in root.rglob("*.md")
            if path.is_file()
            and not ({item.casefold() for item in path.relative_to(root).parts} & {folder.casefold() for folder in LEGACY_MEMORY_FOLDERS})
        ),
        key=lambda item: item.relative_to(root).as_posix().casefold(),
    )

    # 以目录树呈现文件，而非只给出扁平路径列表。导出的内容仍按路径逐文件
    # 汇总，方便人阅读，也方便把整份文件作为后续 AI 对话的项目上下文。
    tree: dict = {}
    for path in markdown_paths:
        cursor = tree
        for part in path.relative_to(root).parts:
            cursor = cursor.setdefault(part, {})

    def render_tree(branch: dict, level: int = 0) -> list[str]:
        result = []
        for item_name, children in sorted(
            branch.items(), key=lambda item: (not bool(item[1]), item[0].casefold())
        ):
            suffix = "/" if children else ""
            result.append(f"{'  ' * level}- `{item_name}{suffix}`")
            if children:
                result.extend(render_tree(children, level + 1))
        return result

    name = meta_value(project["meta"], "name", project["slug"])
    lines = [
        f"# {name} · 项目记忆",
        "",
        f"> 导出时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "> 按项目目录层级汇总全部源 `.md` 文件；导出时由用户选择保存位置。",
        "> 为避免把历史导出再次汇总，汇总时会排除旧版 `sciMemory/` 与 `scihub-memory/` 目录。",
        "",
        "## 文件目录",
        "",
    ]
    if markdown_paths:
        lines.extend(render_tree(tree))
    else:
        lines.append("- 暂无 Markdown 文件。")
    lines.extend(["", "## 文件内容", ""])
    for path in markdown_paths:
        relative_path = path.relative_to(root).as_posix()
        content = path.read_text(encoding="utf-8").strip()
        lines.extend([
            f"### {relative_path}",
            "",
            content or "_（空文件）_",
            "",
            "---",
            "",
        ])
    return "\n".join(lines).encode("utf-8")


def export_project_markdown(project: dict) -> bytes:
    """导出适合直接投喂 AI 的精简项目记忆，而不是合并所有原始 Markdown。"""
    return compact_project_memory_markdown(project).encode("utf-8")


def export_project_to_directory(project: dict, directory_value: Any) -> tuple[Path, bytes]:
    """将项目记忆导出到用户明确选择的目录，始终避免覆盖既有文件。"""
    directory = validate_export_directory(directory_value)
    if directory.exists() and not directory.is_dir():
        raise ApiError("导出路径指向的是文件，请选择文件夹。")
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise ApiError(f"无法创建导出文件夹：{error}") from error
    if directory.is_symlink():
        raise ApiError("导出文件夹不能是链接目录。")
    base = re.sub(r'[\\/:*?"<>|]+', "-", meta_value(project["meta"], "name", project["slug"])).strip(" .-") or project["slug"]
    content = export_project_markdown(project)
    path = directory / f"{base}-项目记忆.md"
    index = 2
    while path.exists():
        path = directory / f"{base}-项目记忆-{index}.md"
        index += 1
    write_markdown(path, content.decode("utf-8"))
    return path, content


def decode_import_payload(payload: dict, allowed_extensions: set[str]) -> tuple[str, bytes, str]:
    filename = one_line(payload.get("filename"))
    suffix = Path(filename).suffix.lower()
    if not filename or suffix not in allowed_extensions:
        supported = "、".join(sorted(allowed_extensions))
        raise ApiError(f"仅支持导入 {supported} 文档。")
    encoded = payload.get("contentBase64")
    if not isinstance(encoded, str) or not encoded:
        raise ApiError("文档内容无效。")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError):
        raise ApiError("文档编码无效。")
    if len(content) > 15 * 1024 * 1024:
        raise ApiError("文档超过 15 MB，暂不能导入。")
    return filename, content, suffix


def decode_text_document(content: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "gb18030"):
        try:
            text = content.decode(encoding)
            if text.strip():
                return text.strip()
        except UnicodeDecodeError:
            continue
    raise ApiError("无法识别文本文件编码；请另存为 UTF-8 后重试。")


def extract_docx_source(content: bytes) -> tuple[str, list[str]]:
    """以标准库读取 DOCX 文本和媒体清单；只提取信息，不保存二进制原件。"""
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            xml = archive.read("word/document.xml")
            root = ElementTree.fromstring(xml)
            text_nodes = root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p")
            paragraphs = []
            for paragraph in text_nodes:
                text = "".join(
                    node.text or ""
                    for node in paragraph.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")
                ).strip()
                if text:
                    paragraphs.append(text)
            images = []
            media_members = sorted(
                name for name in archive.namelist()
                if name.startswith("word/media/") and not name.endswith("/")
            )
            for member in media_members:
                data = archive.read(member)
                media_name = Path(member).name
                mime = mimetypes.guess_type(media_name)[0] or "未知类型"
                images.append(f"{media_name} · {mime} · {len(data):,} 字节")
    except (KeyError, zipfile.BadZipFile, ElementTree.ParseError):
        raise ApiError("无法读取 Word 文档，请确认文件是有效的 .docx。")
    source = "\n\n".join(paragraphs)
    if not source:
        raise ApiError("Word 文档中没有可导入的文本内容。")
    return source, images


def extract_pdf_source(content: bytes) -> tuple[str, list[str]]:
    """从 PDF 提取可选择文本；扫描件没有文字层时会给出明确提示。"""
    try:
        from pypdf import PdfReader
    except ImportError as error:
        raise ApiError("PDF 导入组件未安装，请先执行启动脚本中的依赖安装。") from error
    try:
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted and reader.decrypt("") == 0:
            raise ApiError("PDF 已加密，暂不能导入；请先解除密码保护。")
        pages = []
        image_info = []
        for page_number, page in enumerate(reader.pages, start=1):
            page_text = (page.extract_text() or "").strip()
            if page_text:
                pages.append(f"## 第 {page_number} 页\n\n{page_text}")
            try:
                image_count = len(page.images)
            except (AttributeError, TypeError):
                image_count = 0
            if image_count:
                image_info.append(f"第 {page_number} 页含 {image_count} 个嵌入图像")
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError(f"无法读取 PDF：{error}") from error
    source = "\n\n".join(pages)
    if not source:
        raise ApiError("PDF 未包含可提取文字；若是扫描件，请先 OCR 后再导入。")
    return source, image_info


def extract_imported_document(payload: dict, allowed_extensions: set[str]) -> dict:
    filename, content, suffix = decode_import_payload(payload, allowed_extensions)
    if suffix == ".docx":
        source, images = extract_docx_source(content)
    elif suffix == ".pdf":
        source, images = extract_pdf_source(content)
    else:
        source, images = decode_text_document(content), []
    return {
        "filename": Path(filename).name,
        "extension": suffix.removeprefix("."),
        "source": source,
        "images": images,
    }


def import_log_document(payload: dict) -> dict:
    """读取实验日志来源文件；原文件不落盘，日志仍以 Markdown 保存。"""
    return extract_imported_document(payload, {".docx", ".pdf", ".md", ".markdown", ".txt"})


def source_document_markdown(document: dict) -> str:
    """将外部文件转换为项目内唯一持久化格式：Markdown。"""
    meta = {
        "kind": "imported_plan_source",
        "source_filename": document["filename"],
        "source_format": document["extension"],
        "imported_at": now_iso(),
    }
    title = Path(document["filename"]).stem or "导入资料"
    sections = [
        f"# 导入资料：{title}",
        f"> 原始文件：`{document['filename']}`（{document['extension'].upper()}）",
        "## 转换内容",
        document["source"].strip(),
    ]
    if document["images"]:
        sections.extend([
            "## 文档图片与媒体信息",
            "\n".join(f"- {item}" for item in document["images"]),
        ])
    return front_matter(meta) + "\n\n".join(sections).rstrip() + "\n"


def import_plan_source_document(project: dict, plan_id: str, payload: dict) -> dict:
    subexperiment_id = one_line(payload.get("subexperimentId"))
    plan, subexperiment, _ = plan_content_target(project, plan_id, subexperiment_id)
    if plan["storage"] != "folder" or not plan["folder"]:
        raise ApiError("旧版单文件方案不能导入资料；请新建 V1/V2 文件夹方案。")
    if plan["subexperiments"] and not subexperiment:
        raise ApiError("该方案包含子实验，请在对应子实验中导入方案文件。")
    document = extract_imported_document(payload, {".docx", ".pdf", ".md", ".markdown", ".txt"})
    directory = plan_workspace_dir(project, plan_id, subexperiment_id) / PLAN_IMPORTS_FOLDER
    base = safe_folder_name(Path(document["filename"]).stem or "导入资料", "导入资料文件名")
    path = directory / f"{base}.md"
    index = 2
    while path.exists():
        path = directory / f"{base}-{index}.md"
        index += 1
    markdown = source_document_markdown(document)
    write_markdown(path, markdown)
    return {
        "source": document["source"],
        "markdown": markdown,
        "images": document["images"],
        "storedPath": path.relative_to(project["dir"]).as_posix(),
        "sourceFile": document["filename"],
        "subexperimentId": subexperiment["id"] if subexperiment else "",
    }


def markdown_inline_parts(line: str) -> list[tuple[str, bool]]:
    """拆分 Markdown 粗体片段，供导出时保留关键步骤与注意事项的强调。"""
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", line)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = text.replace("__", "").replace("`", "").strip()
    parts: list[tuple[str, bool]] = []
    for fragment in re.split(r"(\*\*.+?\*\*)", text):
        if not fragment:
            continue
        if fragment.startswith("**") and fragment.endswith("**"):
            parts.append((fragment[2:-2], True))
        else:
            parts.append((fragment, False))
    return parts


def markdown_line_text(line: str) -> str:
    """导出时保留 Markdown 正文语义，去掉不适合 Word/PDF 的轻量标记。"""
    return "".join(fragment for fragment, _ in markdown_inline_parts(line)).strip()


def important_plan_emphasis(title: str) -> str:
    """返回方案板块中粗体文本的语义类型，仅影响已由作者标出的内容。"""
    normalized = re.sub(r"[*_`]", "", title).strip()
    if normalized == "操作步骤":
        return "step"
    if re.search(r"风险|注意", normalized):
        return "caution"
    return ""


def plan_presentation_style(content: str) -> dict:
    """读取方案 Markdown 内的受控版式注释，忽略任何非法值。"""
    match = PLAN_STYLE_RE.search(content)
    style = {"font": "Microsoft YaHei", "fontSize": 11, "layout": "spacious"}
    if not match:
        return style
    try:
        candidate = json.loads(match.group(1))
    except (json.JSONDecodeError, TypeError):
        return style
    font = one_line(candidate.get("font")) if isinstance(candidate, dict) else ""
    font_size = candidate.get("fontSize") if isinstance(candidate, dict) else None
    if font in PLAN_FONT_NAMES:
        style["font"] = font
    if isinstance(font_size, (int, float)) and int(font_size) in PLAN_FONT_SIZES:
        style["fontSize"] = int(font_size)
    if isinstance(candidate, dict) and one_line(candidate.get("layout")) in PLAN_LAYOUT_MODES:
        style["layout"] = one_line(candidate.get("layout"))
    return style


def plan_export_sections(value: str, specified: bool) -> Optional[list[str]]:
    """解析由预览页传来的三级方案标题；未指定时保留全部正文。"""
    if not specified:
        return None
    return [one_line(item) for item in value.split("|") if one_line(item)][:40]


def plan_export_layout(value: str) -> Optional[str]:
    """仅接收预览页允许的排版模式，避免把查询参数直接用于样式。"""
    layout = one_line(value)
    return layout if layout in PLAN_LAYOUT_MODES else None


def is_materials_section(title: str) -> bool:
    """判断三级标题是否为适合紧凑排布的材料/仪器清单。"""
    normalized = re.sub(r"[*_`]", "", title)
    return bool(re.search(r"(?:材料|试剂).*(?:仪器|耗材)|(?:仪器|耗材).*(?:材料|试剂)|^(?:材料|仪器|试剂|耗材)$", normalized))


def filter_plan_content_sections(content: str, selected_sections: Optional[list[str]]) -> str:
    """按三级标题筛选方案正文，四级及更深标题会随所属三级板块保留。"""
    if selected_sections is None:
        return content
    selected = set(selected_sections)
    lines = content.splitlines()
    if not any(re.match(r"^###\s+", line.strip()) for line in lines):
        return content
    visible: list[str] = []
    current_section = ""
    for line in lines:
        heading = re.match(r"^###\s+(.+?)\s*$", line.strip())
        if heading:
            current_section = re.sub(r"[*_`]", "", heading.group(1)).strip()
        if current_section and current_section in selected:
            visible.append(line)
    return "\n".join(visible).strip()


def exportable_plan_content(
    project: dict, plan_id: str, subexperiment_id: str, selected_sections: Optional[list[str]],
    layout_override: Optional[str] = None,
) -> tuple[dict, dict, str]:
    """返回导出所需的方案、版式和经筛选的 Markdown，不改写项目资料。"""
    plan, content = plan_markdown_content(project, plan_id, subexperiment_id)
    style = plan_presentation_style(content)
    if layout_override in PLAN_LAYOUT_MODES:
        style["layout"] = layout_override
    content = PLAN_STYLE_RE.sub("", content)
    content = filter_plan_content_sections(content, selected_sections)
    return plan, style, content.strip()


def experiment_record_sheet_markdown() -> str:
    """导出时可附带的实验记录表；仅生成到下载文件，不写回项目 Markdown。"""
    return (
        "\n\n---\n\n## 实验记录表\n\n"
        "> 用于执行本方案时同步记录关键参数、现象和原始数据。\n\n"
        "| 项目 | 记录 |\n| --- | --- |\n"
        "| 实验日期 |  |\n| 执行人 |  |\n| 样品 / 批次 |  |\n| 仪器 / 设备 |  |\n\n"
        "### 步骤与数据记录\n\n"
        "| 步骤 | 执行时间 | 关键参数、现象与原始数据 | 签名 |\n"
        "| --- | --- | --- | --- |\n"
        + "\n".join("|  |  |  |  |" for _ in range(8))
        + "\n\n### 偏差与处理\n\n| 发现时间 | 偏差或异常 | 处理措施 | 复核人 |\n| --- | --- | --- | --- |\n|  |  |  |  |\n"
    )


def export_plan_markdown(
    project: dict, plan_id: str, subexperiment_id: str = "", include_record_sheet: bool = False,
    selected_sections: Optional[list[str]] = None, layout_override: Optional[str] = None,
) -> bytes:
    """导出供人阅读或复用的原生 Markdown，不修改项目中的源文件。"""
    _, _, content = exportable_plan_content(project, plan_id, subexperiment_id, selected_sections, layout_override)
    if include_record_sheet:
        content = content.rstrip() + experiment_record_sheet_markdown()
    return (content.rstrip() + "\n").encode("utf-8")


def append_docx_record_sheet(document, set_font, pt, cm) -> None:
    """为可打印的实验执行方案附加一页手写记录表。"""
    document.add_page_break()
    heading = document.add_heading("实验记录表", level=1)
    heading.paragraph_format.space_after = pt(5)
    note = document.add_paragraph("用于执行本方案时同步记录关键参数、现象和原始数据。")
    note.paragraph_format.space_after = pt(10)

    metadata = document.add_table(rows=4, cols=2)
    metadata.style = "Table Grid"
    metadata.autofit = False
    for row, (label, value) in zip(metadata.rows, (("实验日期", ""), ("执行人", ""), ("样品 / 批次", ""), ("仪器 / 设备", ""))):
        row.cells[0].width = cm(3.2)
        row.cells[1].width = cm(13.8)
        row.cells[0].text = label
        row.cells[1].text = value
        for cell in row.cells:
            for paragraph in cell.paragraphs:
                paragraph.paragraph_format.space_after = pt(2)
                for run in paragraph.runs:
                    set_font(run, 10.5)
        for run in row.cells[0].paragraphs[0].runs:
            run.bold = True

    document.add_paragraph()
    document.add_heading("步骤与数据记录", level=2)
    table = document.add_table(rows=9, cols=4)
    table.style = "Table Grid"
    table.autofit = False
    headers = ("步骤", "执行时间", "关键参数、现象与原始数据", "签名")
    widths = (cm(1.6), cm(2.8), cm(10.2), cm(2.4))
    for index, cell in enumerate(table.rows[0].cells):
        cell.width = widths[index]
        cell.text = headers[index]
        for paragraph in cell.paragraphs:
            for run in paragraph.runs:
                run.bold = True
                set_font(run, 9.5)
    for row in table.rows[1:]:
        for index, cell in enumerate(row.cells):
            cell.width = widths[index]
            cell.text = "\n"
            for paragraph in cell.paragraphs:
                paragraph.paragraph_format.space_after = pt(2)
                for run in paragraph.runs:
                    set_font(run, 9.5)

    document.add_paragraph()
    document.add_heading("偏差与处理", level=2)
    deviations = document.add_table(rows=3, cols=4)
    deviations.style = "Table Grid"
    deviations.autofit = False
    headers = ("发现时间", "偏差或异常", "处理措施", "复核人")
    widths = (cm(3.0), cm(6.0), cm(6.0), cm(2.0))
    for row_index, row in enumerate(deviations.rows):
        for index, cell in enumerate(row.cells):
            cell.width = widths[index]
            cell.text = headers[index] if row_index == 0 else "\n"
            for paragraph in cell.paragraphs:
                paragraph.paragraph_format.space_after = pt(2)
                for run in paragraph.runs:
                    set_font(run, 9.5)
                    run.bold = row_index == 0


def export_plan_docx(
    project: dict, plan_id: str, subexperiment_id: str = "", include_record_sheet: bool = False,
    selected_sections: Optional[list[str]] = None, layout_override: Optional[str] = None,
) -> bytes:
    """在内存中把 Markdown 方案导出 Word；项目目录仍只保存 Markdown。"""
    try:
        from docx import Document
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.oxml.ns import qn
        from docx.shared import Cm, Inches, Pt, RGBColor
    except ImportError as error:
        raise ApiError("Word 导出组件未安装，请先执行启动脚本中的依赖安装。") from error
    plan, subexperiment, _ = plan_content_target(project, plan_id, subexperiment_id)
    _, presentation, content = exportable_plan_content(project, plan_id, subexperiment_id, selected_sections, layout_override)
    title_text = f"{plan['name']} · {plan['version']}" + (f" · {subexperiment['name']}" if subexperiment else "")
    document = Document()
    section = document.sections[0]
    section.page_width = Cm(21)
    section.page_height = Cm(29.7)
    section.top_margin = section.bottom_margin = Cm(2)
    section.left_margin = section.right_margin = Cm(2)

    font_name = presentation["font"]
    body_size = presentation["fontSize"]
    compact_layout = presentation["layout"] == "compact"

    def set_font(target, size: float, color: Optional[str] = None) -> None:
        target.font.name = font_name
        target._element.rPr.rFonts.set(qn("w:ascii"), font_name)
        target._element.rPr.rFonts.set(qn("w:hAnsi"), font_name)
        target._element.rPr.rFonts.set(qn("w:eastAsia"), font_name)
        target.font.size = Pt(size)
        if color:
            target.font.color.rgb = RGBColor.from_string(color)

    def add_markdown_runs(paragraph, value: str, emphasis: str = "") -> None:
        emphasis_color = {"step": "1F6749", "caution": "994C42"}.get(emphasis)
        for fragment, is_bold in markdown_inline_parts(value):
            run = paragraph.add_run(fragment)
            set_font(run, body_size, emphasis_color if is_bold else None)
            run.bold = is_bold

    normal = document.styles["Normal"]
    set_font(normal, body_size)
    normal.paragraph_format.space_after = Pt(3 if compact_layout else 8)
    normal.paragraph_format.line_spacing = 1.12 if compact_layout else 1.35
    for style_name, size, color in (("Heading 1", 16, "2E74B5"), ("Heading 2", 13, "2E74B5"), ("Heading 3", 12, "1F4D78")):
        style = document.styles[style_name]
        set_font(style, size, color)
        style.paragraph_format.space_before = Pt((10 if style_name == "Heading 1" else 7) if compact_layout else (16 if style_name == "Heading 1" else 11))
        style.paragraph_format.space_after = Pt(4 if compact_layout else 7)

    title = document.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_run = title.add_run(title_text)
    title_run.bold = True
    title_run.font.name = font_name
    title_run._element.rPr.rFonts.set(qn("w:ascii"), font_name)
    title_run._element.rPr.rFonts.set(qn("w:hAnsi"), font_name)
    title_run._element.rPr.rFonts.set(qn("w:eastAsia"), font_name)
    title_run.font.size = Pt(18)
    title.paragraph_format.space_after = Pt(12)
    if plan.get("description"):
        description = document.add_paragraph(plan["description"])
        description.alignment = WD_ALIGN_PARAGRAPH.CENTER
        description.paragraph_format.space_after = Pt(16)

    current_section = ""
    compact_material_items: list[str] = []

    def flush_compact_material_items() -> None:
        if not compact_material_items:
            return
        paragraph = document.add_paragraph(" · " + "； ".join(compact_material_items))
        paragraph.paragraph_format.space_after = Pt(4 if compact_layout else 8)
        compact_material_items.clear()

    for raw_line in content.splitlines():
        line = raw_line.rstrip()
        if not line:
            flush_compact_material_items()
            continue
        if line.startswith("<!--"):
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)$", line)
        if heading:
            flush_compact_material_items()
            level = len(heading.group(1))
            if level == 1:
                continue
            if level == 3:
                current_section = markdown_line_text(heading.group(2))
            style_name = "Heading 1" if level == 2 else "Heading 2" if level == 3 else "Heading 3"
            document.add_paragraph(markdown_line_text(heading.group(2)), style=style_name)
        elif line.startswith("- ") or line.startswith("* "):
            item_source = line[2:]
            item = markdown_line_text(item_source)
            if compact_layout and is_materials_section(current_section):
                compact_material_items.append(item)
            else:
                flush_compact_material_items()
                paragraph = document.add_paragraph(style="List Bullet")
                add_markdown_runs(paragraph, item_source, important_plan_emphasis(current_section))
        elif numbered := re.match(r"^\d+[.)]\s+(.+)$", line):
            item_source = numbered.group(1)
            item = markdown_line_text(item_source)
            if compact_layout and is_materials_section(current_section):
                compact_material_items.append(item)
            else:
                flush_compact_material_items()
                paragraph = document.add_paragraph(style="List Number")
                add_markdown_runs(paragraph, item_source, important_plan_emphasis(current_section))
        elif line.startswith("> "):
            flush_compact_material_items()
            paragraph = document.add_paragraph()
            add_markdown_runs(paragraph, line[2:], important_plan_emphasis(current_section))
            paragraph.paragraph_format.left_indent = Inches(0.25)
            for run in paragraph.runs:
                run.italic = True
        elif not re.fullmatch(r"[-*_]{3,}", line):
            flush_compact_material_items()
            paragraph = document.add_paragraph()
            add_markdown_runs(paragraph, line, important_plan_emphasis(current_section))
    flush_compact_material_items()
    if include_record_sheet:
        append_docx_record_sheet(document, set_font, Pt, Cm)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def append_pdf_record_sheet(story: list, h1, h2, body, font_name, colors, cm, PageBreak, Paragraph, Spacer, Table, TableStyle) -> None:
    """在 PDF 下载文件尾部生成适合打印填写的实验记录页。"""
    story.extend([
        PageBreak(),
        Paragraph("实验记录表", h1),
        Paragraph("用于执行本方案时同步记录关键参数、现象和原始数据。", body),
    ])
    metadata = Table(
        [["实验日期", ""], ["执行人", ""], ["样品 / 批次", ""], ["仪器 / 设备", ""]],
        colWidths=[3.3 * cm, 13.7 * cm],
    )
    metadata.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.45, colors.HexColor("#B9C5BA")),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#F0F5F0")),
        ("FONTNAME", (0, 0), (-1, -1), font_name),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("FONTNAME", (0, 0), (0, -1), font_name),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.extend([metadata, Spacer(1, 14), Paragraph("步骤与数据记录", h2)])
    headers = ["步骤", "执行时间", "关键参数、现象与原始数据", "签名"]
    rows = [headers] + [["", "", "\n", ""] for _ in range(8)]
    records = Table(rows, colWidths=[1.5 * cm, 2.7 * cm, 10.4 * cm, 2.4 * cm], repeatRows=1)
    records.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.45, colors.HexColor("#B9C5BA")),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EEF5")),
        ("FONTNAME", (0, 0), (-1, -1), font_name),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (1, -1), "CENTER"),
        ("ALIGN", (3, 0), (3, -1), "CENTER"),
    ]))
    story.extend([records, Spacer(1, 14), Paragraph("偏差与处理", h2)])
    deviations = Table(
        [["发现时间", "偏差或异常", "处理措施", "复核人"], ["", "\n", "\n", ""], ["", "\n", "\n", ""]],
        colWidths=[3.0 * cm, 6.0 * cm, 6.0 * cm, 2.0 * cm],
    )
    deviations.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.45, colors.HexColor("#B9C5BA")),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EEF5")),
        ("FONTNAME", (0, 0), (-1, -1), font_name),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(deviations)


def export_plan_pdf(
    project: dict, plan_id: str, subexperiment_id: str = "", include_record_sheet: bool = False,
    selected_sections: Optional[list[str]] = None, layout_override: Optional[str] = None,
) -> bytes:
    """在内存中把 Markdown 方案导出 PDF；不在项目中留下 PDF 副本。"""
    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_CENTER
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import cm
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    except ImportError as error:
        raise ApiError("PDF 导出组件未安装，请先执行启动脚本中的依赖安装。") from error
    plan, subexperiment, _ = plan_content_target(project, plan_id, subexperiment_id)
    _, presentation, content = exportable_plan_content(project, plan_id, subexperiment_id, selected_sections, layout_override)
    title_text = f"{plan['name']} · {plan['version']}" + (f" · {subexperiment['name']}" if subexperiment else "")
    font_name = "STSong-Light"
    try:
        pdfmetrics.registerFont(UnicodeCIDFont(font_name))
    except (KeyError, ValueError):
        pass
    styles = getSampleStyleSheet()
    compact_layout = presentation["layout"] == "compact"
    body = ParagraphStyle(
        "SciHubBody", parent=styles["BodyText"], fontName=font_name,
        fontSize=presentation["fontSize"], leading=presentation["fontSize"] * (1.36 if compact_layout else 1.68), spaceAfter=3 if compact_layout else 8,
    )
    title_style = ParagraphStyle(
        "SciHubTitle", parent=body, fontSize=18, leading=26, alignment=TA_CENTER,
        textColor=colors.HexColor("#173E2A"), spaceAfter=8,
    )
    subtitle_style = ParagraphStyle(
        "SciHubSubtitle", parent=body, alignment=TA_CENTER, textColor=colors.HexColor("#607067"), spaceAfter=16,
    )
    h1 = ParagraphStyle(
        "SciHubH1", parent=body, fontSize=15, leading=22, textColor=colors.HexColor("#2E74B5"),
        spaceBefore=10 if compact_layout else 16, spaceAfter=4 if compact_layout else 7,
    )
    h2 = ParagraphStyle(
        "SciHubH2", parent=body, fontSize=12.5, leading=19, textColor=colors.HexColor("#1F4D78"),
        spaceBefore=7 if compact_layout else 11, spaceAfter=3 if compact_layout else 5,
    )
    h3 = ParagraphStyle(
        "SciHubH3", parent=body, fontSize=11.5, leading=17, textColor=colors.HexColor("#466C59"),
        spaceBefore=5 if compact_layout else 8, spaceAfter=2 if compact_layout else 4,
    )
    callout = ParagraphStyle(
        "SciHubCallout", parent=body, leftIndent=18, textColor=colors.HexColor("#526159"),
        backColor=colors.HexColor("#F4F7F2"), borderPadding=7,
    )
    buffer = io.BytesIO()
    document = SimpleDocTemplate(
        buffer, pagesize=A4, leftMargin=2 * cm, rightMargin=2 * cm, topMargin=2 * cm, bottomMargin=2 * cm,
        title=title_text, author="SciHub",
    )
    story = [Paragraph(xml_escape(title_text), title_style)]
    if plan.get("description"):
        story.append(Paragraph(xml_escape(plan["description"]), subtitle_style))
    current_section = ""
    compact_material_items: list[str] = []

    def flush_compact_material_items() -> None:
        if not compact_material_items:
            return
        story.append(Paragraph("• " + xml_escape("； ".join(compact_material_items)), body))
        compact_material_items.clear()

    def pdf_markdown_markup(value: str, emphasis: str = "") -> str:
        emphasis_color = {"step": "#1F6749", "caution": "#994C42"}.get(emphasis)
        rendered = []
        for fragment, is_bold in markdown_inline_parts(value):
            text = xml_escape(fragment)
            if is_bold and emphasis_color:
                rendered.append(f'<b><font color="{emphasis_color}">{text}</font></b>')
            elif is_bold:
                rendered.append(f"<b>{text}</b>")
            else:
                rendered.append(text)
        return "".join(rendered)

    for raw_line in content.splitlines():
        line = raw_line.rstrip()
        if not line:
            flush_compact_material_items()
            continue
        if line.startswith("<!--"):
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)$", line)
        if heading:
            flush_compact_material_items()
            level = len(heading.group(1))
            if level == 1:
                continue
            if level == 3:
                current_section = markdown_line_text(heading.group(2))
            heading_style = h1 if level == 2 else h2 if level == 3 else h3
            story.append(Paragraph(xml_escape(markdown_line_text(heading.group(2))), heading_style))
        elif line.startswith("- ") or line.startswith("* "):
            item_source = line[2:]
            item = markdown_line_text(item_source)
            if compact_layout and is_materials_section(current_section):
                compact_material_items.append(item)
            else:
                flush_compact_material_items()
                story.append(Paragraph("• " + pdf_markdown_markup(item_source, important_plan_emphasis(current_section)), body))
        elif numbered := re.match(r"^(\d+[.)]\s+)(.+)$", line):
            item_source = numbered.group(2)
            item = markdown_line_text(item_source)
            if compact_layout and is_materials_section(current_section):
                compact_material_items.append(item)
            else:
                flush_compact_material_items()
                story.append(Paragraph(xml_escape(numbered.group(1)) + pdf_markdown_markup(item_source, important_plan_emphasis(current_section)), body))
        elif line.startswith("> "):
            flush_compact_material_items()
            story.append(Paragraph(pdf_markdown_markup(line[2:], important_plan_emphasis(current_section)), callout))
        elif re.fullmatch(r"[-*_]{3,}", line):
            flush_compact_material_items()
            story.append(Spacer(1, 6))
        else:
            flush_compact_material_items()
            story.append(Paragraph(pdf_markdown_markup(line, important_plan_emphasis(current_section)), body))
    flush_compact_material_items()
    if include_record_sheet:
        append_pdf_record_sheet(story, h1, h2, body, font_name, colors, cm, PageBreak, Paragraph, Spacer, Table, TableStyle)
    document.build(story)
    return buffer.getvalue()


# --------------------------------------------------------------------------- #
# 对话记录
# --------------------------------------------------------------------------- #
def conversation_path(project: dict, cid: str) -> Path:
    if not CONVERSATION_ID_RE.match(cid):
        raise ApiError("对话标识无效。")
    return project["dir"] / "对话记录" / f"{cid}.md"


def read_conversation(project: dict, cid: str) -> dict:
    doc = read_markdown_document(conversation_path(project, cid))
    if doc["meta"].get("kind") != "conversation":
        raise ApiError("对话文件无效。")
    messages = []
    for match in MESSAGE_RE.finditer(doc["content"]):
        messages.append(
            {
                "role": match.group(1),
                "createdAt": match.group(2).strip(),
                "content": match.group(3).strip(),
            }
        )
    return {
        "id": cid,
        "title": meta_value(doc["meta"], "title", "未命名对话"),
        "model": meta_value(doc["meta"], "model", "手工记录"),
        "createdAt": meta_value(doc["meta"], "created_at"),
        "updatedAt": meta_value(doc["meta"], "updated_at"),
        "messages": messages,
    }


def write_conversation(project: dict, payload: dict) -> str:
    cid = one_line(payload.get("id"))
    if not cid:
        cid = "c-" + datetime.now().strftime("%Y%m%d%H%M%S%f")[:-3]
    if not CONVERSATION_ID_RE.match(cid):
        raise ApiError("对话标识无效。")
    path = conversation_path(project, cid)
    old = read_markdown_document(path)
    now = now_iso()
    title = one_line(payload.get("title"))
    model = one_line(payload.get("model"))
    meta = {
        "kind": "conversation",
        "id": cid,
        "title": title,
        "model": model,
        "created_at": meta_value(old["meta"], "created_at", now),
        "updated_at": now,
    }
    lines = [f"# {title}", "", "## 对话消息", ""]
    for message in payload.get("messages") or []:
        role = "assistant" if message.get("role") == "assistant" else "user"
        created_at = one_line(message.get("createdAt")) or now
        lines.append(f"### {role} | {created_at}")
        lines.append("")
        lines.append(str(message.get("content", "")))
        lines.append("")
    write_markdown(path, front_matter(meta) + "\n".join(lines))
    update_agents(project)
    return cid


def list_conversations(project: dict) -> list:
    directory = project["dir"] / "对话记录"
    if not directory.is_dir():
        return []
    items = []
    for p in sorted(directory.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
        doc = read_markdown_document(p)
        items.append(
            {
                "id": p.stem,
                "title": meta_value(doc["meta"], "title", p.stem),
                "model": meta_value(doc["meta"], "model", "手工记录"),
                "updatedAt": meta_value(doc["meta"], "updated_at"),
                "createdAt": meta_value(doc["meta"], "created_at"),
            }
        )
    return items


# --------------------------------------------------------------------------- #
# HTTP 处理
# --------------------------------------------------------------------------- #
class SciHubHandler(BaseHTTPRequestHandler):
    server_version = "SciHubLocal/1.0"

    def log_message(self, fmt, *args):  # 静默默认日志
        pass

    # --- 底层输出 --- #
    def _send_bytes(
        self,
        status: int,
        data: bytes,
        content_type: str,
        extra_headers: Optional[dict[str, str]] = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _send_json(self, status: int, value: Any) -> None:
        self._send_bytes(
            status,
            json.dumps(value, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def _send_error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": {"message": message}})

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length < 0 or length > MAX_BODY_SIZE:
            raise ApiError("请求内容超过大小限制。")
        if length == 0:
            return {}
        body = self.rfile.read(length).decode("utf-8")
        if not body.strip():
            return {}
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            raise ApiError("请求 JSON 无效。")
        return data if isinstance(data, dict) else {}

    def _segments(self) -> list:
        path = urllib.parse.unquote(self.path.split("?", 1)[0])
        return [s for s in path.strip("/").split("/") if s]

    def _query(self) -> dict[str, str]:
        parsed = urllib.parse.urlparse(self.path)
        values = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        return {key: one_line(items[-1]) for key, items in values.items() if items}

    # --- 路由 --- #
    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            segments = self._segments()
            if segments == ["api", "health"]:
                self._send_json(HTTPStatus.OK, {"service": "SciHub", "version": APP_VERSION})
                return
            if segments[:2] == ["api", "projects"]:
                self._handle_projects(segments)
                return
            self._handle_static()
        except ApiError as error:
            self._send_error(error.status, str(error))
        except Exception as error:  # noqa: BLE001
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))

    def do_POST(self):
        try:
            path = urllib.parse.unquote(self.path.split("?", 1)[0])
            if path == "/api/proxy":
                self._handle_proxy()
                return
            if path == "/api/choose-export-folder":
                self._read_json()
                self._send_json(HTTPStatus.OK, {"path": choose_export_directory()})
                return
            segments = self._segments()
            if segments[:2] == ["api", "projects"]:
                self._handle_projects(segments)
                return
            self._send_error(HTTPStatus.NOT_FOUND, "找不到该接口。")
        except ApiError as error:
            self._send_error(error.status, str(error))
        except Exception as error:  # noqa: BLE001
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))

    def do_PUT(self):
        try:
            segments = self._segments()
            if segments[:2] == ["api", "projects"]:
                self._handle_projects(segments)
                return
            self._send_error(HTTPStatus.NOT_FOUND, "找不到该接口。")
        except ApiError as error:
            self._send_error(error.status, str(error))
        except Exception as error:  # noqa: BLE001
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))

    def do_DELETE(self):
        try:
            segments = self._segments()
            if segments[:2] == ["api", "projects"]:
                self._handle_projects(segments)
                return
            self._send_error(HTTPStatus.NOT_FOUND, "找不到该接口。")
        except ApiError as error:
            self._send_error(error.status, str(error))
        except Exception as error:  # noqa: BLE001
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))

    # --- 静态文件 --- #
    def _handle_static(self):
        segments = self._segments()
        rel = segments[0] if segments else INDEX_FILE
        if not rel or rel.endswith("/"):
            rel = INDEX_FILE
        if re.search(r'[\\/:*?"<>|]', rel):
            self._send_error(HTTPStatus.NOT_FOUND, "找不到文件。")
            return
        path = (ROOT / rel).resolve()
        if ROOT.resolve() not in path.parents and path != (ROOT / INDEX_FILE).resolve():
            # 只允许 SciHub 根目录下的文件
            if ROOT.resolve() not in path.parents:
                self._send_error(HTTPStatus.NOT_FOUND, "找不到文件。")
                return
        if not path.is_file():
            self._send_error(HTTPStatus.NOT_FOUND, "找不到文件。")
            return
        ctype = STATIC_TYPES.get(path.suffix.lower(), "application/octet-stream")
        self._send_bytes(HTTPStatus.OK, path.read_bytes(), ctype)

    # --- 项目 API --- #
    def _handle_projects(self, segments: list):
        method = self.command
        if method == "GET" and len(segments) == 2:
            projects: list[dict] = []
            if PROJECTS_ROOT.is_dir():
                for child in PROJECTS_ROOT.iterdir():
                    if not child.is_dir():
                        continue
                    try:
                        projects.append(project_summary(load_project(child.name)))
                    except ApiError:
                        continue
            projects.sort(key=lambda p: p.get("updatedAt", ""), reverse=True)
            self._send_json(HTTPStatus.OK, {"projects": projects})
            return

        if method == "POST" and len(segments) == 2:
            payload = self._read_json()
            name = one_line(payload.get("name"))
            if not name:
                raise ApiError("请填写项目名称。")
            slug = make_slug(name)
            directory = PROJECTS_ROOT / slug
            try:
                directory.mkdir(parents=True, exist_ok=True)
            except OSError as error:
                raise ApiError(f"无法创建项目文件夹：{error}") from error
            metadata_path = directory / "README.md"
            if metadata_path.exists():
                raise ApiError("新项目目录已包含 README.md，请重试。")
            project = {"slug": slug, "dir": directory, "meta": {}}
            write_project_readme(
                project,
                name,
                str(payload.get("description", "")),
                str(payload.get("importantInfo", "")),
            )
            update_agents(project)
            self._send_json(HTTPStatus.CREATED, {"project": project_summary(project)})
            return

        if len(segments) < 3:
            raise ApiError("找不到该接口。", HTTPStatus.NOT_FOUND)

        project = load_project(segments[2])

        if method == "POST" and len(segments) == 3:
            payload = self._read_json()
            write_project_readme(
                project,
                one_line(payload.get("name")),
                str(payload.get("description", "")),
                str(payload.get("importantInfo", "")),
            )
            update_agents(project)
            self._send_json(HTTPStatus.OK, {"project": project_summary(project)})
            return

        if method == "GET" and len(segments) == 4 and segments[3] == "delete-preview":
            self._send_json(HTTPStatus.OK, project_deletion_preview(project))
            return

        if method == "DELETE" and len(segments) == 3:
            payload = self._read_json()
            delete_project(project, one_line(payload.get("confirmation")))
            self._send_json(HTTPStatus.OK, {"deleted": True})
            return

        if method == "POST" and len(segments) == 4 and segments[3] == "export":
            payload = self._read_json()
            path, _ = export_project_to_directory(project, payload.get("exportPath"))
            self._send_json(HTTPStatus.OK, {"path": str(path), "filename": path.name})
            return

        if method == "GET" and len(segments) == 4 and segments[3] == "agents":
            path = project["dir"] / "AGENTS.md"
            content = path.read_text(encoding="utf-8") if path.is_file() else ""
            self._send_json(HTTPStatus.OK, {"content": content})
            return

        if method == "GET" and len(segments) == 4 and segments[3] == "memory":
            self._send_json(
                HTTPStatus.OK,
                {"content": export_project_markdown(project).decode("utf-8")},
            )
            return

        if len(segments) >= 4 and segments[3] == "plans":
            self._handle_plans(project, segments)
            return

        if len(segments) >= 4 and segments[3] == "logs":
            self._handle_logs(project, segments)
            return

        if len(segments) >= 4 and segments[3] == "conversations":
            self._handle_conversations(project, segments)
            return

        raise ApiError("找不到该接口。", HTTPStatus.NOT_FOUND)

    def _handle_plans(self, project: dict, segments: list):
        method = self.command
        if method == "GET" and len(segments) == 4:
            self._send_json(HTTPStatus.OK, {"plans": list_plans(project)})
            return
        if method == "POST" and len(segments) == 4:
            plan = write_plan(project, self._read_json())
            update_agents(project)
            self._send_json(HTTPStatus.CREATED, {"plan": plan})
            return
        if method == "GET" and len(segments) == 6 and segments[5] == "delete-preview":
            self._send_json(HTTPStatus.OK, plan_deletion_preview(project, segments[4]))
            return
        if method == "GET" and len(segments) == 6 and segments[5] == "content":
            subexperiment_id = one_line(self._query().get("subexperimentId"))
            plan, content = plan_markdown_content(project, segments[4], subexperiment_id)
            self._send_json(HTTPStatus.OK, {"plan": plan, "content": content})
            return
        if method == "PUT" and len(segments) == 6 and segments[5] == "content":
            payload = self._read_json()
            plan = update_plan_content(
                project, segments[4], str(payload.get("planContent", "")), one_line(payload.get("subexperimentId"))
            )
            update_agents(project)
            self._send_json(HTTPStatus.OK, {"plan": plan})
            return
        if method == "POST" and len(segments) == 6 and segments[5] == "import":
            imported = import_plan_source_document(project, segments[4], self._read_json())
            update_agents(project)
            self._send_json(HTTPStatus.CREATED, imported)
            return
        if method == "GET" and len(segments) == 7 and segments[5] == "export":
            export_format = segments[6].lower()
            plan = read_plan(project, segments[4])
            query = self._query()
            subexperiment_id = one_line(query.get("subexperimentId"))
            include_record_sheet = one_line(query.get("includeRecordSheet")).lower() in {"1", "true", "yes", "on"}
            selected_sections = plan_export_sections(query.get("sections", ""), "sections" in query)
            layout_override = plan_export_layout(query.get("layout", ""))
            _, subexperiment, _ = plan_content_target(project, segments[4], subexperiment_id)
            filename_base = f"{plan['name']}-{plan['version']}" + (f"-{subexperiment['name']}" if subexperiment else "")
            if export_format == "docx":
                data = export_plan_docx(project, segments[4], subexperiment_id, include_record_sheet, selected_sections, layout_override)
                self._send_bytes(
                    HTTPStatus.OK,
                    data,
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    {"Content-Disposition": "attachment; filename=\"scihub-plan.docx\"; filename*=UTF-8''" + urllib.parse.quote(filename_base + ".docx")},
                )
                return
            if export_format == "pdf":
                data = export_plan_pdf(project, segments[4], subexperiment_id, include_record_sheet, selected_sections, layout_override)
                self._send_bytes(
                    HTTPStatus.OK,
                    data,
                    "application/pdf",
                    {"Content-Disposition": "attachment; filename=\"scihub-plan.pdf\"; filename*=UTF-8''" + urllib.parse.quote(filename_base + ".pdf")},
                )
                return
            if export_format == "md":
                data = export_plan_markdown(project, segments[4], subexperiment_id, include_record_sheet, selected_sections, layout_override)
                self._send_bytes(
                    HTTPStatus.OK,
                    data,
                    "text/markdown; charset=utf-8",
                    {"Content-Disposition": "attachment; filename=\"scihub-execution-plan.md\"; filename*=UTF-8''" + urllib.parse.quote(filename_base + "-实验执行方案.md")},
                )
                return
            raise ApiError("仅支持导出 Word、PDF 或原生 Markdown。")
        if method == "GET" and len(segments) == 6 and segments[5] == "compare":
            self._send_json(
                HTTPStatus.OK,
                plan_comparison(project, segments[4], one_line(self._query().get("subexperimentId"))),
            )
            return
        if method == "PUT" and len(segments) == 6 and segments[5] == "compare":
            comparison = save_plan_version_analysis(project, segments[4], self._read_json())
            update_agents(project)
            self._send_json(HTTPStatus.OK, {"comparison": comparison})
            return
        if method == "GET" and len(segments) == 5:
            self._send_json(HTTPStatus.OK, {"plan": read_plan(project, segments[4])})
            return
        if method == "PUT" and len(segments) == 5:
            plan = update_plan(project, segments[4], self._read_json())
            update_agents(project)
            self._send_json(HTTPStatus.OK, {"plan": plan})
            return
        if method == "DELETE" and len(segments) == 5:
            payload = self._read_json()
            delete_plan(project, segments[4], one_line(payload.get("confirmation")))
            update_agents(project)
            self._send_json(HTTPStatus.OK, {"deleted": True})
            return
        if method == "POST" and len(segments) == 6 and segments[5] == "entries":
            plan = write_plan_entry(project, segments[4], self._read_json())
            update_agents(project)
            self._send_json(HTTPStatus.CREATED, {"plan": plan})
            return
        if method == "POST" and len(segments) == 6 and segments[5] == "subexperiments":
            plan = add_subexperiment(project, segments[4], self._read_json())
            update_agents(project)
            self._send_json(HTTPStatus.CREATED, {"plan": plan})
            return
        if method == "GET" and len(segments) == 8 and segments[5] == "subexperiments" and segments[7] == "delete-preview":
            self._send_json(HTTPStatus.OK, subexperiment_deletion_preview(project, segments[4], segments[6]))
            return
        if method == "DELETE" and len(segments) == 7 and segments[5] == "subexperiments":
            payload = self._read_json()
            plan = delete_subexperiment(project, segments[4], segments[6], one_line(payload.get("confirmation")))
            update_agents(project)
            self._send_json(HTTPStatus.OK, {"plan": plan})
            return
        raise ApiError("找不到实验方案。", HTTPStatus.NOT_FOUND)

    def _log_association_from_query(self, project: dict) -> dict:
        query = self._query()
        plan_id = one_line(query.get("planId"))
        subexperiment_id = one_line(query.get("subexperimentId"))
        if subexperiment_id and not plan_id:
            raise ApiError("请先选择实验方案，再选择子实验。")
        return resolve_plan_association(
            project,
            {"planId": plan_id, "subexperimentId": subexperiment_id},
        )

    def _handle_logs(self, project: dict, segments: list):
        method = self.command
        if method == "GET" and len(segments) == 4:
            self._send_json(HTTPStatus.OK, {"logs": list_logs(project)})
            return
        if method == "GET" and len(segments) == 6 and segments[5] == "export":
            date = segments[4]
            association = self._log_association_from_query(project)
            path = log_path(project, date, association)
            if not path.is_file():
                raise ApiError("没有可导出的实验日志。", HTTPStatus.NOT_FOUND)
            filename = f"{date}-实验日志.md"
            disposition = (
                f'attachment; filename="experiment-log-{date}.md"; '
                f"filename*=UTF-8''{urllib.parse.quote(filename)}"
            )
            self._send_bytes(
                HTTPStatus.OK,
                path.read_bytes(),
                "text/markdown; charset=utf-8",
                {"Content-Disposition": disposition},
            )
            return
        if method == "POST" and len(segments) == 6 and segments[5] == "import":
            self._send_json(HTTPStatus.OK, import_log_document(self._read_json()))
            return
        if len(segments) != 5:
            raise ApiError("找不到实验日志。", HTTPStatus.NOT_FOUND)
        date = segments[4]
        if method == "GET":
            association = self._log_association_from_query(project)
            self._send_json(HTTPStatus.OK, {"log": read_log(project, date, association)})
            return
        if method == "POST":
            payload = self._read_json()
            association = write_log(project, date, payload)
            self._send_json(HTTPStatus.OK, {"log": read_log(project, date, association)})
            return
        raise ApiError("不支持的请求方式。", HTTPStatus.METHOD_NOT_ALLOWED)

    def _handle_conversations(self, project: dict, segments: list):
        method = self.command
        if method == "GET" and len(segments) == 4:
            self._send_json(HTTPStatus.OK, {"conversations": list_conversations(project)})
            return
        if method == "POST" and len(segments) == 4:
            payload = self._read_json()
            cid = write_conversation(project, payload)
            self._send_json(HTTPStatus.OK, {"conversation": read_conversation(project, cid)})
            return
        if method == "GET" and len(segments) == 5:
            self._send_json(
                HTTPStatus.OK, {"conversation": read_conversation(project, segments[4])}
            )
            return
        raise ApiError("不支持的请求方式。", HTTPStatus.METHOD_NOT_ALLOWED)

    # --- AI 代理 --- #
    def _handle_proxy(self):
        payload = self._read_json()
        url = payload.get("url")
        if not isinstance(url, str) or not url.startswith("https://"):
            raise ApiError("仅允许转发到 HTTPS API。")
        headers = payload.get("headers") or {}
        body = payload.get("body") or {}
        if not isinstance(headers, dict) or not isinstance(body, dict):
            raise ApiError("代理请求格式无效。")
        request = urllib.request.Request(
            url,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={str(k): str(v) for k, v in headers.items() if k.lower() != "content-type"},
            method="POST",
        )
        request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                self._send_bytes(
                    response.status,
                    response.read(),
                    response.headers.get_content_type() or "application/json",
                )
        except urllib.error.HTTPError as error:
            ctype = error.headers.get_content_type() if error.headers else "application/json"
            self._send_bytes(error.code, error.read(), ctype or "application/json")
        except urllib.error.URLError as error:
            self._send_error(HTTPStatus.BAD_GATEWAY, f"无法连接上游 API：{error.reason}")
        except TimeoutError:
            self._send_error(HTTPStatus.GATEWAY_TIMEOUT, "上游 API 响应超时。")


def main() -> None:
    print("正在初始化 SciHub 本地服务…", flush=True)
    PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
    upgraded = synchronise_all_existing_projects()
    if upgraded:
        print(f"已同步升级 {len(upgraded)} 个已有项目的数据结构。", flush=True)
    print("正在监听本地端口…", flush=True)
    server = SciHubServer((HOST, PORT), SciHubHandler)
    url = f"http://{HOST}:{PORT}/{INDEX_FILE}"
    print(f"SciHub 本地服务已启动：{url}")
    print(f"项目文件夹：{PROJECTS_ROOT}")
    print("请保持此窗口开启；按 Ctrl+C 停止服务。")
    # 不在服务进程中唤起浏览器：某些 Windows 默认浏览器配置会阻塞该调用，
    # 进而造成界面已打开但本地 API 尚未可用的假象。
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
