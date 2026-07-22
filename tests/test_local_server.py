from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from codex_tg_bridge.application import ApprovalRequest, BridgeStatus, Submission
from codex_tg_bridge.config import Settings
from codex_tg_bridge.local.server import LocalControlServer
from codex_tg_bridge.persistence.sqlite import SessionRecord


class FakeBridge:
    def __init__(self) -> None:
        self.submissions: list[tuple[int, str]] = []
        self.switched_to: str | None = None

    async def submit(
        self, chat_id: int, text: str, *, source: str = "telegram"
    ) -> Submission:
        del source
        self.submissions.append((chat_id, text))
        return Submission("thread-1", "turn-1", False)

    def status(self, chat_id: int) -> BridgeStatus:
        del chat_id
        return BridgeStatus("thread-1", None, "/workspace", "gpt-test", "workspace-write")

    def list_sessions(self, chat_id: int) -> list[SessionRecord]:
        return [SessionRecord(chat_id, "thread-1", "测试会话", "2026-07-21", 1)]

    async def switch_session(self, chat_id: int, selector: str) -> str:
        del chat_id
        self.switched_to = selector
        return "thread-1"


class LocalControlServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        settings = Settings(
            telegram_bot_token="token",
            telegram_allowed_user_ids=frozenset({100}),
            codex_binary="codex",
            codex_workdir=root,
            codex_model="gpt-test",
            codex_sandbox="workspace-write",
            database_path=root / "state.sqlite3",
            log_level="INFO",
            approval_timeout_seconds=30,
            local_socket_path=root / "bridge.sock",
            local_cli_chat_id=100,
        )
        self.bridge = FakeBridge()
        self.server = LocalControlServer(settings)
        self.server.bind_bridge(self.bridge)  # type: ignore[arg-type]
        await self.server.start()
        self.reader, self.writer = await asyncio.open_unix_connection(
            str(settings.local_socket_path)
        )
        self.assertEqual((await self._read())["type"], "ready")
        self.writer.write(
            (json.dumps({"type": "hello", "client": "cli"}) + "\n").encode()
        )
        await self.writer.drain()

    async def asyncTearDown(self) -> None:
        self.writer.close()
        await self.writer.wait_closed()
        await self.server.stop()
        self.temp_dir.cleanup()

    async def _read(self) -> dict[str, Any]:
        return json.loads(await self.reader.readline())

    async def _send(self, text: str) -> None:
        self.writer.write(
            (json.dumps({"type": "input", "text": text}) + "\n").encode()
        )
        await self.writer.drain()

    async def test_submits_input_and_streams_events(self) -> None:
        await self._send("检查项目")
        self.assertEqual((await self._read())["message"], "已提交 Codex 任务")
        self.assertEqual(self.bridge.submissions, [(100, "检查项目")])

        await self.server.on_delta(100, "turn-1", "item-1", "处理中")
        event = await self._read()
        self.assertEqual(
            event,
            {
                "type": "delta",
                "turn_id": "turn-1",
                "item_id": "item-1",
                "new_item": True,
                "text": "处理中",
            },
        )

    async def test_lists_and_switches_shared_sessions(self) -> None:
        await self._send("/sessions")
        self.assertIn("测试会话", (await self._read())["message"])

        await self._send("/switch 1")
        self.assertIn("thread-1", (await self._read())["message"])
        self.assertEqual(self.bridge.switched_to, "1")

    async def test_resolves_approval_from_cli(self) -> None:
        approval = asyncio.create_task(
            self.server.request_approval(
                100, ApprovalRequest("command", "执行命令", "命令：pwd", None)
            )
        )
        request = await self._read()
        self.assertEqual(request["type"], "approval")

        await self._send(f"/approve {request['token']}")
        result = await self._read()
        acknowledgement = await self._read()
        self.assertEqual(result["type"], "approval_result")
        self.assertEqual(acknowledgement["message"], "审批已处理")
        self.assertTrue(await approval)


if __name__ == "__main__":
    unittest.main()
