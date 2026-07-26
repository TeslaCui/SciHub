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
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
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

INDEX_FILE = "index.html"
SLUG_RE = re.compile(r"^[\w一-鿿-]+$", re.UNICODE)
CONVERSATION_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FRONT_MATTER_RE = re.compile(r"(?s)^---\r?\n(.*?)\r?\n---\r?\n?")
META_LINE_RE = re.compile(r'^([A-Za-z_]+):\s*"?(.*?)"?$')
MESSAGE_RE = re.compile(
    r"(?ms)^### (user|assistant) \| ([^\r\n]+)\r?\n(.*?)(?=^### (?:user|assistant) \||\Z)"
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
    logs_dir = project["dir"] / "实验日志"
    conversations_dir = project["dir"] / "对话记录"
    logs = list(logs_dir.glob("*.md")) if logs_dir.is_dir() else []
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
    logs_dir = project["dir"] / "实验日志"
    conversations_dir = project["dir"] / "对话记录"

    recent_logs = sorted(
        logs_dir.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True
    )[:6] if logs_dir.is_dir() else []
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
# 实验日志
# --------------------------------------------------------------------------- #
def log_path(project: dict, date: str) -> Path:
    if not DATE_RE.match(date):
        raise ApiError("实验日期无效。")
    return project["dir"] / "实验日志" / f"{date}.md"


def read_log(project: dict, date: str) -> dict:
    doc = read_markdown_document(log_path(project, date))
    image_section = get_section(doc["content"], "导入文档图片信息")
    images = [line[2:].strip() for line in image_section.splitlines() if line.startswith("- ")]
    return {
        "date": date,
        "source": get_section(doc["content"], "原始输入") or get_section(doc["content"], "原始实验记录"),
        "phenomena": get_section(doc["content"], "实验现象"),
        "record": get_section(doc["content"], "实验记录"),
        "images": images,
        "updatedAt": meta_value(doc["meta"], "updated_at"),
    }


def write_log(project: dict, date: str, payload: dict) -> None:
    now = now_iso()
    meta = {"kind": "experiment_log", "date": date, "updated_at": now}
    source = str(payload.get("source", ""))
    phenomena = str(payload.get("phenomena", ""))
    record = str(payload.get("record", ""))
    raw_images = payload.get("images", [])
    images = [one_line(item) for item in raw_images if one_line(item)][:100] if isinstance(raw_images, list) else []
    # 旧版本的“原始实验记录”仍可读取；新日志统一使用单输入框对应的“原始输入”。
    sections = [f"# {date} 实验日志"]
    if source.strip():
        sections.append(f"## 原始输入\n\n{source}")
    sections.extend([
        f"## 实验现象\n\n{phenomena}",
        f"## 实验记录\n\n{record}",
    ])
    if images:
        sections.append("## 导入文档图片信息\n\n" + "\n".join(f"- {item}" for item in images))
    body = "\n\n".join(sections) + "\n"
    write_markdown(log_path(project, date), front_matter(meta) + body)
    update_agents(project)


def list_logs(project: dict) -> list:
    directory = project["dir"] / "实验日志"
    if not directory.is_dir():
        return []
    items = []
    for p in sorted(directory.glob("*.md"), key=lambda x: x.name, reverse=True):
        doc = read_markdown_document(p)
        items.append({"date": p.stem, "updatedAt": meta_value(doc["meta"], "updated_at")})
    return items


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

    # --- 路由 --- #
    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            segments = self._segments()
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

        if method == "GET" and len(segments) == 4 and segments[3] == "agents":
            path = project["dir"] / "AGENTS.md"
            content = path.read_text(encoding="utf-8") if path.is_file() else ""
            self._send_json(HTTPStatus.OK, {"content": content})
            return

        if len(segments) >= 4 and segments[3] == "logs":
            self._handle_logs(project, segments)
            return

        if len(segments) >= 4 and segments[3] == "conversations":
            self._handle_conversations(project, segments)
            return

        raise ApiError("找不到该接口。", HTTPStatus.NOT_FOUND)

    def _handle_logs(self, project: dict, segments: list):
        method = self.command
        if method == "GET" and len(segments) == 4:
            self._send_json(HTTPStatus.OK, {"logs": list_logs(project)})
            return
        if method == "GET" and len(segments) == 6 and segments[5] == "export":
            date = segments[4]
            path = log_path(project, date)
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
            self._send_json(HTTPStatus.OK, {"log": read_log(project, date)})
            return
        if method == "POST":
            payload = self._read_json()
            write_log(project, date, payload)
            self._send_json(HTTPStatus.OK, {"log": read_log(project, date)})
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
    PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), SciHubHandler)
    url = f"http://{HOST}:{PORT}/{INDEX_FILE}"
    print(f"SciHub 本地服务已启动：{url}")
    print(f"项目文件夹：{PROJECTS_ROOT}")
    print("请保持此窗口开启；按 Ctrl+C 停止服务。")
    if not os.environ.get("SCIHUB_NO_BROWSER"):
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
