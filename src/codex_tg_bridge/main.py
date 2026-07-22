from __future__ import annotations

import asyncio
import logging
import signal
import sys

from codex_tg_bridge.application import ChatBridge
from codex_tg_bridge.codex.client import CodexClient
from codex_tg_bridge.config import ConfigurationError, load_settings
from codex_tg_bridge.logging_utils import configure_secret_safe_logging
from codex_tg_bridge.local.server import LocalControlServer
from codex_tg_bridge.persistence.sqlite import SessionStore
from codex_tg_bridge.surfaces import MultiplexEventSink
from codex_tg_bridge.telegram.bot import TelegramService


logger = logging.getLogger(__name__)


async def run() -> None:
    settings = load_settings()
    configure_secret_safe_logging(
        getattr(logging, settings.log_level, logging.INFO),
        settings.telegram_bot_token,
    )

    store = SessionStore(settings.database_path)
    store.initialize()
    codex = CodexClient(settings)
    telegram = TelegramService(settings)
    local = LocalControlServer(settings)
    sink = MultiplexEventSink(telegram.sink, local)
    bridge = ChatBridge(settings, codex, store, sink)
    telegram.bind_bridge(bridge)
    local.bind_bridge(bridge)

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, stop_event.set)
        except NotImplementedError:
            pass

    try:
        await codex.start()
        await telegram.start()
        await local.start()
        logger.info("Codex Telegram Bridge 已启动")
        await stop_event.wait()
    finally:
        await local.stop()
        await telegram.stop()
        await codex.stop()
        store.close()


def main() -> None:
    try:
        asyncio.run(run())
    except ConfigurationError as exc:
        print(f"配置错误：{exc}", file=sys.stderr)
        raise SystemExit(2) from exc
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
