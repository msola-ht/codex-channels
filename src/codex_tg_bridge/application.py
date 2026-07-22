from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Protocol

from codex_tg_bridge.codex.client import CodexClient
from codex_tg_bridge.codex.jsonrpc import JsonObject, JsonRpcError
from codex_tg_bridge.config import Settings
from codex_tg_bridge.persistence.sqlite import SessionRecord, SessionStore


logger = logging.getLogger(__name__)


class EventSink(Protocol):
    async def on_input(self, chat_id: int, text: str, source: str) -> None: ...

    async def on_delta(
        self, chat_id: int, turn_id: str, item_id: str, delta: str
    ) -> None: ...

    async def on_completed(self, chat_id: int, turn_id: str, status: str) -> None: ...

    async def on_error(self, chat_id: int, message: str) -> None: ...

    async def request_approval(
        self, chat_id: int, request: "ApprovalRequest"
    ) -> bool: ...


@dataclass(frozen=True, slots=True)
class ApprovalRequest:
    kind: str
    title: str
    details: str
    reason: str | None


@dataclass(frozen=True, slots=True)
class Submission:
    thread_id: str
    turn_id: str
    steered: bool


@dataclass(frozen=True, slots=True)
class BridgeStatus:
    thread_id: str | None
    turn_id: str | None
    workdir: str
    model: str
    sandbox: str


