from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from codex_tg_bridge.codex.client import CodexClient
from codex_tg_bridge.config import Settings


async def run() -> None:
    logging.basicConfig(level=logging.DEBUG)
    root = Path.cwd()
    settings = Settings(
        telegram_bot_token="smoke-test-only",
        telegram_allowed_user_ids=frozenset({1}),
        codex_binary="codex",
        codex_workdir=root,
        codex_model=None,
        codex_sandbox="workspace-write",
        database_path=Path("/tmp/codex-tg-smoke.sqlite3"),
        log_level="INFO",
    )
    client = CodexClient(settings)
    await client.start()
    await client.stop()
    print("app-server handshake: ok")


if __name__ == "__main__":
    asyncio.run(run())
