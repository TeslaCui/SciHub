"""Basic regression tests for the standalone SciHub memory index.

Run with the same Python executable used by ``启动 SciHub.cmd``::

    python -m unittest -v test_memory_index
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from memory_index import (
    AUTO_END,
    AUTO_START,
    MemoryIndex,
    parse_front_matter,
    split_markdown,
)


class FrontMatterAndChunkTests(unittest.TestCase):
    def test_front_matter_retains_unknown_keys_and_lists(self) -> None:
        metadata, body = parse_front_matter(
            "---\n"
            "sample_id: 'S-01'\n"
            "tags: [烧结, ICP]\n"
            "custom_field: yes\n"
            "---\n"
            "# 标题\n正文"
        )
        self.assertEqual(metadata["sample_id"], "S-01")
        self.assertEqual(metadata["tags"], ["烧结", "ICP"])
        self.assertIs(metadata["custom_field"], True)
        self.assertIn("# 标题", body)

    def test_heading_split_marks_pitfall_and_splits_long_text(self) -> None:
        chunks = split_markdown(
            "# 实验\n\n## 实验异常与踩坑点\n"
            "现象：黑色附着物。原因分析：升温过快。改进方案：分段保温。\n"
            "## 结果\n正常。",
            source_path="logs/2026-05-10.md",
            max_chars=24,
        )
        self.assertGreaterEqual(len(chunks), 3)
        pitfall = next(chunk for chunk in chunks if "踩坑" in chunk.title)
        self.assertTrue(pitfall.is_pitfall)
        self.assertLessEqual(max(len(chunk.content) for chunk in chunks), 24)


class MemoryIndexTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.source = self.root / "2026-05-10.md"
        self.source.write_text(
            "---\n"
            "sample_id: PtFe-03\n"
            "date: 2026-05-10\n"
            "tags: [烧结, ICP]\n"
            "status: 原始观察\n"
            "---\n"
            "# 热解实验\n"
            "## 实验异常与踩坑点\n"
            "现象：石英舟内壁有黑色附着物。\n"
            "原因分析：升温速率过快。\n"
            "改进方案：后续升温改为 2°C/min。\n"
            "## 结果\nICP 偏低。\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_incremental_index_and_provenance(self) -> None:
        with MemoryIndex(self.root) as index:
            first = index.index()
            # The generated PITFALLS_SUMMARY.md is indexed in the same pass as
            # its source log, so the dashboard is immediately consistent.
            self.assertEqual(first.added, 2)
            self.assertTrue((self.root / ".scihub" / "memory.sqlite3").exists())
            self.assertTrue((self.root / ".scihub" / "memory-state.json").exists())
            self.assertTrue((self.root / ".scihub" / "index-status.json").exists())
            self.assertGreaterEqual(first.chunks, 2)
            hits = index.search("升温", limit=3)
            self.assertTrue(hits)
            self.assertTrue(hits[0].is_pitfall)
            self.assertEqual(hits[0].source_path, "2026-05-10.md")
            self.assertEqual(hits[0].metadata["sample_id"], "PtFe-03")
            second = index.index()
            self.assertGreaterEqual(second.unchanged, 2)
            self.assertEqual(second.updated, 0)

    def test_update_changes_hash_and_replaces_chunks(self) -> None:
        with MemoryIndex(self.root) as index:
            index.index(update_summary=False)
            self.source.write_text(self.source.read_text(encoding="utf-8") + "\n新增数据：产率 80%。\n", encoding="utf-8")
            report = index.index(update_summary=False)
            self.assertEqual(report.updated, 1)
            self.assertTrue(index.search("产率", auto_index=False))

    def test_summary_preserves_manual_region(self) -> None:
        summary = self.root / "PITFALLS_SUMMARY.md"
        summary.write_text(
            "# 手工标题\n\n手工说明，不应被覆盖。\n\n"
            f"{AUTO_START}\n旧内容\n{AUTO_END}\n\n结尾手工内容。\n",
            encoding="utf-8",
        )
        with MemoryIndex(self.root) as index:
            self.assertTrue(index.index().summary_updated)
        output = summary.read_text(encoding="utf-8")
        self.assertIn("手工说明，不应被覆盖。", output)
        self.assertIn("结尾手工内容。", output)
        self.assertIn("石英舟内壁", output)
        self.assertEqual(output.count(AUTO_START), 1)
        self.assertEqual(output.count(AUTO_END), 1)

    def test_status_and_json_helpers(self) -> None:
        with MemoryIndex(self.root) as index:
            index.index(update_summary=False)
            status = index.status()
            self.assertIn(status["index_mode"], {"fts5", "python"})
            payload = index.search("ICP", limit=1)[0].to_dict()
            json.dumps(payload, ensure_ascii=False)
            self.assertEqual(payload["source_path"], "2026-05-10.md")

    def test_python_search_fallback_without_fts5(self) -> None:
        class PythonOnlyIndex(MemoryIndex):
            def _detect_fts5(self) -> bool:
                return False

        with PythonOnlyIndex(self.root) as index:
            index.index(update_summary=False)
            self.assertEqual(index.status()["index_mode"], "python")
            hits = index.search("ICP", auto_index=False)
            self.assertTrue(hits)
            self.assertEqual(hits[0].source_path, "2026-05-10.md")


if __name__ == "__main__":
    unittest.main()