class ChatBridge:
    def __init__(
        self,
        settings: Settings,
        codex: CodexClient,
        store: SessionStore,
        sink: EventSink,
    ) -> None:
        self._settings = settings
        self._codex = codex
        self._store = store
        self._sink = sink
        self._loaded_threads: set[str] = set()
        self._active_turns: dict[int, tuple[str, str]] = {}
        self._locks: dict[int, asyncio.Lock] = {}
        self._codex.add_event_handler(self._handle_codex_event)
        self._codex.set_server_request_handler(self._handle_codex_request)

    async def submit(
        self, chat_id: int, text: str, *, source: str = "telegram"
    ) -> Submission:
        text = text.strip()
        if not text:
            raise ValueError("消息不能为空")
        async with self._lock_for(chat_id):
            active = self._active_turns.get(chat_id)
            if active is not None:
                thread_id, turn_id = active
                await self._codex.steer_turn(thread_id, turn_id, text)
                self._store.touch(chat_id, thread_id)
                await self._sink.on_input(chat_id, text, source)
                return Submission(thread_id, turn_id, True)

            thread_id = await self._ensure_thread(chat_id)
            model, _ = self._preferences(chat_id)
            turn_id = await self._codex.start_turn(thread_id, text, model=model)
            self._active_turns[chat_id] = (thread_id, turn_id)
            self._store.touch(chat_id, thread_id)
            await self._sink.on_input(chat_id, text, source)
            return Submission(thread_id, turn_id, False)

    async def new_session(self, chat_id: int) -> None:
        async with self._lock_for(chat_id):
            await self._interrupt_if_active(chat_id)
            thread_id = self._store.get_thread_id(chat_id)
            self._store.delete(chat_id)
            if thread_id is not None:
                self._loaded_threads.discard(thread_id)

    async def stop_turn(self, chat_id: int) -> bool:
        async with self._lock_for(chat_id):
            return await self._interrupt_if_active(chat_id)

    def status(self, chat_id: int) -> BridgeStatus:
        active = self._active_turns.get(chat_id)
        model, sandbox = self._preferences(chat_id)
        return BridgeStatus(
            thread_id=self._store.get_thread_id(chat_id),
            turn_id=None if active is None else active[1],
            workdir=str(self._settings.codex_workdir),
            model=model or "Codex 默认模型",
            sandbox=sandbox,
        )

    def list_sessions(self, chat_id: int) -> list[SessionRecord]:
        return self._store.list_sessions(chat_id)

    async def switch_session(self, chat_id: int, selector: str) -> str:
        selector = selector.strip()
        if not selector:
            raise ValueError("用法：/switch <序号、名称或Thread ID>")
        async with self._lock_for(chat_id):
            self._require_idle(chat_id)
            sessions = self._store.list_sessions(chat_id)
            target = _resolve_session(sessions, selector)
            await self._switch_thread_locked(chat_id, target.thread_id)
            return target.thread_id

    async def switch_last_session(self, chat_id: int) -> str:
        async with self._lock_for(chat_id):
            self._require_idle(chat_id)
            current = self._store.get_thread_id(chat_id)
            target = next(
                (
                    item
                    for item in self._store.list_sessions(chat_id)
                    if item.thread_id != current
                ),
                None,
            )
            if target is None:
                raise RuntimeError("没有可切换的上一会话")
            await self._switch_thread_locked(chat_id, target.thread_id)
            return target.thread_id

    async def rename_session(self, chat_id: int, label: str) -> str:
        label = label.strip()
        if not label:
            raise ValueError("用法：/session_name <名称>")
        if len(label) > 64:
            raise ValueError("会话名称不能超过 64 个字符")
        async with self._lock_for(chat_id):
            thread_id = self._store.get_thread_id(chat_id)
            if thread_id is None:
                raise RuntimeError("当前还没有 Codex 会话")
            self._store.rename_session(chat_id, thread_id, label)
            return thread_id

    async def list_models(self) -> list[JsonObject]:
        return await self._codex.list_models()

    async def set_model(self, chat_id: int, model: str) -> None:
        model = model.strip()
        if not model:
            raise ValueError("模型名称不能为空")
        models = await self._codex.list_models()
        available = {
            str(item.get("model") or item.get("id"))
            for item in models
            if item.get("model") or item.get("id")
        }
        if model not in available:
            raise ValueError(f"当前账号不可用或未列出的模型：{model}")
        async with self._lock_for(chat_id):
            if chat_id in self._active_turns:
                raise RuntimeError("当前任务运行中，请先 /stop")
            self._store.set_model(chat_id, model)
            await self._apply_preferences_to_loaded_thread(chat_id)

    async def compact(self, chat_id: int) -> None:
        async with self._lock_for(chat_id):
            self._require_idle(chat_id)
            thread_id = await self._ensure_thread(chat_id)
            await self._codex.compact_thread(thread_id)

    async def fork(self, chat_id: int) -> str:
        async with self._lock_for(chat_id):
            self._require_idle(chat_id)
            thread_id = await self._ensure_thread(chat_id)
            model, sandbox = self._preferences(chat_id)
            forked_id = await self._codex.fork_thread(
                thread_id,
                model=model,
                sandbox=sandbox,
            )
            self._store.save(chat_id, forked_id)
            self._loaded_threads.add(forked_id)
            return forked_id

    async def review(self, chat_id: int, target: JsonObject) -> Submission:
        async with self._lock_for(chat_id):
            self._require_idle(chat_id)
            thread_id = await self._ensure_thread(chat_id)
            review_thread_id, turn_id = await self._codex.start_review(thread_id, target)
            if review_thread_id != thread_id:
                self._store.save(chat_id, review_thread_id)
                self._loaded_threads.add(review_thread_id)
            self._active_turns[chat_id] = (review_thread_id, turn_id)
            return Submission(review_thread_id, turn_id, False)

    async def list_skills(self) -> list[JsonObject]:
        return await self._codex.list_skills()

    async def list_mcp_servers(self, chat_id: int) -> list[JsonObject]:
        async with self._lock_for(chat_id):
            thread_id = self._store.get_thread_id(chat_id)
            if thread_id is not None:
                thread_id = await self._ensure_thread(chat_id)
            return await self._codex.list_mcp_servers(thread_id)

    async def list_plugins(self) -> list[JsonObject]:
        return await self._codex.list_plugins()

    async def account_usage(self) -> JsonObject:
        return await self._codex.account_usage()

    async def permissions(self, chat_id: int) -> tuple[str, list[JsonObject]]:
        _, sandbox = self._preferences(chat_id)
        return sandbox, await self._codex.list_permission_profiles()

    async def set_sandbox(self, chat_id: int, sandbox: str) -> None:
        if sandbox not in {"read-only", "workspace-write"}:
            raise ValueError("只支持 read-only 或 workspace-write")
        async with self._lock_for(chat_id):
            self._require_idle(chat_id)
            self._store.set_sandbox(chat_id, sandbox)
            await self._apply_preferences_to_loaded_thread(chat_id)

    async def get_goal(self, chat_id: int) -> JsonObject | None:
        async with self._lock_for(chat_id):
            thread_id = await self._ensure_thread(chat_id)
            return await self._codex.get_goal(thread_id)

    async def set_goal(self, chat_id: int, objective: str) -> JsonObject:
        objective = objective.strip()
        if not objective:
            raise ValueError("目标不能为空")
        async with self._lock_for(chat_id):
            thread_id = await self._ensure_thread(chat_id)
            return await self._codex.set_goal(thread_id, objective)

    async def clear_goal(self, chat_id: int) -> None:
        async with self._lock_for(chat_id):
            thread_id = await self._ensure_thread(chat_id)
            await self._codex.clear_goal(thread_id)

    async def _ensure_thread(self, chat_id: int) -> str:
        model, sandbox = self._preferences(chat_id)
        thread_id = self._store.get_thread_id(chat_id)
        if thread_id is None:
            thread_id = await self._codex.start_thread(model=model, sandbox=sandbox)
            self._store.save(chat_id, thread_id)
            self._loaded_threads.add(thread_id)
            return thread_id
        if thread_id not in self._loaded_threads:
            try:
                await self._codex.resume_thread(
                    thread_id,
                    model=model,
                    sandbox=sandbox,
                )
            except JsonRpcError:
                logger.warning("无法恢复 Thread，将为 chat_id=%s 创建新 Thread", chat_id)
                thread_id = await self._codex.start_thread(model=model, sandbox=sandbox)
                self._store.save(chat_id, thread_id)
            self._loaded_threads.add(thread_id)
        return thread_id

    async def _apply_preferences_to_loaded_thread(self, chat_id: int) -> None:
        thread_id = self._store.get_thread_id(chat_id)
        if thread_id is None or thread_id not in self._loaded_threads:
            return
        model, sandbox = self._preferences(chat_id)
        await self._codex.resume_thread(thread_id, model=model, sandbox=sandbox)

    async def _switch_thread_locked(self, chat_id: int, thread_id: str) -> None:
        current = self._store.get_thread_id(chat_id)
        if current == thread_id:
            self._store.touch(chat_id, thread_id)
            return
        model, sandbox = self._preferences(chat_id)
        if thread_id not in self._loaded_threads:
            await self._codex.resume_thread(thread_id, model=model, sandbox=sandbox)
            self._loaded_threads.add(thread_id)
        self._store.save(chat_id, thread_id)

    def _preferences(self, chat_id: int) -> tuple[str | None, str]:
        model, sandbox = self._store.get_preferences(chat_id)
        return model or self._settings.codex_model, sandbox or self._settings.codex_sandbox

    def _require_idle(self, chat_id: int) -> None:
        if chat_id in self._active_turns:
            raise RuntimeError("当前任务运行中，请先 /stop")

    async def _interrupt_if_active(self, chat_id: int) -> bool:
        active = self._active_turns.get(chat_id)
        if active is None:
            return False
        thread_id, turn_id = active
        await self._codex.interrupt_turn(thread_id, turn_id)
        self._active_turns.pop(chat_id, None)
        return True

    async def _handle_codex_event(self, method: str, params: JsonObject) -> None:
        if method == "item/agentMessage/delta":
            thread_id = str(params.get("threadId", ""))
            turn_id = str(params.get("turnId", ""))
            item_id = str(params.get("itemId") or turn_id)
            delta = str(params.get("delta", ""))
            chat_id = self._store.get_chat_id(thread_id)
            if chat_id is not None and delta:
                await self._sink.on_delta(chat_id, turn_id, item_id, delta)
            return

        if method == "turn/completed":
            thread_id = str(params.get("threadId", ""))
            turn = params.get("turn") or {}
            turn_id = str(turn.get("id", ""))
            status = _status_text(turn.get("status"))
            chat_id = self._store.get_chat_id(thread_id)
            if chat_id is not None:
                active = self._active_turns.get(chat_id)
                if active is not None and active[1] == turn_id:
                    self._active_turns.pop(chat_id, None)
                await self._sink.on_completed(chat_id, turn_id, status)
            return

        if method == "error":
            thread_id = str(params.get("threadId", ""))
            chat_id = self._store.get_chat_id(thread_id)
            if chat_id is not None:
                await self._sink.on_error(chat_id, str(params.get("message", "Codex 发生错误")))

    async def _handle_codex_request(
        self, method: str, params: JsonObject
    ) -> JsonObject:
        supported = {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
        }
        if method not in supported:
            raise JsonRpcError(-32601, f"不支持的交互请求：{method}")

        thread_id = str(params.get("threadId", ""))
        chat_id = self._store.get_chat_id(thread_id)
        if chat_id is None:
            logger.warning("拒绝无法映射到 Telegram 会话的审批请求：%s", method)
            return _approval_response(method, params, approved=False)

        request = _approval_request(method, params)
        approved = await self._sink.request_approval(chat_id, request)
        return _approval_response(method, params, approved=approved)

    def _lock_for(self, chat_id: int) -> asyncio.Lock:
        return self._locks.setdefault(chat_id, asyncio.Lock())


