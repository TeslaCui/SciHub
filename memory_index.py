"""Local, rebuildable project memory index for SciHub.

The Markdown files in a project remain the source of truth.  This module only
maintains a derived SQLite index under ``<project>/.scihub`` and can recreate
it at any time.  It deliberately has no third-party dependencies so it can be
used by the standard-library-only SciHub server.

The public surface is intentionally small:

``MemoryIndex(project_root)``
    Incrementally index Markdown files, search them and inspect status.
``build_index(project_root)`` / ``search_memory(project_root, query)``
    Convenience wrappers for callers that do not need an object.
``parse_front_matter(text)`` / ``split_markdown(text)``
    Stand-alone parsing helpers useful to skills and tests.

No source files are removed or moved.  The only project Markdown file this
module writes is ``PITFALLS_SUMMARY.md``; its manually-authored content outside
the AUTO-UPDATE markers is preserved byte-for-byte as far as text decoding
allows.
"""

from __future__ import annotations

import ast
import hashlib
import json
import re
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence


SCHEMA_VERSION = 1
INDEX_VERSION = "scihub-memory-v1"
AUTO_START = "<!-- AUTO-UPDATE:START -->"
AUTO_END = "<!-- AUTO-UPDATE:END -->"
SUMMARY_FILENAME = "PITFALLS_SUMMARY.md"

# These folders are old exports.  They are intentionally indexed read-only;
# nothing is migrated, rewritten or deleted there.
LEGACY_MEMORY_FOLDERS = {"scihub-memory", "scimemory"}


class MemoryIndexError(RuntimeError):
    """Raised when a derived index cannot safely be opened or written."""


@dataclass(frozen=True)
class MarkdownChunk:
    """A heading-bounded piece of a Markdown source document."""

    ordinal: int
    title: str
    content: str
    level: int = 0
    metadata: Mapping[str, Any] = field(default_factory=dict)
    source_path: str = ""
    is_pitfall: bool = False


@dataclass(frozen=True)
class SearchResult:
    """A search hit with enough provenance for an Agent to cite its source."""

    chunk_id: int
    source_path: str
    title: str
    content: str
    score: float
    date: str = ""
    plan_version: str = ""
    subexperiment: str = ""
    verification_status: str = ""
    is_pitfall: bool = False
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "source_path": self.source_path,
            # Short aliases are kept for the Agent runtime's source-trace
            # adapter.  The descriptive names above remain the canonical API.
            "path": self.source_path,
            "title": self.title,
            "heading": self.title,
            "content": self.content,
            "excerpt": self.content,
            "score": self.score,
            "date": self.date,
            "plan_version": self.plan_version,
            "subexperiment": self.subexperiment,
            "verification_status": self.verification_status,
            "status": self.verification_status or "reference",
            "is_pitfall": self.is_pitfall,
            "metadata": dict(self.metadata),
        }


@dataclass(frozen=True)
class IndexReport:
    """Result of an incremental or full indexing pass."""

    scanned: int
    added: int
    updated: int
    unchanged: int
    removed: int
    chunks: int
    fts5: bool
    summary_updated: bool
    indexed_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "scanned": self.scanned,
            "added": self.added,
            "updated": self.updated,
            "unchanged": self.unchanged,
            "removed": self.removed,
            "chunks": self.chunks,
            "fts5": self.fts5,
            "summary_updated": self.summary_updated,
            "indexed_at": self.indexed_at,
        }


_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$", re.MULTILINE)
_KEY_VALUE_RE = re.compile(r"^([A-Za-z_][\w.-]*|[\u4e00-\u9fff][^:：]*)[ \t]*[:：][ \t]*(.*)$")
_PITFALL_RE = re.compile(
    r"实验异常|异常与踩坑|踩坑|pitfall|failure|failed|异常现象|避坑", re.IGNORECASE
)
_SENTENCE_RE = re.compile(
    r"(?<=[。！？!?；;])(?:\s+|(?=\S))|(?<=[.!?])\s+|\n{2,}"
)


