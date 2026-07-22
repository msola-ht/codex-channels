from __future__ import annotations

import asyncio
import json
import unittest
from typing import Any

from codex_tg_bridge.codex.jsonrpc import JsonRpcConnection, JsonRpcError


class FakeWriter:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    def write(self, payload: bytes) -> None:
        self.messages.append(json.loads(payload))

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        return None

    async def wait_closed(self) -> None:
        return None


class JsonRpcConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.reader = asyncio.StreamReader()
        self.writer = FakeWriter()
        self.connection = JsonRpcConnection(self.reader, self.writer)  # type: ignore[arg-type]
        await self.connection.start()

    async def asyncTearDown(self) -> None:
        await self.connection.close()

    async def test_correlates_response_to_request(self) -> None:
        task = asyncio.create_task(self.connection.request("thread/start", {}))
        await asyncio.sleep(0)
        request_id = self.writer.messages[-1]["id"]
        self.reader.feed_data(
            (json.dumps({"id": request_id, "result": {"ok": True}}) + "\n").encode()
        )

        self.assertEqual(await task, {"ok": True})

    async def test_turns_error_response_into_exception(self) -> None:
        task = asyncio.create_task(self.connection.request("turn/start", {}))
        await asyncio.sleep(0)
        request_id = self.writer.messages[-1]["id"]
        self.reader.feed_data(
            (
                json.dumps(
                    {
                        "id": request_id,
                        "error": {"code": -32000, "message": "failed"},
                    }
                )
                + "\n"
            ).encode()
        )

        with self.assertRaises(JsonRpcError):
            await task

    async def test_dispatches_notification(self) -> None:
        received: list[tuple[str, dict[str, Any]]] = []

        async def handler(method: str, params: dict[str, Any]) -> None:
            received.append((method, params))

        self.connection.add_notification_handler(handler)
        self.reader.feed_data(
            (
                json.dumps(
                    {
                        "method": "item/agentMessage/delta",
                        "params": {"delta": "hello"},
                    }
                )
                + "\n"
            ).encode()
        )
        await asyncio.sleep(0)

        self.assertEqual(
            received,
            [("item/agentMessage/delta", {"delta": "hello"})],
        )

    async def test_handles_server_request_without_blocking_reader(self) -> None:
        gate = asyncio.Event()

        async def handler(method: str, params: dict[str, Any]) -> dict[str, Any]:
            self.assertEqual(method, "item/commandExecution/requestApproval")
            self.assertEqual(params, {"command": "pwd"})
            await gate.wait()
            return {"decision": "accept"}

        self.connection.set_server_request_handler(handler)
        self.reader.feed_data(
            (
                json.dumps(
                    {
                        "id": 91,
                        "method": "item/commandExecution/requestApproval",
                        "params": {"command": "pwd"},
                    }
                )
                + "\n"
            ).encode()
        )
        request = asyncio.create_task(self.connection.request("model/list", {}))
        await asyncio.sleep(0)
        outgoing_id = self.writer.messages[-1]["id"]
        self.reader.feed_data(
            (json.dumps({"id": outgoing_id, "result": {"data": []}}) + "\n").encode()
        )

        self.assertEqual(await request, {"data": []})
        gate.set()
        for _ in range(5):
            await asyncio.sleep(0)
            if any(message.get("id") == 91 for message in self.writer.messages):
                break
        response = next(message for message in self.writer.messages if message.get("id") == 91)
        self.assertEqual(response["result"], {"decision": "accept"})

    async def test_rejects_unhandled_server_request(self) -> None:
        self.reader.feed_data(
            (json.dumps({"id": "server-1", "method": "unknown", "params": {}}) + "\n").encode()
        )
        for _ in range(5):
            await asyncio.sleep(0)
            if self.writer.messages:
                break

        self.assertEqual(self.writer.messages[-1]["id"], "server-1")
        self.assertEqual(self.writer.messages[-1]["error"]["code"], -32601)


if __name__ == "__main__":
    unittest.main()
