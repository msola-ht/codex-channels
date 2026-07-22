from __future__ import annotations

import asyncio
import inspect
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any


logger = logging.getLogger(__name__)
JsonObject = dict[str, Any]
NotificationHandler = Callable[[str, JsonObject], Awaitable[None] | None]
ServerRequestHandler = Callable[[str, JsonObject], Awaitable[Any] | Any]


class JsonRpcError(RuntimeError):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"JSON-RPC {code}: {message}")
        self.code = code
        self.message = message
        self.data = data


class JsonRpcConnection:
    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        *,
        request_timeout: float = 60.0,
    ) -> None:
        self._reader = reader
        self._writer = writer
        self._request_timeout = request_timeout
        self._next_id = 1
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._handlers: list[NotificationHandler] = []
        self._server_request_handler: ServerRequestHandler | None = None
        self._server_request_tasks: set[asyncio.Task[None]] = set()
        self._reader_task: asyncio.Task[None] | None = None
        self._write_lock = asyncio.Lock()

    def add_notification_handler(self, handler: NotificationHandler) -> None:
        self._handlers.append(handler)

    def set_server_request_handler(self, handler: ServerRequestHandler) -> None:
        self._server_request_handler = handler

    async def start(self) -> None:
        if self._reader_task is None:
            self._reader_task = asyncio.create_task(self._read_loop())

    async def request(self, method: str, params: JsonObject) -> Any:
        request_id = self._next_id
        self._next_id += 1
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        await self._send({"method": method, "id": request_id, "params": params})
        try:
            return await asyncio.wait_for(future, timeout=self._request_timeout)
        finally:
            self._pending.pop(request_id, None)

    async def notify(self, method: str, params: JsonObject | None = None) -> None:
        await self._send({"method": method, "params": params or {}})

    async def close(self) -> None:
        for task in tuple(self._server_request_tasks):
            task.cancel()
        if self._server_request_tasks:
            await asyncio.gather(*self._server_request_tasks, return_exceptions=True)
            self._server_request_tasks.clear()
        if self._reader_task is not None:
            self._reader_task.cancel()
            await asyncio.gather(self._reader_task, return_exceptions=True)
            self._reader_task = None
        self._fail_pending(ConnectionError("Codex App Server connection closed"))
        self._writer.close()
        try:
            await self._writer.wait_closed()
        except (BrokenPipeError, ConnectionError):
            pass

    async def _send(self, message: JsonObject) -> None:
        payload = (json.dumps(message, ensure_ascii=False) + "\n").encode()
        async with self._write_lock:
            self._writer.write(payload)
            await self._writer.drain()

    async def _read_loop(self) -> None:
        try:
            while line := await self._reader.readline():
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    logger.warning("忽略无法解析的 App Server 输出")
                    continue
                await self._handle_message(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("App Server JSON-RPC 读取失败")
            self._fail_pending(exc)
        else:
            self._fail_pending(ConnectionError("Codex App Server closed stdout"))

    async def _handle_message(self, message: JsonObject) -> None:
        request_id = message.get("id")
        method = message.get("method")

        if request_id is not None and method is None:
            future = self._pending.get(request_id)
            if future is None or future.done():
                return
            if "error" in message:
                error = message["error"]
                future.set_exception(
                    JsonRpcError(
                        int(error.get("code", -32000)),
                        str(error.get("message", "Unknown error")),
                        error.get("data"),
                    )
                )
            else:
                future.set_result(message.get("result"))
            return

        if request_id is not None and method is not None:
            task = asyncio.create_task(
                self._handle_server_request(request_id, str(method), message.get("params") or {})
            )
            self._server_request_tasks.add(task)
            task.add_done_callback(self._server_request_tasks.discard)
            return

        if method is None:
            return
        params = message.get("params") or {}
        for handler in tuple(self._handlers):
            try:
                result = handler(str(method), params)
                if inspect.isawaitable(result):
                    await result
            except Exception:
                logger.exception("处理 App Server 事件失败：%s", method)

    async def _handle_server_request(
        self, request_id: int | str, method: str, params: JsonObject
    ) -> None:
        if self._server_request_handler is None:
            await self._send(
                {
                    "id": request_id,
                    "error": {
                        "code": -32601,
                        "message": f"Unsupported server request: {method}",
                    },
                }
            )
            return
        try:
            result = self._server_request_handler(method, params)
            if inspect.isawaitable(result):
                result = await result
            await self._send({"id": request_id, "result": result})
        except asyncio.CancelledError:
            raise
        except JsonRpcError as exc:
            await self._send(
                {
                    "id": request_id,
                    "error": {"code": exc.code, "message": exc.message, "data": exc.data},
                }
            )
        except Exception:
            logger.exception("处理 App Server 请求失败：%s", method)
            await self._send(
                {
                    "id": request_id,
                    "error": {"code": -32603, "message": "Internal client error"},
                }
            )

    def _fail_pending(self, exc: BaseException) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(exc)
