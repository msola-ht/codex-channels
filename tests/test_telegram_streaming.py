from __future__ import annotations

import asyncio
import unittest
from typing import Any

from codex_tg_bridge.telegram.bot import TelegramEventSink


class FakeMessage:
    def __init__(self) -> None:
        self.edits: list[str] = []

    async def edit_text(self, text: str) -> None:
        self.edits.append(text)


class BlockingBot:
    def __init__(self) -> None:
        self.send_started = asyncio.Event()
        self.release_send = asyncio.Event()
        self.message = FakeMessage()

    async def send_message(
        self, chat_id: int, text: str, *, reply_markup: Any = None
    ) -> FakeMessage:
        del chat_id, text, reply_markup
        self.send_started.set()
        await self.release_send.wait()
        return self.message


class RecordingBot:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self.messages: list[FakeMessage] = []

    async def send_message(
        self, chat_id: int, text: str, *, reply_markup: Any = None
    ) -> FakeMessage:
        del chat_id, reply_markup
        message = FakeMessage()
        self.sent.append(text)
        self.messages.append(message)
        return message


class TelegramStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_telegram_network_does_not_block_incoming_deltas(self) -> None:
        bot = BlockingBot()
        sink = TelegramEventSink(bot)  # type: ignore[arg-type]

        await sink.on_delta(100, "turn-1", "item-1", "第一段")
        await asyncio.wait_for(bot.send_started.wait(), timeout=1)
        await asyncio.wait_for(
            sink.on_delta(100, "turn-1", "item-1", "第二段"), timeout=0.1
        )

        bot.release_send.set()
        await sink.on_completed(100, "turn-1", "completed")
        self.assertEqual(bot.message.edits[-1], "第一段第二段")

    async def test_separates_agent_message_items_in_the_same_turn(self) -> None:
        bot = RecordingBot()
        sink = TelegramEventSink(bot)  # type: ignore[arg-type]

        await sink.on_delta(100, "turn-1", "item-1", "阶段消息")
        await sink.on_delta(100, "turn-1", "item-2", "最终回复")
        await sink.on_completed(100, "turn-1", "completed")

        self.assertEqual(bot.sent, ["阶段消息", "最终回复"])


if __name__ == "__main__":
    unittest.main()
