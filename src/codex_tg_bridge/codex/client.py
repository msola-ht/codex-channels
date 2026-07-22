from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from codex_tg_bridge.codex.jsonrpc import (
    JsonObject,
    JsonRpcConnection,
    ServerRequestHandler,
)
from codex_tg_bridge.config import Settings


logger = logging.getLogger(__name__)
EventHandler = Callable[[str, JsonObject], Awaitable[None] | None]
APP_SERVER_LINE_LIMIT = 16 * 1024 * 1024


class CodexClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._process: asyncio.subprocess.Process | None = None
        self._connection: JsonRpcConnection | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._event_handlers: list[EventHandler] = []
        self._server_request_handler: ServerRequestHandler | None = None

    def add_event_handler(self, handler: EventHandler) -> None:
        self._event_handlers.append(handler)
        if self._connection is not None:
            self._connection.add_notification_handler(handler)

    def set_server_request_handler(self, handler: ServerRequestHandler) -> None:
        self._server_request_handler = handler
        if self._connection is not None:
            self._connection.set_server_request_handler(handler)

    async def start(self) -> None:
        if self._process is not None:
            return
        self._process = await asyncio.create_subprocess_exec(
            self._settings.codex_binary,
            "app-server",
            "--stdio",
            cwd=self._settings.codex_workdir,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=APP_SERVER_LINE_LIMIT,
        )
        assert self._process.stdin is not None
        assert self._process.stdout is not None
        assert self._process.stderr is not None

        self._connection = JsonRpcConnection(self._process.stdout, self._process.stdin)
        for handler in self._event_handlers:
            self._connection.add_notification_handler(handler)
        if self._server_request_handler is not None:
            self._connection.set_server_request_handler(self._server_request_handler)
        await self._connection.start()
        self._stderr_task = asyncio.create_task(self._drain_stderr(self._process.stderr))

        try:
            await self._connection.request(
                "initialize",
                {
                    "clientInfo": {
                        "name": "codex_tg_bridge",
                        "title": "Codex Telegram Bridge",
                        "version": "0.1.0",
                    }
                },
            )
            await self._connection.notify("initialized")
        except Exception:
            await self.stop()
            raise

    async def stop(self) -> None:
        if self._connection is not None:
            await self._connection.close()
            self._connection = None
        if self._process is not None and self._process.returncode is None:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()
        self._process = None
        if self._stderr_task is not None:
            self._stderr_task.cancel()
            await asyncio.gather(self._stderr_task, return_exceptions=True)
            self._stderr_task = None

    async def start_thread(
        self,
        *,
        model: str | None = None,
        sandbox: str | None = None,
    ) -> str:
        params: JsonObject = {
            "cwd": str(self._settings.codex_workdir),
            "sandbox": sandbox or self._settings.codex_sandbox,
            "approvalPolicy": "on-request",
        }
        selected_model = model or self._settings.codex_model
        if selected_model is not None:
            params["model"] = selected_model
        result = await self._request("thread/start", params)
        return str(result["thread"]["id"])

    async def resume_thread(
        self,
        thread_id: str,
        *,
        model: str | None = None,
        sandbox: str | None = None,
    ) -> None:
        params: JsonObject = {
            "threadId": thread_id,
            "cwd": str(self._settings.codex_workdir),
            "sandbox": sandbox or self._settings.codex_sandbox,
            "approvalPolicy": "on-request",
        }
        selected_model = model or self._settings.codex_model
        if selected_model is not None:
            params["model"] = selected_model
        await self._request("thread/resume", params)

    async def start_turn(
        self,
        thread_id: str,
        text: str,
        *,
        model: str | None = None,
    ) -> str:
        params: JsonObject = {
            "threadId": thread_id,
            "input": [{"type": "text", "text": text}],
        }
        if model is not None:
            params["model"] = model
        result = await self._request(
            "turn/start",
            params,
        )
        return str(result["turn"]["id"])

    async def steer_turn(self, thread_id: str, turn_id: str, text: str) -> None:
        await self._request(
            "turn/steer",
            {
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": [{"type": "text", "text": text}],
            },
        )

    async def interrupt_turn(self, thread_id: str, turn_id: str) -> None:
        await self._request(
            "turn/interrupt",
            {"threadId": thread_id, "turnId": turn_id},
        )

    async def list_models(self) -> list[JsonObject]:
        result = await self._request("model/list", {"limit": 100})
        return list(result.get("data") or [])

    async def compact_thread(self, thread_id: str) -> None:
        await self._request("thread/compact/start", {"threadId": thread_id})

    async def fork_thread(
        self,
        thread_id: str,
        *,
        model: str | None = None,
        sandbox: str | None = None,
    ) -> str:
        params: JsonObject = {
            "threadId": thread_id,
            "cwd": str(self._settings.codex_workdir),
            "sandbox": sandbox or self._settings.codex_sandbox,
            "approvalPolicy": "on-request",
        }
        selected_model = model or self._settings.codex_model
        if selected_model is not None:
            params["model"] = selected_model
        result = await self._request("thread/fork", params)
        return str(result["thread"]["id"])

    async def start_review(self, thread_id: str, target: JsonObject) -> tuple[str, str]:
        result = await self._request(
            "review/start",
            {"threadId": thread_id, "target": target, "delivery": "inline"},
        )
        return str(result["reviewThreadId"]), str(result["turn"]["id"])

    async def list_skills(self) -> list[JsonObject]:
        result = await self._request(
            "skills/list",
            {"cwds": [str(self._settings.codex_workdir)], "forceReload": False},
        )
        return list(result.get("data") or [])

    async def list_mcp_servers(self, thread_id: str | None = None) -> list[JsonObject]:
        params: JsonObject = {"limit": 100, "detail": "toolsAndAuthOnly"}
        if thread_id is not None:
            params["threadId"] = thread_id
        result = await self._request("mcpServerStatus/list", params)
        return list(result.get("data") or [])

    async def list_plugins(self) -> list[JsonObject]:
        result = await self._request(
            "plugin/list",
            {"cwds": [str(self._settings.codex_workdir)]},
        )
        return list(result.get("marketplaces") or [])

    async def account_usage(self) -> JsonObject:
        return await self._request("account/usage/read", {})

    async def list_permission_profiles(self) -> list[JsonObject]:
        result = await self._request(
            "permissionProfile/list",
            {"cwd": str(self._settings.codex_workdir), "limit": 100},
        )
        return list(result.get("data") or [])

    async def get_goal(self, thread_id: str) -> JsonObject | None:
        result = await self._request("thread/goal/get", {"threadId": thread_id})
        goal = result.get("goal")
        return goal if isinstance(goal, dict) else None

    async def set_goal(self, thread_id: str, objective: str) -> JsonObject:
        result = await self._request(
            "thread/goal/set",
            {"threadId": thread_id, "objective": objective, "status": "active"},
        )
        return result["goal"]

    async def clear_goal(self, thread_id: str) -> None:
        await self._request("thread/goal/clear", {"threadId": thread_id})

    async def _request(self, method: str, params: JsonObject) -> Any:
        if self._connection is None:
            raise RuntimeError("Codex App Server 尚未启动")
        return await self._connection.request(method, params)

    async def _drain_stderr(self, stream: asyncio.StreamReader) -> None:
        try:
            while line := await stream.readline():
                logger.debug("codex: %s", line.decode(errors="replace").rstrip())
        except asyncio.CancelledError:
            raise
