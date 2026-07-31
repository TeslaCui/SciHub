"""Tests for the MCP-facing memory gateway and safe local mirror sync."""

from __future__ import annotations

import tempfile
import json
import threading
import urllib.request
import unittest
from pathlib import Path

from memory_gateway import ConversationStateStore, LocalMirrorSync, MemoryEventStore, MemoryGatewayError
from memory_index import MemoryIndex
from scihub_mcp_server import Gateway, handle_message


class MemoryGatewayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.projects = self.root / "projects"
        self.project = self.projects / "demo"
        self.project.mkdir(parents=True)
        (self.project / "README.md").write_text(
            "---\nkind: research_project\nslug: demo\nname: Demo\n---\n# Demo\n",
            encoding="utf-8",
        )
        (self.project / "log.md").write_text(
            "---\nkind: log\nverification_status: 原始观察\n---\n# 日志\n## 实验异常与踩坑点\n现象：接触不良。\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_candidate_requires_confirmation_before_markdown(self) -> None:
        store = MemoryEventStore(self.project)
        candidates = store.propose(
            [{
                "type": "fact",
                "title": "接触问题",
                "proposedText": "夹具接触电阻需要复核。",
                "evidenceStatus": "original_observation",
                "sourceRefs": [{"conversationId": "c-1", "messageId": "m-1", "quote": "接触不良"}],
            }],
            conversation_id="c-1",
            project_slug="demo",
        )
        self.assertEqual(len(candidates), 1)
        self.assertFalse((self.project / "memory" / "confirmed").exists())
        saved = store.decide(candidates[0]["id"], "confirm")
        self.assertEqual(saved["status"], "confirmed")
        self.assertTrue((self.project / saved["path"]).is_file())
        self.assertEqual(store.list_pending(), [])

    def test_model_suggestion_pitfall_is_not_auto_indexed(self) -> None:
        store = MemoryEventStore(self.project)
        candidate = store.propose([{
            "type": "pitfall",
            "title": "模型猜测",
            "proposedText": "模型推测可能是气流不稳。",
            "evidenceStatus": "model_suggestion",
        }])[0]
        store.decide(candidate["id"], "confirm")
        with MemoryIndex(self.project) as index:
            index.index()
        summary = (self.project / "PITFALLS_SUMMARY.md").read_text(encoding="utf-8")
        self.assertNotIn("气流不稳", summary)

    def test_traversal_and_rejected_candidate_are_safe(self) -> None:
        with self.assertRaises(MemoryGatewayError):
            from memory_gateway import _safe_project_path
            _safe_project_path(self.project, "../outside.md")
        store = MemoryEventStore(self.project)
        item = store.propose([{"type": "todo", "proposedText": "确认仪器状态"}])[0]
        rejected = store.decide(item["id"], "reject")
        self.assertEqual(rejected["status"], "rejected")
        self.assertFalse((self.project / "memory" / "confirmed").exists())

    def test_conversation_state_keeps_recent_messages(self) -> None:
        state = ConversationStateStore(self.project)
        state.set("c-1", {"summary": "历史摘要", "decisions": ["D1"], "coveredUntil": "m-2"})
        context = state.context("c-1", [{"role": "user", "content": str(i)} for i in range(8)], recent_messages=3)
        self.assertEqual(context["summary"], "历史摘要")
        self.assertEqual(len(context["recentMessages"]), 3)

    def test_sync_is_incremental_and_never_deletes(self) -> None:
        mirror = self.root / "drive"
        mirror.mkdir()
        (self.project / "README.md").write_text("local", encoding="utf-8")
        sync = LocalMirrorSync(self.project, "demo", mirror)
        first = sync.sync()
        self.assertIn("README.md", first["copiedToRemote"])
        (mirror / "demo" / "cloud.md").write_text("cloud", encoding="utf-8")
        second = sync.sync()
        self.assertIn("cloud.md", second["copiedToLocal"])
        self.assertTrue((self.project / "cloud.md").exists())
        (self.project / "README.md").write_text("local-change", encoding="utf-8")
        (mirror / "demo" / "README.md").write_text("remote-change", encoding="utf-8")
        conflict = sync.sync()
        self.assertIn("README.md", conflict["conflicts"])
        self.assertEqual((self.project / "README.md").read_text(encoding="utf-8"), "local-change")
        with self.assertRaises(MemoryGatewayError):
            LocalMirrorSync(self.project, "demo", self.project.parent)

    def test_mcp_initialize_and_context_are_bounded(self) -> None:
        gateway = Gateway(self.projects)
        initialized = handle_message(gateway, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        self.assertEqual(initialized["result"]["serverInfo"]["name"], "scihub-memory")
        tools = handle_message(gateway, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        names = {item["name"] for item in tools["result"]["tools"]}
        self.assertIn("scihub_memory_context", names)
        result = handle_message(gateway, {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "scihub_memory_context", "arguments": {"projectSlug": "demo", "question": "接触"}}})
        self.assertIn("接触不良", result["result"]["structuredContent"]["context"])

    def test_http_memory_and_sync_extensions(self) -> None:
        import scihub_server

        previous_root = scihub_server.PROJECTS_ROOT
        server = scihub_server.SciHubServer(("127.0.0.1", 0), scihub_server.SciHubHandler)
        scihub_server.PROJECTS_ROOT = self.projects
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}/api/projects/demo"
        try:
            with urllib.request.urlopen(f"{base}/memory/status", timeout=5) as response:
                status = json.loads(response.read().decode("utf-8"))
            self.assertTrue(status["available"])
            body = json.dumps({"question": "接触", "agentId": "conversation-agent"}).encode("utf-8")
            request = urllib.request.Request(f"{base}/memory/context", data=body, headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(request, timeout=5) as response:
                context = json.loads(response.read().decode("utf-8"))
            self.assertIn("接触不良", context["context"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            scihub_server.PROJECTS_ROOT = previous_root

    def test_curator_and_compactor_use_strict_json_contracts(self) -> None:
        import scihub_server
        from agent_runtime import AgentResult

        previous = scihub_server.run_agent

        def fake_run_agent(project_slug, payload, **kwargs):
            if payload.get("agentId") == "memory-curator":
                content = json.dumps({"candidates": [{
                    "type": "decision",
                    "title": "采用分段保温",
                    "proposedText": "后续实验采用分段保温。",
                    "evidenceStatus": "model_suggestion",
                    "sourceRefs": [{"conversationId": "c-1", "messageId": "m-1", "quote": "采用分段保温"}],
                    "confidence": 0.8,
                }]}, ensure_ascii=False)
            else:
                content = json.dumps({"summary": "已讨论分段保温", "decisions": ["记录方案"], "facts": [], "openQuestions": [], "sourceMessageIds": ["m-1"], "coveredUntil": "m-1"}, ensure_ascii=False)
            return AgentResult(content, payload["agentId"], [], [], False, [], 1)

        scihub_server.run_agent = fake_run_agent
        try:
            project = {"slug": "demo", "dir": self.project}
            curated = scihub_server.curate_conversation_memory(project, {"conversationId": "c-1", "messages": [{"role": "user", "content": "采用分段保温", "messageId": "m-1"}]})
            self.assertEqual(curated["count"], 1)
            compacted = scihub_server.compact_conversation(project, {"conversationId": "c-1", "messages": [{"role": "user", "content": "采用分段保温"}]})
            self.assertEqual(compacted["state"]["summary"], "已讨论分段保温")
        finally:
            scihub_server.run_agent = previous


if __name__ == "__main__":
    unittest.main()
