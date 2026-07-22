from __future__ import annotations

import unittest

from codex_tg_bridge.telegram.formatter import split_text, stream_preview


class FormatterTests(unittest.TestCase):
    def test_splits_long_text_without_losing_content(self) -> None:
        text = "a" * 5000
        chunks = split_text(text, limit=1000)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(len(chunk) <= 1000 for chunk in chunks))

    def test_stream_preview_is_bounded(self) -> None:
        text = "a" * 5000 + "LATEST"
        preview = stream_preview(text)
        self.assertLessEqual(len(preview), 4096)
        self.assertIn("前文暂时折叠", preview)
        self.assertTrue(preview.endswith("LATEST"))


if __name__ == "__main__":
    unittest.main()
