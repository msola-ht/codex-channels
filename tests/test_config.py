from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from codex_tg_bridge.config import ConfigurationError, load_settings


class SettingsTests(unittest.TestCase):
    def test_loads_dotenv_and_parses_user_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            env_file = root / ".env"
            env_file.write_text(
                "\n".join(
                    [
                        "TELEGRAM_BOT_TOKEN=test-token",
                        "TELEGRAM_ALLOWED_USER_IDS=123, 456",
                        "CODEX_BINARY=/bin/echo",
                        f"CODEX_WORKDIR={root}",
                        "DATABASE_PATH=./state.sqlite3",
                        "LOCAL_CLI_CHAT_ID=123",
                    ]
                ),
                encoding="utf-8",
            )
            settings = load_settings(env_file, environ={})

        self.assertEqual(settings.telegram_bot_token, "test-token")
        self.assertEqual(settings.telegram_allowed_user_ids, frozenset({123, 456}))
        self.assertEqual(settings.codex_sandbox, "workspace-write")
        self.assertEqual(settings.approval_timeout_seconds, 300)
        self.assertEqual(settings.local_cli_chat_id, 123)

    def test_rejects_empty_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            env_file = root / ".env"
            env_file.write_text(
                "\n".join(
                    [
                        "TELEGRAM_BOT_TOKEN=test-token",
                        "TELEGRAM_ALLOWED_USER_IDS=",
                        "CODEX_BINARY=/bin/echo",
                        f"CODEX_WORKDIR={root}",
                    ]
                ),
                encoding="utf-8",
            )
            with self.assertRaises(ConfigurationError):
                load_settings(env_file, environ={})

    def test_rejects_danger_full_access(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            env_file = root / ".env"
            env_file.write_text(
                "\n".join(
                    [
                        "TELEGRAM_BOT_TOKEN=test-token",
                        "TELEGRAM_ALLOWED_USER_IDS=123",
                        "CODEX_BINARY=/bin/echo",
                        f"CODEX_WORKDIR={root}",
                        "CODEX_BRIDGE_SANDBOX=danger-full-access",
                    ]
                ),
                encoding="utf-8",
            )
            with self.assertRaises(ConfigurationError):
                load_settings(env_file, environ={})


if __name__ == "__main__":
    unittest.main()
