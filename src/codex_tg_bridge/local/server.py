from __future__ import annotations

import asyncio
import json
import logging
import secrets
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from codex_tg_bridge.application import ApprovalRequest, ChatBridge, EventSink
from codex_tg_bridge.config import Settings
from codex_tg_bridge.telegram.commands import (
    format_goal,
    format_mcp_servers,
    format_models,
    format_permissions,
    format_plugins,
    format_sessions,
    format_skills,
    format_usage,
    parse_review_target,
)


logger = logging.getLogger(__name__)
LOCAL_LINE_LIMIT = 4 * 1024 * 1024


@dataclass(eq=False, slots=True)
class _Client:
    writer: asyncio.StreamWriter
    chat_id: int
    interactive: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, payload: dict[str, Any]) -> None:
        data = (json.dumps(payload, ensure_ascii=False) + "\n").encode()
        async with self.lock:
            self.writer.write(data)
            await self.writer.drain()


@dataclass(slots=True)
class _PendingApproval:
    chat_id: int
    request: ApprovalRequest
    future: asyncio.Future[bool]


class LocalControlServer(EventSink):
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._path = settings.local_socket_path
        self._bridge: ChatBridge | None = None
        self._server: asyncio.AbstractServer | None = None
        self._clients: set[_Client] = set()
        self._approvals: dict[str, _PendingApproval] = {}
        self._stream_items: set[tuple[int, str, str]] = set()

    def bind_bridge(self, bridge: ChatBridge) -> None:
        self._bridge = bridge

    def has_clients(self, chat_id: int) -> bool:
        return any(
            client.chat_id == chat_id and client.interactive
            for client in self._clients
        )

    async def start(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        if self._path.exists():
            mode = self._path.stat().st_mode
            if not stat.S_ISSOCK(mode):
                raise RuntimeError(f"本地 Socket 路径已被普通文件占用：{self._path}")
            try:
                _, writer = await asyncio.open_unix_connection(str(self._path))
            except (ConnectionRefusedError, FileNotFoundError):
                self._path.unlink()
            else:
                writer.close()
                await writer.wait_closed()
                raise RuntimeError(f"已有 Bridge 正在使用本地 Socket：{self._path}")
        self._server = await asyncio.start_unix_server(
            self._handle_client, path=str(self._path), limit=LOCAL_LINE_LIMIT
        )
        self._path.chmod(0o600)
        logger.info("本地 CLI Socket 已启动：%s", self._path)

    async def stop(self) -> None:
        for pending in self._approvals.values():
            if not pending.future.done():
                pending.future.set_result(False)
        self._approvals.clear()
        for client in tuple(self._clients):
            client.writer.close()
            await client.writer.wait_closed()
        self._clients.clear()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        if self._path.exists() and stat.S_ISSOCK(self._path.stat().st_mode):
            self._path.unlink()

    async def on_delta(
        self, chat_id: int, turn_id: str, item_id: str, delta: str
    ) -> None:
        key = (chat_id, turn_id, item_id)
        new_item = key not in self._stream_items
        self._stream_items.add(key)
        await self._broadcast(
            chat_id,
            {
                "type": "delta",
                "turn_id": turn_id,
                "item_id": item_id,
                "new_item": new_item,
                "text": delta,
            },
        )

    async def on_input(self, chat_id: int, text: str, source: str) -> None:
        if source == "telegram":
            await self._broadcast(
                chat_id, {"type": "input", "source": source, "text": text}
            )

    async def on_completed(self, chat_id: int, turn_id: str, status: str) -> None:
        self._stream_items = {
            key
            for key in self._stream_items
            if not (key[0] == chat_id and key[1] == turn_id)
        }
        await self._broadcast(
            chat_id,
            {"type": "completed", "turn_id": turn_id, "status": status},
        )

    async def on_error(self, chat_id: int, message: str) -> None:
        await self._broadcast(chat_id, {"type": "error", "message": message})

    async def request_approval(
        self, chat_id: int, request: ApprovalRequest
    ) -> bool:
        token = secrets.token_urlsafe(10)
        future = asyncio.get_running_loop().create_future()
        self._approvals[token] = _PendingApproval(chat_id, request, future)
        try:
            await self._broadcast_approval(token, self._approvals[token])
            return await asyncio.wait_for(
                asyncio.shield(future),
                timeout=self._settings.approval_timeout_seconds,
            )
        except asyncio.TimeoutError:
            await self._broadcast(
                chat_id,
                {"type": "approval_result", "token": token, "outcome": "超时，已拒绝"},
            )
            return False
        except asyncio.CancelledError:
            await self._broadcast(
                chat_id,
                {"type": "approval_result", "token": token, "outcome": "已在其他界面处理"},
            )
            raise
        finally:
            self._approvals.pop(token, None)

    async def _resolve_approval(
        self, chat_id: int, token: str, approved: bool
    ) -> bool:
        pending = self._approvals.get(token)
        if pending is None or pending.chat_id != chat_id or pending.future.done():
            return False
        pending.future.set_result(approved)
        await self._broadcast(
            chat_id,
            {
                "type": "approval_result",
                "token": token,
                "outcome": "已批准一次" if approved else "已拒绝",
            },
        )
        return True

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        client = _Client(writer, self._settings.local_cli_chat_id)
        self._clients.add(client)
        try:
            await client.send(
                {
                    "type": "ready",
                    "chat_id": client.chat_id,
                    "socket": str(self._path),
                }
            )
            while line := await reader.readline():
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    await client.send({"type": "error", "message": "无法解析本地 CLI 请求"})
                    continue
                await self._handle_payload(client, payload)
        except (ConnectionError, BrokenPipeError):
            pass
        finally:
            self._clients.discard(client)
            writer.close()
            await writer.wait_closed()

    async def _handle_payload(self, client: _Client, payload: Any) -> None:
        if not isinstance(payload, dict):
            await client.send({"type": "error", "message": "不支持的本地 CLI 请求"})
            return
        payload_type = payload.get("type")
        if payload_type == "hello":
            client.interactive = payload.get("client") == "cli"
            if client.interactive:
                for token, pending in tuple(self._approvals.items()):
                    if pending.chat_id == client.chat_id:
                        await self._send_approval(client, token, pending.request)
            return
        if payload_type != "input" or not client.interactive:
            await client.send({"type": "error", "message": "不支持的本地 CLI 请求"})
            return
        text = str(payload.get("text", "")).strip()
        if not text:
            return
        try:
            if text.startswith("/"):
                await self._handle_command(client, text)
            else:
                submission = await self._require_bridge().submit(
                    client.chat_id, text, source="cli"
                )
                message = "已追加到当前 Codex 任务" if submission.steered else "已提交 Codex 任务"
                await client.send({"type": "output", "message": message})
        except Exception as exc:
            logger.exception("处理本地 CLI 输入失败")
            await client.send({"type": "error", "message": str(exc)})

    async def _handle_command(self, client: _Client, text: str) -> None:
        command, *rest = text.split()
        name = command[1:].lower()
        bridge = self._require_bridge()
        chat_id = client.chat_id
        if name in {"approve", "decline"}:
            if not rest:
                raise ValueError(f"用法：/{name} <审批ID>")
            resolved = await self._resolve_approval(chat_id, rest[0], name == "approve")
            await client.send(
                {"type": "output", "message": "审批已处理" if resolved else "审批已失效"}
            )
            return
        if name == "help":
            await client.send({"type": "output", "message": _HELP_TEXT})
            return
        if name == "status":
            status = bridge.status(chat_id)
            message = (
                f"Thread: {status.thread_id or '尚未创建'}\n"
                f"Turn: {status.turn_id or '空闲'}\n"
                f"模型: {status.model}\n沙箱: {status.sandbox}\n目录: {status.workdir}"
            )
        elif name == "new":
            await bridge.new_session(chat_id)
            message = "已退出当前会话；旧会话仍可通过 /sessions 恢复"
        elif name == "sessions":
            message = format_sessions(
                bridge.list_sessions(chat_id), bridge.status(chat_id).thread_id
            )
        elif name == "switch":
            thread_id = await bridge.switch_session(chat_id, " ".join(rest))
            message = f"已切换到 Codex Thread：{thread_id}"
        elif name == "last":
            thread_id = await bridge.switch_last_session(chat_id)
            message = f"已切换到上一 Codex Thread：{thread_id}"
        elif name in {"session-name", "session_name"}:
            label = " ".join(rest)
            thread_id = await bridge.rename_session(chat_id, label)
            message = f"已将当前会话命名为“{label.strip()}”：{thread_id}"
        elif name == "stop":
            stopped = await bridge.stop_turn(chat_id)
            message = "已请求停止当前任务" if stopped else "当前没有运行中的任务"
        elif name == "model":
            if rest:
                await bridge.set_model(chat_id, rest[0])
                message = f"模型已切换为：{rest[0]}"
            else:
                message = format_models(await bridge.list_models(), bridge.status(chat_id).model)
        elif name == "permissions":
            if rest:
                await bridge.set_sandbox(chat_id, rest[0])
                message = f"沙箱已切换为：{rest[0]}"
            else:
                current, profiles = await bridge.permissions(chat_id)
                message = format_permissions(current, profiles)
        elif name == "compact":
            await bridge.compact(chat_id)
            message = "已启动上下文压缩"
        elif name == "fork":
            message = f"已切换到新 Thread：{await bridge.fork(chat_id)}"
        elif name == "review":
            await bridge.review(chat_id, parse_review_target(rest))
            message = "代码审查已启动"
        elif name == "skills":
            message = format_skills(await bridge.list_skills())
        elif name == "mcp":
            message = format_mcp_servers(await bridge.list_mcp_servers(chat_id))
        elif name == "plugins":
            message = format_plugins(await bridge.list_plugins())
        elif name == "usage":
            message = format_usage(await bridge.account_usage())
        elif name == "goal":
            if not rest:
                message = format_goal(await bridge.get_goal(chat_id))
            elif rest[0].lower() == "clear":
                await bridge.clear_goal(chat_id)
                message = "Goal 已清除"
            else:
                objective = " ".join(rest[1:] if rest[0].lower() == "set" else rest)
                message = format_goal(await bridge.set_goal(chat_id, objective))
        else:
            raise ValueError(f"不支持的命令：/{name}；使用 /help 查看命令")
        await client.send({"type": "output", "message": message})

    async def _broadcast(self, chat_id: int, payload: dict[str, Any]) -> None:
        clients = [
            client
            for client in self._clients
            if client.chat_id == chat_id and client.interactive
        ]
        if clients:
            await asyncio.gather(
                *(client.send(payload) for client in clients), return_exceptions=True
            )

    async def _broadcast_approval(
        self, token: str, pending: _PendingApproval
    ) -> None:
        clients = [
            client
            for client in self._clients
            if client.chat_id == pending.chat_id and client.interactive
        ]
        await asyncio.gather(
            *(self._send_approval(client, token, pending.request) for client in clients),
            return_exceptions=True,
        )

    @staticmethod
    async def _send_approval(
        client: _Client, token: str, request: ApprovalRequest
    ) -> None:
        await client.send(
            {
                "type": "approval",
                "token": token,
                "title": request.title,
                "details": request.details,
                "reason": request.reason,
            }
        )

    def _require_bridge(self) -> ChatBridge:
        if self._bridge is None:
            raise RuntimeError("ChatBridge 尚未绑定")
        return self._bridge


_HELP_TEXT = """本地 Codex 命令
/new /status /stop
/sessions /switch <序号|名称|Thread ID> /last
/session-name <名称>
/model [模型ID]
/permissions [read-only|workspace-write]
/compact /fork /review
/skills /mcp /plugins /usage
/goal [set <目标>|clear]
/approve <审批ID> /decline <审批ID>
/quit

普通文本会提交到与 Telegram 共享的 Codex Thread。"""
