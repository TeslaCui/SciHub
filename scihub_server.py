"""SciHub 本地服务：把科研项目、实验日志、对话记录保存为 Markdown 文件。

- 仅监听回环地址 127.0.0.1，不会把项目文件上传到网络。
- 每个项目保存在 `科研项目/项目名-时间戳/` 下，均为可读的 .md 文件。
- 每次保存都会实时更新该项目的 AGENTS.md（自动区块），供 AI 作为项目记忆使用。
- `/api/proxy` 只把用户显式发送的对话转发给你自己配置的 HTTPS 模型接口。

只依赖 Python 3 标准库，无需安装任何第三方包。
"""

from __future__ import annotations

import base64
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

ROOT = Path(__file__).resolve().parent
PROJECTS_ROOT = ROOT / "科研项目"
HOST = "127.0.0.1"
PORT = 8770
MAX_BODY_SIZE = 24 * 1024 * 1024
APP_VERSION = "2026.07.26"

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
    if root not in path.parents and path != root:
        raise ApiError("项目路径无效。")
    if not path.is_dir():
        raise ApiError("未找到该项目。", HTTPStatus.NOT_FOUND)
    return path


def load_project(slug: str) -> dict:
    directory = project_dir(slug)
    doc = read_markdown_document(directory / "README.md")
    if doc["meta"].get("kind") != "research_project":
        raise ApiError("项目元数据无效。")
    return {"slug": slug, "dir": directory, "meta": doc["meta"], "content": doc["content"]}


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


def update_agents(project: dict) -> None:
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


# --------------------------------------------------------------------------- #
# 实验方案
# --------------------------------------------------------------------------- #
LEGACY_PLANS_FOLDER = "实验方案"
PLAN_FILE_NAME = "方案.md"
SUBEXPERIMENT_FILE_NAME = "README.md"
LOGS_FOLDER = "实验日志"
RESERVED_PLAN_FOLDERS = {"实验日志", "对话记录", "实验方案", "__pycache__"}
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
            "entries": list_workspace_entries(child, {SUBEXPERIMENT_FILE_NAME, LOGS_FOLDER}),
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
    for path in project_plan_paths(project):
        try:
            items.append(read_folder_plan(path))
        except ApiError:
            continue
    legacy_dir = legacy_plans_dir(project)
    if legacy_dir.is_dir():
        for path in legacy_dir.glob("*.md"):
            try:
                items.append(read_legacy_plan(path))
            except ApiError:
                continue
    return sorted(items, key=lambda item: item.get("updatedAt", ""), reverse=True)


def normalise_subexperiments(value: Any) -> list[dict]:
    if not isinstance(value, list):
        return []
    result = []
    used_folders: set[str] = set()
    for index, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            continue
        name = one_line(item.get("name"))
        if not name:
            continue
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
    subexperiments = normalise_subexperiments(payload.get("subexperiments"))
    meta = {
        "kind": "experiment_plan",
        "id": plan_id,
        "name": name,
        "version": version,
        "description": description,
        "created_at": now,
        "updated_at": now,
    }
    sections = [f"# {name} · {version}", f"## 方案说明\n\n{description or '尚未填写。'}", "## 子实验"]
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


def export_project_markdown(project: dict) -> bytes:
    """把项目内全部 Markdown 合并为一份保留目录层级的 Markdown。"""
    root = project["dir"]
    markdown_paths = sorted(
        (path for path in root.rglob("*.md") if path.is_file()),
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
        f"# {name} · 项目完整导出",
        "",
        f"> 导出时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "> 此文件按项目目录层级汇总全部 `.md` 文件。",
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


def import_docx_document(payload: dict) -> dict:
    """提取 DOCX 文本和内嵌图片元数据；不把二进制图片写入项目目录。"""
    filename = one_line(payload.get("filename"))
    if Path(filename).suffix.lower() != ".docx":
        raise ApiError("仅支持导入 .docx 文档。")
    encoded = payload.get("contentBase64")
    if not isinstance(encoded, str) or not encoded:
        raise ApiError("文档内容无效。")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError):
        raise ApiError("文档编码无效。")
    if len(content) > 15 * 1024 * 1024:
        raise ApiError("文档超过 15 MB，暂不能导入。")
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
            for member in sorted(name for name in archive.namelist() if name.startswith("word/media/") and not name.endswith("/")):
                data = archive.read(member)
                name = Path(member).name
                mime = mimetypes.guess_type(name)[0] or "未知类型"
                images.append(f"{name} · {mime} · {len(data):,} 字节")
    except (KeyError, zipfile.BadZipFile, ElementTree.ParseError):
        raise ApiError("无法读取 Word 文档，请确认文件是有效的 .docx。")
    source = "\n\n".join(paragraphs)
    if not source:
        raise ApiError("Word 文档中没有可导入的文本内容。")
    return {"source": source, "images": images}


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
            if not PROJECTS_ROOT.is_dir():
                self._send_json(HTTPStatus.OK, {"projects": []})
                return
            projects = []
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
            directory.mkdir(parents=True, exist_ok=True)
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

        if method == "GET" and len(segments) == 4 and segments[3] == "export":
            filename = f"{meta_value(project['meta'], 'name', project['slug'])}-项目完整导出.md"
            disposition = (
                'attachment; filename="scihub-project.md"; '
                f"filename*=UTF-8''{urllib.parse.quote(filename)}"
            )
            self._send_bytes(
                HTTPStatus.OK,
                export_project_markdown(project),
                "text/markdown; charset=utf-8",
                {"Content-Disposition": disposition},
            )
            return

        if method == "GET" and len(segments) == 4 and segments[3] == "agents":
            path = project["dir"] / "AGENTS.md"
            content = path.read_text(encoding="utf-8") if path.is_file() else ""
            self._send_json(HTTPStatus.OK, {"content": content})
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
        if method == "GET" and len(segments) == 5:
            self._send_json(HTTPStatus.OK, {"plan": read_plan(project, segments[4])})
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
            self._send_json(HTTPStatus.OK, import_docx_document(self._read_json()))
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
