from __future__ import annotations

import asyncio
import unittest
from typing import Any

from codex_tg_bridge.application import ApprovalRequest
from codex_tg_bridge.surfaces import MultiplexEventSink


class FakeSurface:
    def __init__(self, decision: bool | None = None) -> None:
        self.decision = decision
        self.inputs: list[tuple[int, str, str]] = []
        self.cancelled = False

    async def on_input(self, chat_id: int, text: str, source: str) -> None:
        self.inputs.append((chat_id, text, source))

    async def on_delta(self, *args: Any) -> None:
        del args

    async def on_completed(self, *args: Any) -> None:
        del args

    async def on_error(self, *args: Any) -> None:
        del args

    async def request_approval(self, *args: Any) -> bool:
        del args
        if self.decision is not None:
            return self.decision
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return False


class FakeLocal(FakeSurface):
    def has_clients(self, chat_id: int) -> bool:
        del chat_id
        return True


class MultiplexEventSinkTests(unittest.IsolatedAsyncioTestCase):
    async def test_first_approval_surface_wins_and_cancels_other(self) -> None:
        telegram = FakeSurface()
        local = FakeLocal(True)
        sink = MultiplexEventSink(telegram, local)  # type: ignore[arg-type]

        approved = await sink.request_approval(
            100, ApprovalRequest("command", "执行", "pwd", None)
        )

        self.assertTrue(approved)
        self.assertTrue(telegram.cancelled)

    async def test_forwards_input_to_both_surfaces(self) -> None:
        telegram = FakeSurface()
        local = FakeLocal()
        sink = MultiplexEventSink(telegram, local)  # type: ignore[arg-type]

        await sink.on_input(100, "检查项目", "cli")

        self.assertEqual(telegram.inputs, [(100, "检查项目", "cli")])
        self.assertEqual(local.inputs, [(100, "检查项目", "cli")])


if __name__ == "__main__":
    unittest.main()
