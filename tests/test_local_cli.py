from __future__ import annotations

import unittest
from unittest.mock import patch

from codex_tg_bridge.local.cli import main


class LocalCliTests(unittest.TestCase):
    def test_keyboard_interrupt_exits_cleanly(self) -> None:
        with patch("codex_tg_bridge.local.cli.run", new=lambda: None), patch(
            "codex_tg_bridge.local.cli.asyncio.run", side_effect=KeyboardInterrupt
        ):
            main()


if __name__ == "__main__":
    unittest.main()