def _parse_scalar(value: str) -> Any:
    """Parse common YAML scalar forms without pretending to be a YAML parser."""

    text = value.strip()
    if not text:
        return ""
    # YAML comments are comments only when separated from a value.
    text = re.sub(r"\s+#\s.*$", "", text).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        try:
            return ast.literal_eval(text)
        except (ValueError, SyntaxError):
            return text[1:-1]
    lowered = text.lower()
    if lowered in {"null", "~"}:
        return None
    if lowered in {"true", "yes", "on"}:
        return True
    if lowered in {"false", "no", "off"}:
        return False
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        if not inner:
            return []
        values: list[Any] = []
        for item in re.split(r",\s*", inner):
            values.append(_parse_scalar(item))
        return values
    try:
        if re.fullmatch(r"[-+]?\d+", text):
            return int(text)
        if re.fullmatch(r"[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?", text):
            return float(text)
    except ValueError:
        pass
    return text


def parse_front_matter(text: str) -> tuple[dict[str, Any], str]:
    """Return ``(metadata, body)`` for a Markdown YAML-like front matter.

    SciHub's existing files use a deliberately simple YAML subset.  Unknown
    keys are retained in the returned mapping.  If no opening/closing ``---``
    pair exists, the complete input is returned as the body.
    """

    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    if not normalized.startswith("---"):
        return {}, normalized
    lines = normalized.split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, normalized
    end = None
    for index in range(1, len(lines)):
        if lines[index].strip() in {"---", "..."}:
            end = index
            break
    if end is None:
        return {}, normalized
    metadata: dict[str, Any] = {}
    pending_key: str | None = None
    for raw in lines[1:end]:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        match = _KEY_VALUE_RE.match(raw.strip())
        if match:
            key, raw_value = match.groups()
            pending_key = key.strip()
            metadata[pending_key] = _parse_scalar(raw_value)
            continue
        # Basic YAML list continuation (``tags:\n - one``).
        if pending_key and raw.lstrip().startswith("-"):
            current = metadata.get(pending_key)
            if not isinstance(current, list):
                current = []
                metadata[pending_key] = current
            current.append(_parse_scalar(raw.lstrip()[1:].strip()))
    body = "\n".join(lines[end + 1 :])
    return metadata, body


def _split_long_body(title: str, body: str, max_chars: int) -> list[str]:
    body = body.strip()
    if not body:
        return [""]
    if max_chars <= 0 or len(body) <= max_chars:
        return [body]
    pieces: list[str] = []
    current = ""
    # Sentence boundaries are preferred; a hard split is a final safeguard for
    # unpunctuated imported text.
    for sentence in _SENTENCE_RE.split(body):
        sentence = sentence.strip()
        if not sentence:
            continue
        candidate = f"{current} {sentence}".strip()
        if current and len(candidate) > max_chars:
            pieces.append(current)
            current = sentence
        else:
            current = candidate
    if current:
        pieces.append(current)
    hard: list[str] = []
    for piece in pieces:
        if len(piece) <= max_chars:
            hard.append(piece)
        else:
            hard.extend(piece[i : i + max_chars] for i in range(0, len(piece), max_chars))
    return hard


