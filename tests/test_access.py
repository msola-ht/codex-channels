from __future__ import annotations

import unittest

from codex_tg_bridge.security.access import AccessController


class AccessControllerTests(unittest.TestCase):
    def test_allows_only_configured_users(self) -> None:
        access = AccessController({10, 20})
        self.assertTrue(access.is_allowed(10))
        self.assertFalse(access.is_allowed(30))
        self.assertFalse(access.is_allowed(None))


if __name__ == "__main__":
    unittest.main()

