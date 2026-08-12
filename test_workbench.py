"""Regression tests for the Markdown-backed SciHub workbench workflows."""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

import scihub_server


class WorkbenchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.project_dir = self.root / "demo"
        self.project_dir.mkdir()
        (self.project_dir / "README.md").write_text(
            "---\nkind: research_project\nslug: demo\nname: Demo\n---\n# Demo\n",
            encoding="utf-8",
        )
        self.project = {"slug": "demo", "dir": self.project_dir, "meta": {}}

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_project_state_and_tasks_are_markdown_and_navigation_is_first(self) -> None:
        state = scihub_server.write_project_state(self.project, {
            "goal": "验证催化剂性能",
            "currentStage": "ORR 测试",
            "nextSteps": "复测样品 A",
            "blockers": "等待电极材料",
        })
        task = scihub_server.write_project_task(self.project, {
            "title": "复测样品 A",
            "notes": "保持相同电解液条件",
            "status": "doing",
            "priority": "high",
        })
        self.assertEqual(state["goal"], "验证催化剂性能")
        self.assertTrue((self.project_dir / "项目管理" / "项目状态.md").is_file())
        self.assertTrue((self.project_dir / task["path"]).is_file())
        hits = scihub_server.project_memory_search(self.project, "ORR 进度", "conversation-agent", 8)
        self.assertEqual(hits[0]["status"], "project_navigation")
        self.assertIn("复测样品 A", hits[0]["excerpt"])

    def test_data_preview_parses_semicolon_quotes_and_does_not_modify_source(self) -> None:
        data_path = self.root / "data.csv"
        original = 'potential;current;note\n0.1;1.2;"a,b"\n0.2;2.4;ok\n'
        data_path.write_text(original, encoding="utf-8")
        asset = scihub_server.write_data_asset(self.project, {"path": str(data_path), "title": "ORR"})
        result = scihub_server.preview_data_asset(self.project, asset["id"])
        preview = result["preview"]
        self.assertEqual(preview["delimiter"], "semicolon")
        self.assertEqual(preview["columns"], ["potential", "current", "note"])
        self.assertEqual(preview["rows"][0]["note"], "a,b")
        self.assertEqual(data_path.read_text(encoding="utf-8"), original)
        stored = json.loads((self.project_dir / "项目管理" / "数据资产.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["assets"][0]["path"], str(data_path.resolve()))

    def test_todo_candidate_can_be_traced_when_reviewed_into_task(self) -> None:
        candidate = scihub_server.memory_event_store(self.project).propose([{
            "type": "todo",
            "title": "复测样品 A",
            "proposedText": "在相同电解液条件下复测样品 A。",
            "evidenceStatus": "model_suggestion",
            "sourceRefs": [{"conversationId": "c-1", "messageId": "c-1-2", "quote": "建议下次复测样品 A"}],
        }], conversation_id="c-1", project_slug="demo")[0]
        notes = "在相同电解液条件下复测样品 A。\n\n证据状态：model_suggestion\n\n来源：c-1：建议下次复测样品 A"
        task = scihub_server.write_project_task(self.project, {
            "title": candidate["title"], "notes": notes, "related": f"记忆候选 {candidate['id']}", "status": "todo", "priority": "medium",
        })
        task_file = (self.project_dir / task["path"]).read_text(encoding="utf-8")
        self.assertIn(candidate["id"], task_file)
        self.assertIn("证据状态：model_suggestion", task_file)
        self.assertIn("建议下次复测样品 A", task_file)

    def test_http_workbench_flow_state_task_data_and_memory_context(self) -> None:
        previous_root = scihub_server.PROJECTS_ROOT
        scihub_server.PROJECTS_ROOT = self.root
        server = scihub_server.SciHubServer(("127.0.0.1", 0), scihub_server.SciHubHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}/api/projects/demo"

        def request(path: str, method: str = "GET", payload: dict | None = None) -> dict:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
            req = urllib.request.Request(path, data=data, method=method)
            if data is not None:
                req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.loads(response.read().decode("utf-8"))

        source = self.root / "http-data.csv"
        source.write_text("x,y\n1,2\n2,4\n", encoding="utf-8")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/index.html", timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertIn(b"records.js", response.read())
            with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/records.js", timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertIn("javascript", response.headers.get_content_type())
            with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/api/health", timeout=5) as response:
                self.assertEqual(json.loads(response.read().decode("utf-8"))["service"], "SciHub")
            state = request(f"{base}/state", "PUT", {"goal": "HTTP smoke", "currentStage": "测试"})["state"]
            self.assertEqual(state["goal"], "HTTP smoke")
            task = request(f"{base}/state/tasks", "POST", {"title": "调用 API", "status": "doing", "priority": "high"})["task"]
            self.assertEqual(task["status"], "doing")
            asset = request(f"{base}/data-assets", "POST", {"title": "data", "path": str(source)})["asset"]
            preview = request(f"{base}/data-assets/{asset['id']}/preview")["preview"]
            self.assertEqual(preview["columns"], ["x", "y"])
            context = request(f"{base}/memory/context", "POST", {"question": "当前项目进度", "agentId": "conversation-agent", "maxChars": 3000})
            self.assertLessEqual(len(context["context"]), 3000)
            self.assertEqual(context["sources"][0]["status"], "project_navigation")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            scihub_server.PROJECTS_ROOT = previous_root


if __name__ == "__main__":
    unittest.main()