def split_markdown(
    text: str,
    *,
    source_path: str = "",
    max_chars: int = 6000,
) -> list[MarkdownChunk]:
    """Split Markdown into heading-bounded chunks while retaining metadata.

    The front matter is not discarded: it is attached to every chunk as
    metadata, while the body itself remains clean Markdown.  Pitfall headings
    are marked so callers can prioritize them during retrieval.
    """

    metadata, body = parse_front_matter(text)
    lines = body.split("\n")
    sections: list[tuple[int, str, list[str]]] = []
    current_level, current_title, current_lines = 0, "", []
    for line in lines:
        match = re.match(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$", line)
        if match:
            if current_lines or current_title:
                sections.append((current_level, current_title, current_lines))
            current_level = len(match.group(1))
            current_title = match.group(2).strip()
            current_lines = []
        else:
            current_lines.append(line)
    if current_lines or current_title or not sections:
        sections.append((current_level, current_title, current_lines))

    chunks: list[MarkdownChunk] = []
    ordinal = 0
    for level, title, section_lines in sections:
        section_body = "\n".join(section_lines).strip()
        pieces = _split_long_body(title, section_body, max_chars)
        # Empty heading sections are useful context and should still be indexed.
        for part_index, piece in enumerate(pieces):
            effective_title = title or Path(source_path).stem or "文档"
            if len(pieces) > 1:
                effective_title = f"{effective_title} ({part_index + 1}/{len(pieces)})"
            # Only an explicit heading makes a source a pitfall record.  A
            # normal result such as "未发现异常" must not enter the summary.
            pitfall = bool(_PITFALL_RE.search(title))
            chunks.append(
                MarkdownChunk(
                    ordinal=ordinal,
                    title=effective_title,
                    content=piece,
                    level=level,
                    metadata=dict(metadata),
                    source_path=source_path,
                    is_pitfall=pitfall,
                )
            )
            ordinal += 1
    return chunks


def _safe_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _metadata_text(metadata: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        value = metadata.get(key)
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            return ", ".join(str(item) for item in value)
        text = str(value).strip()
        if text:
            return text
    return ""


def _verification_status(metadata: Mapping[str, Any]) -> str:
    explicit = _metadata_text(metadata, "verification_status", "evidence_status")
    if explicit:
        return explicit
    validated = metadata.get("validated")
    if validated is True:
        return "已验证证据"
    if validated is False:
        return "待确认"
    # Some early SciHub notes used ``status`` for this value, but values such as
    # "异常/失败" describe the experiment rather than its evidence quality.
    legacy = _metadata_text(metadata, "status")
    if legacy in {"原始观察", "模型建议", "已验证证据", "待确认"}:
        return legacy
    kind = _metadata_text(metadata, "kind").casefold()
    if "log" in kind or "日志" in kind:
        return "原始观察"
    if "conversation" in kind or "对话" in kind:
        return "模型建议"
    return ""


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MemoryIndex:
    """Incremental SQLite/FTS index scoped to one project directory."""

    def __init__(self, project_root: str | Path, *, max_chunk_chars: int = 6000):
        self.project_root = Path(project_root).expanduser().resolve()
        if not self.project_root.exists() or not self.project_root.is_dir():
            raise MemoryIndexError(f"Project directory does not exist: {self.project_root}")
        self.max_chunk_chars = max_chunk_chars
        self.state_dir = self.project_root / ".scihub"
        self.db_path = self.state_dir / "memory.sqlite3"
        self.state_path = self.state_dir / "memory-state.json"
        self.status_path = self.state_dir / "index-status.json"
        self._conn: sqlite3.Connection | None = None
        self._fts5: bool | None = None

    @property
    def connection(self) -> sqlite3.Connection:
        if self._conn is None:
            if self.state_dir.is_symlink() or self.db_path.is_symlink():
                raise MemoryIndexError("Derived memory paths must remain inside the project directory")
            self.state_dir.mkdir(parents=True, exist_ok=True)
            try:
                self._conn = sqlite3.connect(str(self.db_path))
            except sqlite3.Error as exc:
                raise MemoryIndexError(f"Unable to open derived memory index: {self.db_path}") from exc
            self._conn.row_factory = sqlite3.Row
            try:
                self._configure_schema()
            except sqlite3.Error as exc:
                self._conn.close()
                self._conn = None
                raise MemoryIndexError(f"Invalid or incompatible derived memory index: {self.db_path}") from exc
        return self._conn

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self) -> "MemoryIndex":
        self.connection
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def __del__(self) -> None:  # pragma: no cover - best-effort Windows handle cleanup
        try:
            self.close()
        except Exception:
            pass

    def _configure_schema(self) -> None:
        conn = self._conn
        assert conn is not None
        conn.executescript(
            """
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                file_type TEXT NOT NULL,
                mtime_ns INTEGER NOT NULL,
                size INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                indexed_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY,
                document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                ordinal INTEGER NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                date TEXT NOT NULL DEFAULT '',
                plan_version TEXT NOT NULL DEFAULT '',
                subexperiment TEXT NOT NULL DEFAULT '',
                verification_status TEXT NOT NULL DEFAULT '',
                is_pitfall INTEGER NOT NULL DEFAULT 0,
                source_path TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                UNIQUE(document_id, ordinal)
            );
            CREATE TABLE IF NOT EXISTS index_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        self._fts5 = self._detect_fts5()
        if self._fts5:
            existing_fts = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_fts'"
            ).fetchone()
            if existing_fts and "content=''" in str(existing_fts[0]).replace(" ", "").lower():
                # Older development builds used a contentless table, which
                # cannot be safely updated without deleting a derived table.
                # Preserve it and use the Python fallback for this project.
                self._fts5 = False
            if self._fts5:
                conn.execute(
                    """CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                        title, content, source_path
                    )"""
                )
                existing_rows = int(conn.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0])
                if existing_rows == 0:
                    conn.execute(
                        """INSERT INTO chunks_fts(rowid,title,content,source_path)
                           SELECT id,title,content,source_path FROM chunks"""
                    )
        conn.execute(
            "INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )
        conn.execute(
            "INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)",
            ("index_version", INDEX_VERSION),
        )
        conn.commit()

    def _detect_fts5(self) -> bool:
        conn = self._conn
        assert conn is not None
        try:
            conn.execute("CREATE VIRTUAL TABLE temp.__scihub_fts_probe USING fts5(x)")
            conn.execute("DROP TABLE temp.__scihub_fts_probe")
            return True
        except sqlite3.Error:
            return False

    @property
    def fts5_available(self) -> bool:
        self.connection
        return bool(self._fts5)

    def _markdown_files(self) -> list[Path]:
        files: list[Path] = []
        for path in self.project_root.rglob("*"):
            if path.is_symlink() or not path.is_file() or path.suffix.lower() != ".md":
                continue
            try:
                relative_parts = path.relative_to(self.project_root).parts
                path.resolve(strict=True).relative_to(self.project_root)
            except (OSError, ValueError):
                continue
            # The derived database directory is never itself a source.  Legacy
            # memory folders remain included intentionally for read-only search.
            if ".scihub" in relative_parts:
                continue
            files.append(path)
        return sorted(files, key=lambda item: item.as_posix().casefold())

    def _read_source(self, path: Path) -> tuple[str, bytes]:
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise MemoryIndexError(f"Unable to read Markdown source: {path}") from exc
        # UTF-8 is the project convention; replacement keeps a malformed source
        # searchable without changing the on-disk file.
        return raw.decode("utf-8", errors="replace"), raw

    def _relative_path(self, path: Path) -> str:
        return path.relative_to(self.project_root).as_posix()

    def _write_state_files(self, report: Mapping[str, Any]) -> None:
        """Persist small, key-free diagnostics beside the rebuildable DB."""
        rows = self.connection.execute(
            "SELECT path,sha256,indexed_at FROM documents ORDER BY lower(path)"
        ).fetchall()
        state = {
            "schema": INDEX_VERSION,
            "schema_version": SCHEMA_VERSION,
            "index_version": INDEX_VERSION,
            "documents": [
                {"path": row["path"], "sha256": row["sha256"], "indexed_at": row["indexed_at"]}
                for row in rows
            ],
        }
        status = {
            "schema": INDEX_VERSION,
            "index_version": INDEX_VERSION,
            "available": True,
            "mode": "fts5" if self.fts5_available else "python",
            **dict(report),
        }
        self.state_dir.mkdir(parents=True, exist_ok=True)
        for path, payload in ((self.state_path, state), (self.status_path, status)):
            if path.is_symlink():
                continue
            if path.exists():
                try:
                    current = json.loads(path.read_bytes().decode("utf-8"))
                except (OSError, UnicodeError, ValueError):
                    continue
                if not isinstance(current, dict) or current.get("schema") != INDEX_VERSION:
                    # The purpose/source of this file is uncertain: preserve it.
                    continue
            try:
                path.write_bytes((json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
            except OSError:
                # SQLite remains usable if optional diagnostic files cannot be
                # written (for example, a read-only project backup).
                continue

    def _upsert_document(self, path: Path, content: str, raw: bytes, *, force: bool) -> tuple[str, int, bool]:
        conn = self.connection
        relative = self._relative_path(path)
        digest = hashlib.sha256(raw).hexdigest()
        stat = path.stat()
        old = conn.execute("SELECT id, sha256 FROM documents WHERE path = ?", (relative,)).fetchone()
        if old and old["sha256"] == digest and not force:
            count = conn.execute("SELECT COUNT(*) FROM chunks WHERE document_id = ?", (old["id"],)).fetchone()[0]
            return "unchanged", int(count), False
        metadata, _ = parse_front_matter(content)
        file_type = str(metadata.get("kind") or path.name).strip() or path.name
        now = _iso_now()
        if old:
            document_id = int(old["id"])
            conn.execute(
                """UPDATE documents SET file_type=?, mtime_ns=?, size=?, sha256=?,
                   metadata_json=?, indexed_at=? WHERE id=?""",
                (file_type, stat.st_mtime_ns, stat.st_size, digest, _safe_json(metadata), now, document_id),
            )
            if self.fts5_available:
                old_chunk_ids = conn.execute(
                    "SELECT id FROM chunks WHERE document_id = ?", (document_id,)
                ).fetchall()
                for chunk_id in old_chunk_ids:
                    conn.execute("DELETE FROM chunks_fts WHERE rowid = ?", (chunk_id[0],))
            conn.execute("DELETE FROM chunks WHERE document_id = ?", (document_id,))
            action = "updated"
        else:
            cursor = conn.execute(
                """INSERT INTO documents(path,file_type,mtime_ns,size,sha256,metadata_json,indexed_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (relative, file_type, stat.st_mtime_ns, stat.st_size, digest, _safe_json(metadata), now),
            )
            document_id = int(cursor.lastrowid)
            action = "added"
        chunks = split_markdown(content, source_path=relative, max_chars=self.max_chunk_chars)
        for chunk in chunks:
            date = _metadata_text(metadata, "date", "experiment_date", "performed_at", "created_at", "updated_at", "imported_at")
            plan_version = _metadata_text(metadata, "version", "plan_version")
            subexperiment = _metadata_text(metadata, "subexperiment", "subexperiment_id", "name")
            verification = _verification_status(metadata)
            cur = conn.execute(
                """INSERT INTO chunks(document_id,ordinal,title,content,date,plan_version,
                   subexperiment,verification_status,is_pitfall,source_path,metadata_json)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    document_id,
                    chunk.ordinal,
                    chunk.title,
                    chunk.content,
                    date,
                    plan_version,
                    subexperiment,
                    verification,
                    int(chunk.is_pitfall or path.name.casefold() == SUMMARY_FILENAME.casefold()),
                    relative,
                    _safe_json(metadata),
                ),
            )
            if self.fts5_available:
                conn.execute(
                    "INSERT INTO chunks_fts(rowid,title,content,source_path) VALUES (?,?,?,?)",
                    (int(cur.lastrowid), chunk.title, chunk.content, relative),
                )
        return action, len(chunks), True

    def index(self, *, force: bool = False, update_summary: bool = True) -> IndexReport:
        """Incrementally index all Markdown files below the project root."""

        conn = self.connection
        files = self._markdown_files()
        current_paths = {self._relative_path(path) for path in files}
        scanned = added = updated = unchanged = chunks = 0
        for path in files:
            scanned += 1
            content, raw = self._read_source(path)
            action, count, changed = self._upsert_document(path, content, raw, force=force)
            chunks += count
            if action == "added":
                added += 1
            elif action == "updated":
                updated += 1
            else:
                unchanged += 1
            # FTS rows are maintained as a standalone table.  On updates remove
            # the old rows before insertion; document chunks are cascaded below.
            if changed and self.fts5_available:
                conn.execute("DELETE FROM chunks_fts WHERE rowid NOT IN (SELECT id FROM chunks)")
        removed_rows = conn.execute("SELECT id,path FROM documents").fetchall()
        removed = 0
        for row in removed_rows:
            if row["path"] not in current_paths:
                if self.fts5_available:
                    ids = conn.execute("SELECT id FROM chunks WHERE document_id = ?", (row["id"],)).fetchall()
                    for chunk_id in ids:
                        conn.execute("DELETE FROM chunks_fts WHERE rowid = ?", (chunk_id[0],))
                conn.execute("DELETE FROM documents WHERE id = ?", (row["id"],))
                removed += 1
        indexed_at = _iso_now()
        conn.execute("INSERT OR REPLACE INTO index_meta(key,value) VALUES (?,?)", ("last_indexed_at", indexed_at))
        conn.commit()
        summary_updated = self.update_pitfalls_summary() if update_summary else False
        report = IndexReport(scanned, added, updated, unchanged, removed, chunks, self.fts5_available, summary_updated, indexed_at)
        self._write_state_files(report.to_dict())
        return report

    def rebuild(self, *, update_summary: bool = True) -> IndexReport:
        """Rebuild only the derived database, leaving every source file intact."""

        conn = self.connection
        conn.execute("DELETE FROM chunks")
        conn.execute("DELETE FROM documents")
        if self.fts5_available:
            conn.execute("DELETE FROM chunks_fts")
        conn.commit()
        return self.index(force=True, update_summary=update_summary)

    def _row_to_result(self, row: sqlite3.Row, score: float) -> SearchResult:
        metadata: dict[str, Any]
        try:
            parsed = json.loads(row["metadata_json"] or "{}")
            metadata = parsed if isinstance(parsed, dict) else {}
        except (TypeError, ValueError):
            metadata = {}
        return SearchResult(
            chunk_id=int(row["id"]),
            source_path=str(row["source_path"]),
            title=str(row["title"]),
            content=str(row["content"]),
            score=float(score),
            date=str(row["date"] or ""),
            plan_version=str(row["plan_version"] or ""),
            subexperiment=str(row["subexperiment"] or ""),
            verification_status=str(row["verification_status"] or ""),
            is_pitfall=bool(row["is_pitfall"]),
            metadata=metadata,
        )

    def _search_fts(self, query: str, limit: int) -> list[SearchResult]:
        if not self.fts5_available or not query.strip():
            return []
        conn = self.connection
        # Keep punctuation from becoming FTS operators.  A quoted phrase is
        # useful for natural-language queries; a token OR query covers shorter
        # lookups and is retried only when the phrase has no hits.
        cleaned = query.replace('"', ' ')
        expressions = [f'"{cleaned}"']
        tokens = re.findall(r"[\w\u4e00-\u9fff]+", query, re.UNICODE)
        if len(tokens) > 1:
            expressions.append(" OR ".join(f'"{token}"' for token in tokens[:16]))
        rows: list[sqlite3.Row] = []
        for expression in expressions:
            try:
                rows = conn.execute(
                    """SELECT c.*, bm25(chunks_fts) AS rank FROM chunks_fts
                       JOIN chunks c ON c.id = chunks_fts.rowid
                       WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?""",
                    (expression, max(limit * 4, limit)),
                ).fetchall()
            except sqlite3.Error:
                rows = []
            if rows:
                break
        return [self._row_to_result(row, -float(row["rank"])) for row in rows]

    def _search_python(self, query: str, limit: int) -> list[SearchResult]:
        terms = [term.casefold() for term in re.findall(r"[\w\u4e00-\u9fff]+", query, re.UNICODE) if term.strip()]
        if not terms:
            return []
        rows = self.connection.execute("SELECT * FROM chunks").fetchall()
        ranked: list[tuple[float, sqlite3.Row]] = []
        for row in rows:
            haystack = f"{row['title']}\n{row['content']}\n{row['source_path']}".casefold()
            matched = sum(haystack.count(term) for term in terms)
            if not matched:
                continue
            score = float(matched)
            if row["title"].casefold().find(terms[0]) >= 0:
                score += 2
            if row["is_pitfall"]:
                score += 1000
            ranked.append((score, row))
        ranked.sort(key=lambda item: (-item[0], item[1]["source_path"], item[1]["ordinal"]))
        return [self._row_to_result(row, score) for score, row in ranked[:limit]]

    def search(
        self,
        query: str,
        *,
        limit: int = 10,
        pitfall_first: bool = True,
        auto_index: bool = True,
    ) -> list[SearchResult]:
        """Search indexed content, returning provenance-rich results.

        ``pitfall_first`` boosts explicit anomaly/avoidance sections before
        ordinary chunks.  Search never sends content outside this project root.
        """

        if auto_index:
            self.index(update_summary=False)
        limit = max(1, int(limit))
        fts_hits = self._search_fts(query, limit * 2)
        py_hits = self._search_python(query, limit * 2)
        merged: dict[int, SearchResult] = {hit.chunk_id: hit for hit in fts_hits}
        for hit in py_hits:
            old = merged.get(hit.chunk_id)
            if old is None or hit.score > old.score:
                merged[hit.chunk_id] = hit
        results = list(merged.values())
        for hit in results:
            if pitfall_first and hit.is_pitfall:
                # Dataclasses are frozen; recreate with a deterministic boost.
                merged[hit.chunk_id] = SearchResult(
                    chunk_id=hit.chunk_id,
                    source_path=hit.source_path,
                    title=hit.title,
                    content=hit.content,
                    score=hit.score + 1000,
                    date=hit.date,
                    plan_version=hit.plan_version,
                    subexperiment=hit.subexperiment,
                    verification_status=hit.verification_status,
                    is_pitfall=True,
                    metadata=hit.metadata,
                )
        results = list(merged.values())
        results.sort(key=lambda hit: (-hit.score, hit.source_path, hit.chunk_id))
        return results[:limit]

    def status(self) -> dict[str, Any]:
        conn = self.connection
        documents = int(conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0])
        chunks = int(conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])
        last = conn.execute("SELECT value FROM index_meta WHERE key='last_indexed_at'").fetchone()
        return {
            "available": True,
            "mode": "fts5" if self.fts5_available else "python",
            "project_root": str(self.project_root),
            "database_path": str(self.db_path),
            "index_version": INDEX_VERSION,
            "fts5": self.fts5_available,
            "index_mode": "fts5" if self.fts5_available else "python",
            "documents": documents,
            "chunks": chunks,
            "last_indexed_at": str(last[0]) if last else "",
        }

    def _pitfall_entries(self) -> list[str]:
        rows = self.connection.execute(
            "SELECT * FROM chunks WHERE is_pitfall=1 AND lower(source_path) <> lower(?) ORDER BY date DESC, source_path, ordinal",
            (SUMMARY_FILENAME,),
        ).fetchall()
        entries: list[str] = []
        for row in rows:
            metadata = json.loads(row["metadata_json"] or "{}")
            if not isinstance(metadata, dict):
                metadata = {}
            date = _metadata_text(metadata, "date", "experiment_date", "performed_at", "created_at", "updated_at", "imported_at") or "未注明日期"
            sample = _metadata_text(metadata, "sample_id", "id", "name", "experiment_id") or row["title"] or "未注明实验"
            tags = _metadata_text(metadata, "tags", "tag") or "未注明"
            status = _verification_status(metadata) or "待确认"
            body = row["content"].strip().replace("\r", "").replace("\n", " ")
            body = re.sub(r"\s+", " ", body)
            def labelled(pattern: str) -> str:
                match = re.search(pattern + r"\s*[:：]\s*([^。；;\n]+)", row["content"], re.IGNORECASE)
                return match.group(1).strip() if match else "未明确"
            phenomenon = labelled(r"(?:现象|实验现象)")
            cause = labelled(r"(?:原因分析|原因)")
            improvement = labelled(r"(?:改进方案|改进|避坑指南)")
            if phenomenon == cause == improvement == "未明确":
                phenomenon = body[:300] or "未明确"
            source = row["source_path"]
            entries.append(
                f"- [{date}][{tags}] {sample}：现象={phenomenon}；原因={cause}；改进={improvement}；证据状态={status}；来源=`{source}`"
            )
        # Avoid duplicate bullets when the same source has nested split chunks.
        return list(dict.fromkeys(entries))

    def update_pitfalls_summary(self) -> bool:
        """Update only the generated area of ``PITFALLS_SUMMARY.md``.

        A malformed file containing only one marker is left untouched to avoid
        overwriting unknown/manual content.  The return value reports whether
        an update was written.
        """

        summary_path = self.project_root / SUMMARY_FILENAME
        if summary_path.is_symlink():
            return False
        entries = self._pitfall_entries()
        generated = (
            "# 科研项目总踩坑与异常索引表\n\n"
            f"{AUTO_START}\n"
            + ("\n".join(entries) if entries else "暂无已明确记录的实验异常或踩坑点。")
            + f"\n{AUTO_END}\n"
        )
        if not summary_path.exists():
            summary_path.write_bytes(generated.encode("utf-8"))
            return True
        try:
            original = summary_path.read_bytes().decode("utf-8")
        except (OSError, UnicodeError):
            return False
        start = original.find(AUTO_START)
        end = original.find(AUTO_END, start + len(AUTO_START)) if start >= 0 else -1
        if start >= 0 and end >= 0:
            replacement = AUTO_START + "\n" + ("\n".join(entries) if entries else "暂无已明确记录的实验异常或踩坑点。") + "\n" + AUTO_END
            updated = original[:start] + replacement + original[end + len(AUTO_END) :]
        elif start < 0 and end < 0:
            separator = "\n" if original.endswith("\n") else "\n\n"
            updated = original + separator + generated
        else:
            return False
        if updated == original:
            return False
        summary_path.write_bytes(updated.encode("utf-8"))
        return True


def build_index(project_root: str | Path, *, force: bool = False, update_summary: bool = True) -> dict[str, Any]:
    """Build/update a project memory index and return a JSON-friendly report."""

    with MemoryIndex(project_root) as index:
        return index.index(force=force, update_summary=update_summary).to_dict()


def rebuild_index(project_root: str | Path, *, update_summary: bool = True) -> dict[str, Any]:
    with MemoryIndex(project_root) as index:
        return index.rebuild(update_summary=update_summary).to_dict()


def search_memory(
    project_root: str | Path,
    query: str,
    *,
    limit: int = 10,
    pitfall_first: bool = True,
    agent_id: str = "",
) -> list[dict[str, Any]]:
    """Search a project; ``agent_id`` is accepted for router compatibility.

    The index is project-scoped, so an Agent identifier does not broaden the
    search.  It is intentionally ignored here and retained only to make this
    helper directly usable as an Agent runtime callback.
    """
    with MemoryIndex(project_root) as index:
        return [item.to_dict() for item in index.search(query, limit=limit, pitfall_first=pitfall_first)]


def memory_status(project_root: str | Path) -> dict[str, Any]:
    with MemoryIndex(project_root) as index:
        return index.status()


__all__ = [
    "AUTO_END",
    "AUTO_START",
    "INDEX_VERSION",
    "IndexReport",
    "MarkdownChunk",
    "MemoryIndex",
    "MemoryIndexError",
    "SearchResult",
    "build_index",
    "memory_status",
    "parse_front_matter",
    "rebuild_index",
    "search_memory",
    "split_markdown",
]
