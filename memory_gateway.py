"""Controlled project-memory events, conversation state and local sync.

Markdown remains the authoritative project record.  This module stores only
derived state and explicit user-approved memory entries.  It deliberately
does not expose raw SQL or arbitrary file writes to callers such as the MCP
gateway.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping


EVENTS_FILENAME = "memory-events.jsonl"
AUDIT_FILENAME = "memory-audit.jsonl"
CONVERSATION_STATE_FILENAME = "conversation-state.json"
SYNC_MANIFEST_FILENAME = "sync-manifest.json"
CONFIRMED_MEMORY_DIR = Path("memory") / "confirmed"
MAX_EVENT_BYTES = 256 * 1024
MAX_SOURCE_QUOTE = 3000
MAX_PROPOSAL_TEXT = 12000
ALLOWED_TYPES = {"fact", "decision", "pitfall", "todo", "question"}
ALLOWED_EVIDENCE = {"original_observation", "model_suggestion", "verified_evidence"}
ALLOWED_DECISIONS = {"confirm", "reject", "edit"}


class MemoryGatewayError(RuntimeError):
    """Raised when a memory operation cannot be performed safely."""


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _line(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def _safe_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _safe_project_path(project_root: Path, relative: str) -> Path:
    """Resolve a project-relative source path without escaping the project."""

    raw = str(relative or "").replace("\\", "/").strip()
    if not raw or raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        raise MemoryGatewayError("sourcePath must be a project-relative path")
    candidate = (project_root / raw).resolve()
    root = project_root.resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise MemoryGatewayError("sourcePath escapes the project directory") from exc
    if candidate.is_symlink():
        raise MemoryGatewayError("symlinked project sources are not allowed")
    return candidate


def _project_dir(projects_root: Path, slug: str) -> Path:
    value = _line(slug)
    if not value or value in {".", ".."} or "/" in value or "\\" in value:
        raise MemoryGatewayError("invalid project slug")
    root = projects_root.resolve()
    candidate = (root / value).resolve()
    if candidate.parent != root or not candidate.is_dir():
        raise MemoryGatewayError("project not found")
    if candidate.is_symlink():
        raise MemoryGatewayError("symlinked projects are not allowed")
    return candidate


def _event_path(project_root: Path) -> Path:
    return project_root / ".scihub" / EVENTS_FILENAME


def _audit_path(project_root: Path) -> Path:
    return project_root / ".scihub" / AUDIT_FILENAME


class MemoryAuditStore:
    """Small JSONL audit trail for project-memory reads and writes.

    The audit trail is deliberately separate from the candidate event log: it
    records *that* an operation happened without duplicating complete source
    documents, AI prompts, or credentials.
    """

    def __init__(self, project_root: str | Path):
        self.project_root = Path(project_root).expanduser().resolve()
        if not self.project_root.is_dir() or self.project_root.is_symlink():
            raise MemoryGatewayError("project directory does not exist")
        self.path = _audit_path(self.project_root)

    def record(self, action: str, *, channel: str = "server", details: Mapping[str, Any] | None = None) -> dict[str, Any]:
        entry = {
            "eventId": f"a-{int(time.time() * 1000)}-{secrets.token_hex(4)}",
            "createdAt": _now(),
            "action": _line(action)[:80] or "unknown",
            "channel": _line(channel)[:40] or "server",
            "details": dict(details or {}),
        }
        encoded = (_safe_json(entry) + "\n").encode("utf-8")
        if len(encoded) > MAX_EVENT_BYTES:
            raise MemoryGatewayError("memory audit event is too large")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("ab") as handle:
            handle.write(encoded)
        return entry

    def list(self, limit: int = 120) -> list[dict[str, Any]]:
        if not self.path.is_file():
            return []
        try:
            raw = self.path.read_bytes()
        except OSError as exc:
            raise MemoryGatewayError("unable to read memory audit events") from exc
        if len(raw) > 128 * 1024 * 1024:
            raise MemoryGatewayError("memory audit log is too large")
        entries: list[dict[str, Any]] = []
        for line in raw.decode("utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                entries.append(value)
        return list(reversed(entries[-max(1, min(int(limit or 120), 500)):]))


class MemoryEventStore:
    """Append-only candidate memory store with explicit approval events."""

    def __init__(self, project_root: str | Path):
        self.project_root = Path(project_root).expanduser().resolve()
        if not self.project_root.is_dir() or self.project_root.is_symlink():
            raise MemoryGatewayError("project directory does not exist")
        self.path = _event_path(self.project_root)

    def _append(self, event: Mapping[str, Any]) -> dict[str, Any]:
        payload = dict(event)
        payload.setdefault("eventId", f"e-{int(time.time() * 1000)}-{secrets.token_hex(4)}")
        payload.setdefault("createdAt", _now())
        encoded = (_safe_json(payload) + "\n").encode("utf-8")
        if len(encoded) > MAX_EVENT_BYTES:
            raise MemoryGatewayError("memory event is too large")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("ab") as handle:
            handle.write(encoded)
        return payload

    def _events(self) -> list[dict[str, Any]]:
        if not self.path.is_file():
            return []
        events: list[dict[str, Any]] = []
        try:
            raw = self.path.read_bytes()
        except OSError as exc:
            raise MemoryGatewayError("unable to read memory events") from exc
        if len(raw) > 128 * 1024 * 1024:
            raise MemoryGatewayError("memory event log is too large")
        for line in raw.decode("utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                events.append(item)
        return events

    @staticmethod
    def _normalise_candidate(value: Mapping[str, Any], candidate_id: str = "") -> dict[str, Any]:
        kind = _line(value.get("type")) or "fact"
        if kind not in ALLOWED_TYPES:
            raise MemoryGatewayError(f"unsupported memory candidate type: {kind}")
        evidence = _line(value.get("evidenceStatus")) or "model_suggestion"
        if evidence not in ALLOWED_EVIDENCE:
            evidence = "model_suggestion"
        proposed = str(value.get("proposedText") or "").strip()
        if not proposed:
            raise MemoryGatewayError("memory candidate proposedText is required")
        if len(proposed) > MAX_PROPOSAL_TEXT:
            raise MemoryGatewayError("memory candidate proposedText is too large")
        refs: list[dict[str, str]] = []
        for raw_ref in value.get("sourceRefs") or []:
            if not isinstance(raw_ref, Mapping):
                continue
            ref = {
                "conversationId": _line(raw_ref.get("conversationId")),
                "messageId": _line(raw_ref.get("messageId")),
                "path": _line(raw_ref.get("path")),
                "quote": str(raw_ref.get("quote") or "").strip()[:MAX_SOURCE_QUOTE],
            }
            if any(ref.values()):
                refs.append(ref)
        try:
            confidence = float(value.get("confidence", 0.0) or 0.0)
        except (TypeError, ValueError):
            confidence = 0.0
        confidence = max(0.0, min(1.0, confidence))
        return {
            "id": candidate_id or _line(value.get("id")) or f"m-{int(time.time() * 1000)}-{secrets.token_hex(4)}",
            "type": kind,
            "title": _line(value.get("title"))[:240] or proposed[:80],
            "proposedText": proposed,
            "evidenceStatus": evidence,
            "sourceRefs": refs,
            "confidence": confidence,
            "conversationId": _line(value.get("conversationId")),
            "projectSlug": _line(value.get("projectSlug")),
        }

    def propose(self, candidates: list[Mapping[str, Any]], *, conversation_id: str = "", project_slug: str = "") -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for raw in candidates:
            if not isinstance(raw, Mapping):
                continue
            candidate = self._normalise_candidate(raw)
            candidate["conversationId"] = candidate["conversationId"] or _line(conversation_id)
            candidate["projectSlug"] = candidate["projectSlug"] or _line(project_slug)
            self._append({"type": "propose", "candidate": candidate})
            result.append({**candidate, "status": "pending"})
        return result

    def _materialize(self) -> dict[str, dict[str, Any]]:
        current: dict[str, dict[str, Any]] = {}
        for event in self._events():
            kind = _line(event.get("type"))
            candidate = event.get("candidate")
            if kind == "propose" and isinstance(candidate, Mapping):
                try:
                    normal = self._normalise_candidate(candidate, _line(candidate.get("id")))
                except MemoryGatewayError:
                    continue
                normal["createdAt"] = _line(event.get("createdAt")) or _now()
                current[normal["id"]] = {**normal, "status": "pending"}
            elif kind in ALLOWED_DECISIONS:
                candidate_id = _line(event.get("candidateId"))
                if candidate_id not in current:
                    continue
                if kind == "edit" and isinstance(event.get("patch"), Mapping):
                    patch = dict(current[candidate_id])
                    patch.update(event["patch"])
                    current[candidate_id] = self._normalise_candidate(patch, candidate_id) | {"status": "pending"}
                else:
                    current[candidate_id]["status"] = "confirmed" if kind == "confirm" else "rejected"
                    if kind == "confirm" and _line(event.get("path")):
                        current[candidate_id]["path"] = _line(event.get("path"))
        return current

    def list_pending(self, include_resolved: bool = False) -> list[dict[str, Any]]:
        values = list(self._materialize().values())
        if not include_resolved:
            values = [item for item in values if item.get("status") == "pending"]
        return sorted(values, key=lambda item: (item.get("status") != "pending", item.get("id", "")))

    def decide(self, candidate_id: str, decision: str, patch: Mapping[str, Any] | None = None) -> dict[str, Any]:
        candidate = self._materialize().get(_line(candidate_id))
        if not candidate:
            raise MemoryGatewayError("memory candidate not found")
        if candidate.get("status") != "pending":
            raise MemoryGatewayError("memory candidate has already been resolved")
        decision = _line(decision).lower()
        if decision not in ALLOWED_DECISIONS:
            raise MemoryGatewayError("invalid memory candidate decision")
        if decision == "edit":
            updated = self._normalise_candidate({**candidate, **dict(patch or {})}, candidate["id"])
            self._append({"type": "edit", "candidateId": candidate["id"], "patch": updated})
            return {**updated, "status": "pending"}
        if decision == "confirm":
            confirmed = self._write_confirmed(candidate)
            self._append({"type": "confirm", "candidateId": candidate["id"], "path": confirmed["path"]})
            return confirmed
        self._append({"type": decision, "candidateId": candidate["id"]})
        return {**candidate, "status": "rejected"}

    def _write_confirmed(self, candidate: Mapping[str, Any]) -> dict[str, Any]:
        date = _line(candidate.get("createdAt"))[:10] or datetime.now().strftime("%Y-%m-%d")
        identifier = _line(candidate.get("id")) or f"m-{int(time.time() * 1000)}"
        directory = self.project_root / CONFIRMED_MEMORY_DIR
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{date}-{identifier}.md"
        suffix = 2
        while path.exists():
            path = directory / f"{date}-{identifier}-{suffix}.md"
            suffix += 1
        source_refs = candidate.get("sourceRefs") or []
        metadata = {
            "kind": "confirmed_memory",
            "memory_id": identifier,
            "memory_type": _line(candidate.get("type")),
            "evidence_status": _line(candidate.get("evidenceStatus")) or "model_suggestion",
            "approval_status": "confirmed",
            "conversation_id": _line(candidate.get("conversationId")),
            "confidence": candidate.get("confidence", 0),
            "source_refs": json.dumps(source_refs, ensure_ascii=False),
            "created_at": _now(),
        }
        lines = ["---"]
        for key, value in metadata.items():
            text = str(value).replace('"', "'").replace("\n", " ")
            lines.append(f'{key}: "{text}"')
        lines.extend(["---", "", f"# {candidate.get('title') or identifier}", ""])
        if _line(candidate.get("type")) == "pitfall":
            lines.extend(["## 实验异常与踩坑点", "", str(candidate.get("proposedText") or ""), ""])
        else:
            lines.extend(["## 记忆内容", "", str(candidate.get("proposedText") or ""), ""])
        lines.extend(["## 来源与证据", "", _safe_json(source_refs), ""])
        path.write_text("\n".join(lines), encoding="utf-8")
        return {**dict(candidate), "status": "confirmed", "path": path.relative_to(self.project_root).as_posix()}

    @staticmethod
    def _confirmed_metadata(text: str) -> tuple[dict[str, str], str]:
        if not text.startswith("---"):
            return {}, text
        lines = text.splitlines()
        metadata: dict[str, str] = {}
        end = 0
        for index, line in enumerate(lines[1:], start=1):
            if line.strip() == "---":
                end = index + 1
                break
            key, separator, value = line.partition(":")
            if separator and re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key.strip()):
                metadata[key.strip()] = value.strip().strip('"').strip()
        return metadata, "\n".join(lines[end:]) if end else text

    @staticmethod
    def _confirmed_title_and_content(body: str) -> tuple[str, str]:
        title = ""
        for line in body.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
        content = re.sub(r"(?ms)^## (?:记忆内容|实验异常与踩坑点)\s*\n(.*?)(?=^## |\Z)", r"\1", body).strip()
        if content == body.strip():
            content = body.strip()
        content = re.sub(r"(?ms)^## 来源与证据\s*\n.*\Z", "", content).strip()
        return title, content

    def list_confirmed(self) -> list[dict[str, Any]]:
        directory = self.project_root / CONFIRMED_MEMORY_DIR
        if not directory.is_dir():
            return []
        if directory.is_symlink():
            raise MemoryGatewayError("confirmed memory directory must not be a symlink")
        candidates = self._materialize()
        entries: list[dict[str, Any]] = []
        for path in sorted(directory.glob("*.md"), key=lambda item: item.name, reverse=True):
            if path.is_symlink() or not path.is_file():
                continue
            try:
                metadata, body = self._confirmed_metadata(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError):
                continue
            memory_id = _line(metadata.get("memory_id"))
            if not memory_id:
                continue
            title, content = self._confirmed_title_and_content(body)
            candidate = candidates.get(memory_id, {})
            entries.append({
                "id": memory_id,
                "title": title or _line(candidate.get("title")) or memory_id,
                "type": _line(metadata.get("memory_type")) or _line(candidate.get("type")),
                "proposedText": content or str(candidate.get("proposedText") or "").strip(),
                "evidenceStatus": _line(metadata.get("evidence_status")) or _line(candidate.get("evidenceStatus")),
                "conversationId": _line(metadata.get("conversation_id")) or _line(candidate.get("conversationId")),
                "createdAt": _line(metadata.get("created_at")) or _line(candidate.get("createdAt")),
                "path": path.relative_to(self.project_root).as_posix(),
                "status": "confirmed",
            })
        return entries

    def delete_confirmed(self, memory_id: str, *, reason: str, confirmation: str) -> dict[str, Any]:
        identifier = _line(memory_id)
        entries = self.list_confirmed()
        entry = next((item for item in entries if item["id"] == identifier), None)
        if not entry:
            raise MemoryGatewayError("confirmed memory not found")
        explanation = str(reason or "").strip()
        if len(explanation) < 2:
            raise MemoryGatewayError("a deletion reason is required")
        if _line(confirmation) != f"DELETE {identifier}":
            raise MemoryGatewayError("deletion confirmation does not match the selected memory")
        target = _safe_project_path(self.project_root, entry["path"])
        confirmed_root = (self.project_root / CONFIRMED_MEMORY_DIR).resolve()
        if target.parent != confirmed_root or target.suffix.casefold() != ".md":
            raise MemoryGatewayError("invalid confirmed memory target")
        # This intentionally removes one already-listed, user-confirmed file;
        # it never accepts a glob or an arbitrary path.
        target.unlink()
        self._append({
            "type": "delete_confirmed",
            "candidateId": identifier,
            "path": entry["path"],
            "reason": explanation[:1000],
        })
        return {"id": identifier, "path": entry["path"], "deleted": True, "reason": explanation[:1000]}


class ConversationStateStore:
    """Rebuildable summaries and pointers for long conversations."""

    def __init__(self, project_root: str | Path):
        self.project_root = Path(project_root).expanduser().resolve()
        self.path = self.project_root / ".scihub" / CONVERSATION_STATE_FILENAME

    def _read(self) -> dict[str, Any]:
        if not self.path.is_file():
            return {"version": 1, "conversations": {}}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError):
            return {"version": 1, "conversations": {}}
        return data if isinstance(data, dict) else {"version": 1, "conversations": {}}

    def _write(self, data: Mapping[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(self.path.suffix + ".tmp")
        temp.write_text(json.dumps(dict(data), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp.replace(self.path)

    def get(self, conversation_id: str) -> dict[str, Any]:
        data = self._read()
        values = data.get("conversations") if isinstance(data.get("conversations"), dict) else {}
        item = values.get(_line(conversation_id))
        return dict(item) if isinstance(item, dict) else {}

    def set(self, conversation_id: str, state: Mapping[str, Any]) -> dict[str, Any]:
        data = self._read()
        values = data.setdefault("conversations", {})
        if not isinstance(values, dict):
            values = {}
            data["conversations"] = values
        clean = dict(state)
        clean["updatedAt"] = _now()
        values[_line(conversation_id)] = clean
        self._write(data)
        return clean

    def needs_compaction(self, messages: list[Mapping[str, Any]], *, max_turns: int = 12, max_chars: int = 16000) -> bool:
        return sum(1 for item in messages if _line(item.get("role")) == "user") > max_turns or sum(len(str(item.get("content") or "")) for item in messages) > max_chars

    def context(self, conversation_id: str, messages: list[Mapping[str, Any]], *, recent_messages: int = 6) -> dict[str, Any]:
        state = self.get(conversation_id)
        recent_source = messages[-max(0, recent_messages):] if state else messages
        recent = [dict(item) for item in recent_source]
        try:
            covered_count = int(state.get("coveredCount", 0) or 0)
        except (TypeError, ValueError):
            covered_count = 0
        return {
            "summary": str(state.get("summary") or ""),
            "decisions": list(state.get("decisions") or []),
            "facts": list(state.get("facts") or []),
            "openQuestions": list(state.get("openQuestions") or []),
            "recentMessages": recent,
            "coveredUntil": str(state.get("coveredUntil") or ""),
            "coveredCount": covered_count,
            "compacted": bool(state),
        }


def _sync_relative_files(project_root: Path) -> list[Path]:
    allowed: list[Path] = []
    for path in project_root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        rel = path.relative_to(project_root)
        parts = set(rel.parts)
        if ".scihub" in parts:
            if rel.as_posix() != f".scihub/{EVENTS_FILENAME}":
                continue
        if "__pycache__" in parts or path.suffix.lower() in {".pyc", ".tmp"}:
            continue
        allowed.append(path)
    return sorted(allowed, key=lambda item: item.relative_to(project_root).as_posix().casefold())


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class LocalMirrorSync:
    """Safe two-way sync with a user-selected Google Drive local folder."""

    def __init__(self, project_root: str | Path, project_slug: str, mirror_root: str | Path | None = None):
        self.project_root = Path(project_root).expanduser().resolve()
        self.project_slug = _line(project_slug)
        raw_mirror = Path(mirror_root).expanduser() if mirror_root else None
        if raw_mirror is not None and not raw_mirror.is_absolute():
            raise MemoryGatewayError("sync directory must be an absolute path")
        self.mirror_root = raw_mirror.resolve() if raw_mirror else None
        self.manifest_path = self.project_root / ".scihub" / SYNC_MANIFEST_FILENAME
        if self.mirror_root:
            target = (self.mirror_root / self.project_slug).resolve()
            if self.mirror_root == self.project_root or self.project_root in self.mirror_root.parents or target == self.project_root or self.project_root in target.parents:
                raise MemoryGatewayError("sync directory must not be inside the project")

    @property
    def target(self) -> Path | None:
        return (self.mirror_root / self.project_slug).resolve() if self.mirror_root else None

    def _manifest(self) -> dict[str, Any]:
        if not self.manifest_path.is_file():
            return {"version": 1, "files": {}}
        try:
            data = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError):
            return {"version": 1, "files": {}}
        return data if isinstance(data, dict) else {"version": 1, "files": {}}

    @staticmethod
    def _hashes(root: Path) -> dict[str, str]:
        if not root.is_dir():
            return {}
        values: dict[str, str] = {}
        for path in _sync_relative_files(root):
            values[path.relative_to(root).as_posix()] = _hash_file(path)
        return values

    def status(self) -> dict[str, Any]:
        target = self.target
        if not target:
            return {"configured": False, "enabled": False, "conflicts": [], "localFiles": 0, "remoteFiles": 0}
        local = self._hashes(self.project_root)
        remote = self._hashes(target)
        previous = self._manifest().get("files") if isinstance(self._manifest().get("files"), dict) else {}
        conflicts = []
        for rel in sorted(set(local) & set(remote)):
            if local[rel] != remote[rel] and previous.get(rel) not in {local[rel], remote[rel]}:
                conflicts.append(rel)
        return {
            "configured": True,
            "enabled": True,
            "mirrorRoot": str(self.mirror_root),
            "target": str(target),
            "localFiles": len(local),
            "remoteFiles": len(remote),
            "conflicts": conflicts,
            "lastSyncAt": self._manifest().get("updatedAt", ""),
        }

    def sync(self) -> dict[str, Any]:
        target = self.target
        if not target:
            raise MemoryGatewayError("sync mirror directory is not configured")
        if not self.mirror_root or not self.mirror_root.is_dir():
            raise MemoryGatewayError("sync mirror directory does not exist")
        target.mkdir(parents=True, exist_ok=True)
        local = self._hashes(self.project_root)
        remote = self._hashes(target)
        previous_raw = self._manifest().get("files")
        previous = previous_raw if isinstance(previous_raw, dict) else {}
        copied_to_remote: list[str] = []
        copied_to_local: list[str] = []
        conflicts: list[str] = []
        for rel in sorted(set(local) | set(remote)):
            local_hash, remote_hash = local.get(rel), remote.get(rel)
            source = self.project_root / rel
            remote_destination = target / rel
            local_destination = self.project_root / rel
            if local_hash and not remote_hash:
                remote_destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, remote_destination)
                copied_to_remote.append(rel)
            elif remote_hash and not local_hash:
                source_remote = target / rel
                local_destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_remote, local_destination)
                copied_to_local.append(rel)
            elif local_hash != remote_hash:
                old = previous.get(rel)
                if old == remote_hash:
                    remote_destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, remote_destination)
                    copied_to_remote.append(rel)
                elif old == local_hash:
                    source_remote = target / rel
                    local_destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source_remote, local_destination)
                    copied_to_local.append(rel)
                else:
                    conflicts.append(rel)
        final = self._hashes(self.project_root)
        remote_final = self._hashes(target)
        merged_hashes = {}
        for rel in sorted(set(final) | set(remote_final)):
            if rel in conflicts:
                if rel in previous:
                    merged_hashes[rel] = previous[rel]
                continue
            else:
                merged_hashes[rel] = final.get(rel) or remote_final.get(rel)
        manifest = {
            "version": 1,
            "updatedAt": _now(),
            "mirrorRoot": str(self.mirror_root),
            "files": merged_hashes,
        }
        self.manifest_path.parent.mkdir(parents=True, exist_ok=True)
        self.manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return {
            "configured": True,
            "copiedToRemote": copied_to_remote,
            "copiedToLocal": copied_to_local,
            "conflicts": conflicts,
            "status": self.status(),
        }


def project_for_slug(projects_root: str | Path, slug: str) -> Path:
    return _project_dir(Path(projects_root), slug)


__all__ = [
    "CONFIRMED_MEMORY_DIR",
    "ConversationStateStore",
    "LocalMirrorSync",
    "MemoryAuditStore",
    "MemoryEventStore",
    "MemoryGatewayError",
    "project_for_slug",
]
