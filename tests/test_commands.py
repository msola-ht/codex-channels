from __future__ import annotations

import unittest

from codex_tg_bridge.telegram.commands import (
    format_goal,
    format_models,
    format_sessions,
    parse_review_target,
)
from codex_tg_bridge.persistence.sqlite import SessionRecord


class CommandFormattingTests(unittest.TestCase):
    def test_parses_review_targets(self) -> None:
        self.assertEqual(
            parse_review_target([]),
            {"type": "uncommittedChanges"},
        )
        self.assertEqual(
            parse_review_target(["branch", "main"]),
            {"type": "baseBranch", "branch": "main"},
        )
        self.assertEqual(
            parse_review_target(["commit", "abc123"]),
            {"type": "commit", "sha": "abc123"},
        )
        self.assertEqual(
            parse_review_target(["只检查", "安全问题"]),
            {"type": "custom", "instructions": "只检查 安全问题"},
        )

    def test_formats_current_model(self) -> None:
        result = format_models(
            [{"model": "gpt-test", "displayName": "Test", "isDefault": True}],
            "gpt-test",
        )
        self.assertIn("gpt-test", result)
        self.assertIn("当前", result)

    def test_formats_missing_goal(self) -> None:
        self.assertIn("没有 Goal", format_goal(None))

    def test_formats_session_list_and_current_marker(self) -> None:
        sessions = [
            SessionRecord(1, "thread-1234567890", "项目甲", "2026-07-21", 2),
            SessionRecord(1, "thread-abcdefghij", None, "2026-07-20", 1),
        ]
        result = format_sessions(sessions, "thread-1234567890")
        self.assertIn("1. 项目甲", result)
        self.assertIn("← 当前", result)
        self.assertIn("/switch", result)


if __name__ == "__main__":
    unittest.main()