def _status_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and value:
        return str(next(iter(value)))
    return "completed"


def _resolve_session(
    sessions: list[SessionRecord], selector: str
) -> SessionRecord:
    if selector.isdigit():
        index = int(selector)
        if 1 <= index <= len(sessions):
            return sessions[index - 1]
    exact = [
        item
        for item in sessions
        if item.thread_id == selector or item.label == selector
    ]
    if len(exact) == 1:
        return exact[0]
    prefix = [item for item in sessions if item.thread_id.startswith(selector)]
    if len(prefix) == 1:
        return prefix[0]
    if len(exact) > 1 or len(prefix) > 1:
        raise ValueError("匹配到多个会话，请使用更完整的名称或 Thread ID")
    raise ValueError("找不到该会话；使用 /sessions 查看历史会话")


def _approval_request(method: str, params: JsonObject) -> ApprovalRequest:
    reason = params.get("reason")
    reason_text = str(reason) if reason else None
    if method == "item/commandExecution/requestApproval":
        command = str(params.get("command") or "（未提供命令文本）")
        cwd = str(params.get("cwd") or "（未提供工作目录）")
        network = params.get("networkApprovalContext")
        details = f"命令：{command}\n目录：{cwd}"
        if network:
            details += "\n网络：" + json.dumps(network, ensure_ascii=False)
        return ApprovalRequest("command", "Codex 请求执行受限命令", details, reason_text)
    if method == "item/fileChange/requestApproval":
        root = str(params.get("grantRoot") or "当前请求涉及的文件")
        return ApprovalRequest(
            "file", "Codex 请求额外文件写入权限", f"写入范围：{root}", reason_text
        )
    permissions = params.get("permissions") or {}
    cwd = str(params.get("cwd") or "（未提供工作目录）")
    details = "目录：" + cwd + "\n权限：" + json.dumps(
        permissions, ensure_ascii=False, indent=2
    )
    return ApprovalRequest("permissions", "Codex 请求临时扩展权限", details, reason_text)


def _approval_response(
    method: str, params: JsonObject, *, approved: bool
) -> JsonObject:
    if method == "item/permissions/requestApproval":
        permissions = params.get("permissions") if approved else {}
        return {
            "permissions": permissions if isinstance(permissions, dict) else {},
            "scope": "turn",
        }
    return {"decision": "accept" if approved else "decline"}
