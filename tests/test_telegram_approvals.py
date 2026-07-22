from __future__ import annotations

import asyncio
import unittest
from typing import Any

from codex_tg_bridge.application import ApprovalRequest
from codex_tg_bridge.telegram.bot import TelegramEventSink


class FakeMessage:
    def __init__(self) -> None:
        self.edits: list[str] = []

    async def edit_text(self, text: str) -> None:
        self.edits.append(text)


class FakeBot:
    def __init__(self) -> None:
        self.message = FakeMessage()
        self.sent: list[tuple[int, str, Any]] = []

    async def send_message(
        self, chat_id: int, text: str, *, reply_markup: Any = None
    ) -> FakeMessage:
        self.sent.append((chat_id, text, reply_markup))
        return self.message


class TelegramApprovalTests(unittest.IsolatedAsyncioTestCase):
    async def test_approval_is_scoped_to_originating_chat(self) -> None:
        bot = FakeBot()
        sink = TelegramEventSink(bot)  # type: ignore[arg-type]
        task = asyncio.create_task(
            sink.request_approval(
                100,
                ApprovalRequest("command", "执行命令", "命令：pwd", "测试"),
            )
        )
        await asyncio.sleep(0)
        token = next(iter(sink._approvals))

        self.assertFalse(
            await sink.resolve_approval(token, chat_id=200, approved=True)
        )
        self.assertTrue(
            await sink.resolve_approval(token, chat_id=100, approved=True)
        )
        self.assertTrue(await task)
        self.assertIn("处理结果：已批准一次", bot.message.edits[-1])

    async def test_approval_timeout_denies_request(self) -> None:
        bot = FakeBot()
        sink = TelegramEventSink(bot)  # type: ignore[arg-type]
        sink.APPROVAL_TIMEOUT_SECONDS = 0.01

        approved = await sink.request_approval(
            100, ApprovalRequest("file", "写入文件", "范围：/tmp", None)
        )

        self.assertFalse(approved)
        self.assertIn("审批超时，已自动拒绝", bot.message.edits[-1])


if __name__ == "__main__":
    unittest.main()
