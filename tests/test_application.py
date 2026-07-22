from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

from codex_tg_bridge.application import ChatBridge
from codex_tg_bridge.config import Settings
from codex_tg_bridge.persistence.sqlite import SessionStore


class FakeCodexClient:
    def __init__(self) -> None:
        self.handler: Any = None
        self.request_handler: Any = None
        self.started_threads = 0
        self.steered: list[tuple[str, str, str]] = []
        self.interrupted: list[tuple[str, str]] = []
        self.resumed: list[str] = []

    def add_event_handler(self, handler: Any) -> None:
        self.handler = handler

    def set_server_request_handler(self, handler: Any) -> None:
        self.request_handler = handler

    async def start_thread(
        self, *, model: str | None = None, sandbox: str | None = None
    ) -> str:
        del model, sandbox
        self.started_threads += 1
        return f"thread-{self.started_threads}"

    async def resume_thread(
        self,
        thread_id: str,
        *,
        model: str | None = None,
        sandbox: str | None = None,
    ) -> None:
        del model, sandbox
        self.resumed.append(thread_id)

    async def start_turn(
        self, thread_id: str, text: str, *, model: str | None = None
    ) -> str:
        del thread_id, text, model
        return "turn-1"

    async def steer_turn(self, thread_id: str, turn_id: str, text: str) -> None:
        self.steered.append((thread_id, turn_id, text))

    async def interrupt_turn(self, thread_id: str, turn_id: str) -> None:
        self.interrupted.append((thread_id, turn_id))

    async def list_models(self) -> list[dict[str, Any]]:
        return [
            {"id": "gpt-test", "model": "gpt-test", "displayName": "Test"},
            {"id": "gpt-alt", "model": "gpt-alt", "displayName": "Alt"},
        ]


class FakeSink:
    def __init__(self) -> None:
        self.deltas: list[tuple[int, str, str, str]] = []
        self.completed: list[tuple[int, str, str]] = []
        self.approvals: list[tuple[int, Any]] = []
        self.approved = False
        self.inputs: list[tuple[int, str, str]] = []

    async def on_input(self, chat_id: int, text: str, source: str) -> None:
        self.inputs.append((chat_id, text, source))

    async def on_delta(
        self, chat_id: int, turn_id: str, item_id: str, delta: str
    ) -> None:
        self.deltas.append((chat_id, turn_id, item_id, delta))

    async def on_completed(self, chat_id: int, turn_id: str, status: str) -> None:
        self.completed.append((chat_id, turn_id, status))

    async def on_error(self, chat_id: int, message: str) -> None:
        del chat_id, message

    async def request_approval(self, chat_id: int, request: Any) -> bool:
        self.approvals.append((chat_id, request))
        return self.approved


class ChatBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.store = SessionStore(root / "state.sqlite3")
        self.store.initialize()
        self.codex = FakeCodexClient()
        self.sink = FakeSink()
        settings = Settings(
            telegram_bot_token="token",
            telegram_allowed_user_ids=frozenset({1}),
            codex_binary="codex",
            codex_workdir=root,
            codex_model=None,
            codex_sandbox="workspace-write",
            database_path=root / "state.sqlite3",
            log_level="INFO",
            approval_timeout_seconds=300,
            local_socket_path=root / "bridge.sock",
            local_cli_chat_id=1,
        )
        self.bridge = ChatBridge(settings, self.codex, self.store, self.sink)  # type: ignore[arg-type]

    async def asyncTearDown(self) -> None:
        self.store.close()
        self.temp_dir.cleanup()

    async def test_creates_thread_then_steers_active_turn(self) -> None:
        first = await self.bridge.submit(100, "first")
        second = await self.bridge.submit(100, "second")

        self.assertEqual(first.thread_id, "thread-1")
        self.assertFalse(first.steered)
        self.assertTrue(second.steered)
        self.assertEqual(self.codex.steered, [("thread-1", "turn-1", "second")])
        self.assertEqual(
            self.sink.inputs,
            [(100, "first", "telegram"), (100, "second", "telegram")],
        )

    async def test_routes_delta_and_completion_to_sink(self) -> None:
        await self.bridge.submit(100, "first")
        await self.codex.handler(
            "item/agentMessage/delta",
            {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "delta": "hello",
            },
        )
        await self.codex.handler(
            "turn/completed",
            {
                "threadId": "thread-1",
                "turn": {"id": "turn-1", "status": "completed"},
            },
        )

        self.assertEqual(self.sink.deltas, [(100, "turn-1", "item-1", "hello")])
        self.assertEqual(self.sink.completed, [(100, "turn-1", "completed")])
        self.assertIsNone(self.bridge.status(100).turn_id)

    async def test_persists_model_preference(self) -> None:
        await self.bridge.set_model(100, "gpt-alt")
        status = self.bridge.status(100)

        self.assertEqual(status.model, "gpt-alt")
        self.assertEqual(self.store.get_preferences(100)[0], "gpt-alt")

    async def test_lists_names_and_switches_historical_sessions(self) -> None:
        await self.bridge.submit(100, "first")
        await self.codex.handler(
            "turn/completed",
            {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}},
        )
        await self.bridge.new_session(100)
        await self.bridge.submit(100, "second")
        await self.codex.handler(
            "turn/completed",
            {"threadId": "thread-2", "turn": {"id": "turn-1", "status": "completed"}},
        )

        await self.bridge.rename_session(100, "第二个会话")
        self.assertEqual(len(self.bridge.list_sessions(100)), 2)
        self.assertEqual(self.bridge.list_sessions(100)[0].label, "第二个会话")

        switched = await self.bridge.switch_session(100, "2")
        self.assertEqual(switched, "thread-1")
        self.assertEqual(self.bridge.status(100).thread_id, "thread-1")
        self.assertIn("thread-1", self.codex.resumed)

        previous = await self.bridge.switch_last_session(100)
        self.assertEqual(previous, "thread-2")
        self.assertEqual(self.bridge.status(100).thread_id, "thread-2")

    async def test_rejects_switch_while_turn_is_active(self) -> None:
        await self.bridge.submit(100, "first")
        with self.assertRaisesRegex(RuntimeError, "先 /stop"):
            await self.bridge.switch_session(100, "1")

    async def test_routes_command_approval_to_owning_chat(self) -> None:
        await self.bridge.submit(100, "first")
        self.sink.approved = True

        response = await self.codex.request_handler(
            "item/commandExecution/requestApproval",
            {
                "threadId": "thread-1",
                "command": "git status",
                "cwd": "/workspace",
                "reason": "需要读取状态",
            },
        )

        self.assertEqual(response, {"decision": "accept"})
        self.assertEqual(self.sink.approvals[0][0], 100)
        self.assertIn("git status", self.sink.approvals[0][1].details)

    async def test_denies_unmapped_and_permission_requests_safely(self) -> None:
        unmapped = await self.codex.request_handler(
            "item/fileChange/requestApproval", {"threadId": "missing"}
        )
        self.assertEqual(unmapped, {"decision": "decline"})

        await self.bridge.submit(100, "first")
        denied = await self.codex.request_handler(
            "item/permissions/requestApproval",
            {
                "threadId": "thread-1",
                "cwd": "/workspace",
                "permissions": {"network": {"enabled": True}},
            },
        )
        self.assertEqual(denied, {"permissions": {}, "scope": "turn"})


if __name__ == "__main__":
    unittest.main()
