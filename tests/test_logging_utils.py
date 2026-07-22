from __future__ import annotations

import logging
import unittest

from codex_tg_bridge.logging_utils import SecretRedactionFilter


class SecretRedactionFilterTests(unittest.TestCase):
    def test_redacts_secret_from_message_and_arguments(self) -> None:
        secret = "123:secret-token"
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="request %s",
            args=(f"https://example.test/bot{secret}/getMe",),
            exc_info=None,
        )

        SecretRedactionFilter([secret]).filter(record)

        self.assertNotIn(secret, record.getMessage())
        self.assertIn("[REDACTED]", record.getMessage())


if __name__ == "__main__":
    unittest.main()
