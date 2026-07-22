from __future__ import annotations

import asyncio
import logging
import secrets
import time
from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import Any

from telegram import Bot, BotCommand, InlineKeyboardButton, InlineKeyboardMarkup, Message, Update
from telegram.error import BadRequest, TelegramError
from telegram.ext import (
    Application,
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from codex_tg_bridge.application import ApprovalRequest, ChatBridge, EventSink
from codex_tg_bridge.config import Settings
from codex_tg_bridge.security.access import AccessController
from codex_tg_bridge.telegram.formatter import split_text, stream_preview
from codex_tg_bridge.telegram.commands import (
    TERMINAL_ONLY_COMMANDS,
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


@dataclass(slots=True)
class _StreamState:
    text: str = ""
    message: Message | None = None
    last_edit: float = 0.0
    dirty: bool = False
    flush_task: asyncio.Task[None] | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


@dataclass(slots=True)
class _PendingApproval:
    chat_id: int
    text: str
    message: Message
    future: asyncio.Future[bool]


class TelegramEventSink(EventSink):
    APPROVAL_TIMEOUT_SECONDS = 300
    STREAM_EDIT_INTERVAL_SECONDS = 1.0

    def __init__(self, bot: Bot) -> None:
        self._bot = bot
        self._streams: dict[tuple[int, str, str], _StreamState] = {}
        self._stream_send_locks: dict[tuple[int, str], asyncio.Lock] = {}
        self._approvals: dict[str, _PendingApproval] = {}

    async def on_input(self, chat_id: int, text: str, source: str) -> None:
        labels = {
            "cli": "本地 CLI 指令：",
        }
        if source in labels:
            for chunk in split_text(labels[source] + "\n" + text):
                await self._bot.send_message(chat_id, chunk)

    async def on_delta(
        self, chat_id: int, turn_id: str, item_id: str, delta: str
    ) -> None:
        key = (chat_id, turn_id, item_id)
        state = self._streams.setdefault(key, _StreamState())
        async with state.lock:
            state.text += delta
            state.dirty = True
            if state.flush_task is None or state.flush_task.done():
                state.flush_task = asyncio.create_task(
                    self._flush_stream(
                        chat_id,
                        state,
                        self._stream_send_locks.setdefault(
                            (chat_id, turn_id), asyncio.Lock()
                        ),
                    )
                )

    async def on_completed(self, chat_id: int, turn_id: str, status: str) -> None:
        keys = [
            key
            for key in self._streams
            if key[0] == chat_id and key[1] == turn_id
        ]
        if not keys:
            await self._bot.send_message(chat_id, f"Codex 任务结束：{status}")
            return
        states = [self._streams.pop(key) for key in keys]
        flush_tasks = [
            state.flush_task
            for state in states
            if state.flush_task is not None
        ]
        if flush_tasks:
            await asyncio.gather(*flush_tasks, return_exceptions=True)
        for state in states:
            await self._complete_stream(chat_id, state)
        self._stream_send_locks.pop((chat_id, turn_id), None)
        if status not in {"completed", "success"}:
            await self._bot.send_message(chat_id, f"任务状态：{status}")

    async def _complete_stream(self, chat_id: int, state: _StreamState) -> None:
        async with state.lock:
            chunks = split_text(state.text)
            if not chunks:
                return
            first, *rest = chunks
            if state.message is None:
                state.message = await self._bot.send_message(chat_id, first)
            else:
                await self._safe_edit(state.message, first)
            for chunk in rest:
                await self._bot.send_message(chat_id, chunk)

    async def on_error(self, chat_id: int, message: str) -> None:
        await self._bot.send_message(chat_id, f"Codex 错误：{message}")

    async def request_approval(
        self, chat_id: int, request: ApprovalRequest
    ) -> bool:
        token = secrets.token_urlsafe(12)
        text = _format_approval(request)
        keyboard = InlineKeyboardMarkup(
            [[
                InlineKeyboardButton("批准一次", callback_data=f"approval:accept:{token}"),
                InlineKeyboardButton("拒绝", callback_data=f"approval:decline:{token}"),
            ]]
        )
        message = await self._bot.send_message(chat_id, text, reply_markup=keyboard)
        future = asyncio.get_running_loop().create_future()
        self._approvals[token] = _PendingApproval(chat_id, text, message, future)
        try:
            return await asyncio.wait_for(
                asyncio.shield(future), timeout=self.APPROVAL_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            await self._finish_approval(token, False, "审批超时，已自动拒绝")
            return False
        except asyncio.CancelledError:
            await asyncio.shield(
                self._finish_approval(token, False, "已在其他界面处理")
            )
            raise
        finally:
            self._approvals.pop(token, None)

    async def resolve_approval(
        self, token: str, *, chat_id: int, approved: bool
    ) -> bool:
        pending = self._approvals.get(token)
        if pending is None or pending.chat_id != chat_id or pending.future.done():
            return False
        await self._finish_approval(
            token, approved, "已批准一次" if approved else "已拒绝"
        )
        return True

    async def close(self) -> None:
        flush_tasks = [
            state.flush_task
            for state in self._streams.values()
            if state.flush_task is not None and not state.flush_task.done()
        ]
        for task in flush_tasks:
            task.cancel()
        if flush_tasks:
            await asyncio.gather(*flush_tasks, return_exceptions=True)
        self._streams.clear()
        self._stream_send_locks.clear()
        for token in tuple(self._approvals):
            await self._finish_approval(token, False, "服务正在停止，已自动拒绝")

    async def _flush_stream(
        self, chat_id: int, state: _StreamState, send_lock: asyncio.Lock
    ) -> None:
        current_task = asyncio.current_task()
        try:
            while True:
                async with state.lock:
                    if not state.dirty:
                        return
                    delay = max(
                        0.0,
                        self.STREAM_EDIT_INTERVAL_SECONDS
                        - (time.monotonic() - state.last_edit),
                    )
                if delay:
                    await asyncio.sleep(delay)
                async with state.lock:
                    if not state.dirty:
                        continue
                    preview = stream_preview(state.text)
                    message = state.message
                    state.dirty = False
                sent_message: Message | None = None
                try:
                    async with send_lock:
                        if message is None:
                            sent_message = await self._bot.send_message(chat_id, preview)
                        else:
                            await self._safe_edit(message, preview)
                except TelegramError:
                    logger.warning("Telegram 流式消息刷新失败，将继续缓冲", exc_info=True)
                finally:
                    async with state.lock:
                        if sent_message is not None and state.message is None:
                            state.message = sent_message
                        state.last_edit = time.monotonic()
        finally:
            async with state.lock:
                if state.flush_task is current_task:
                    state.flush_task = None

    @staticmethod
    async def _safe_edit(message: Message, text: str) -> None:
        try:
            await message.edit_text(text)
        except BadRequest as exc:
            if "message is not modified" not in str(exc).lower():
                raise

    async def _finish_approval(
        self, token: str, approved: bool, outcome: str
    ) -> None:
        pending = self._approvals.get(token)
        if pending is None:
            return
        if not pending.future.done():
            pending.future.set_result(approved)
        try:
            await pending.message.edit_text(f"{pending.text}\n\n处理结果：{outcome}")
        except (BadRequest, TelegramError):
            logger.warning("无法更新 Telegram 审批消息", exc_info=True)


class TelegramService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._access = AccessController(settings.telegram_allowed_user_ids)
        self._application: Application = ApplicationBuilder().token(
            settings.telegram_bot_token
        ).build()
        self.sink = TelegramEventSink(self._application.bot)
        self.sink.APPROVAL_TIMEOUT_SECONDS = settings.approval_timeout_seconds
        self._bridge: ChatBridge | None = None
        self._initialized = False
        self._started = False
        self._register_handlers()

    def bind_bridge(self, bridge: ChatBridge) -> None:
        self._bridge = bridge

    async def start(self) -> None:
        await self._application.initialize()
        self._initialized = True
        await self._application.start()
        self._started = True
        await self._application.bot.set_my_commands(
            [
                BotCommand("start", "使用说明"),
                BotCommand("new", "新建 Codex Thread"),
                BotCommand("sessions", "列出历史会话"),
                BotCommand("switch", "切换历史会话"),
                BotCommand("last", "切换到上一会话"),
                BotCommand("session_name", "命名当前会话"),
                BotCommand("status", "查看会话状态"),
                BotCommand("stop", "停止当前 Turn"),
                BotCommand("model", "查看或切换模型"),
                BotCommand("compact", "压缩当前会话上下文"),
                BotCommand("fork", "分叉当前会话"),
                BotCommand("review", "审查代码改动"),
                BotCommand("skills", "列出 Skills"),
                BotCommand("mcp", "列出 MCP Servers"),
                BotCommand("plugins", "列出 Plugins"),
                BotCommand("usage", "查看账号用量"),
                BotCommand("permissions", "查看或切换安全模式"),
                BotCommand("goal", "查看或管理 Goal"),
                BotCommand("help", "列出可用命令"),
            ]
        )
        if self._application.updater is None:
            raise RuntimeError("Telegram Updater 不可用")
        await self._application.updater.start_polling(drop_pending_updates=False)

    async def stop(self) -> None:
        if self._application.updater is not None and self._application.updater.running:
            await self._application.updater.stop()
        await self.sink.close()
        if self._started and self._application.running:
            await self._application.stop()
        self._started = False
        if self._initialized:
            await self._application.shutdown()
            self._initialized = False

    def _register_handlers(self) -> None:
        self._application.add_handler(
            CallbackQueryHandler(self._approval_callback, pattern=r"^approval:")
        )
        self._application.add_handler(CommandHandler("whoami", self._whoami))
        self._application.add_handler(CommandHandler("start", self._start))
        self._application.add_handler(CommandHandler("new", self._new))
        self._application.add_handler(CommandHandler("sessions", self._sessions))
        self._application.add_handler(CommandHandler("switch", self._switch))
        self._application.add_handler(CommandHandler("last", self._last))
        self._application.add_handler(CommandHandler("session_name", self._session_name))
        self._application.add_handler(CommandHandler("status", self._status))
        self._application.add_handler(CommandHandler("stop", self._stop))
        self._application.add_handler(CommandHandler("help", self._help))
        self._application.add_handler(CommandHandler("model", self._model))
        self._application.add_handler(CommandHandler("compact", self._compact))
        self._application.add_handler(CommandHandler("fork", self._fork))
        self._application.add_handler(CommandHandler("review", self._review))
        self._application.add_handler(CommandHandler("skills", self._skills))
        self._application.add_handler(CommandHandler("mcp", self._mcp))
        self._application.add_handler(CommandHandler("plugins", self._plugins))
        self._application.add_handler(CommandHandler("usage", self._usage))
        self._application.add_handler(CommandHandler("permissions", self._permissions))
        self._application.add_handler(CommandHandler("goal", self._goal))
        self._application.add_handler(
            MessageHandler(filters.TEXT & filters.Regex(r"^/"), self._unsupported_command)
        )
        self._application.add_handler(
            MessageHandler(filters.TEXT & ~filters.COMMAND, self._text)
        )
        self._application.add_error_handler(self._error)

    async def _approval_callback(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        del context
        query = update.callback_query
        if query is None:
            return
        user_id = None if update.effective_user is None else update.effective_user.id
        if not self._access.is_allowed(user_id):
            await query.answer("未授权", show_alert=True)
            return
        data = query.data or ""
        parts = data.split(":", 2)
        chat_id = None if update.effective_chat is None else update.effective_chat.id
        if len(parts) != 3 or chat_id is None:
            await query.answer("审批数据无效", show_alert=True)
            return
        approved = parts[1] == "accept"
        if parts[1] not in {"accept", "decline"}:
            await query.answer("审批操作无效", show_alert=True)
            return
        resolved = await self.sink.resolve_approval(
            parts[2], chat_id=chat_id, approved=approved
        )
        await query.answer("已处理" if resolved else "审批已失效", show_alert=not resolved)

    async def _whoami(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        if update.effective_user is not None and update.effective_message is not None:
            await update.effective_message.reply_text(
                f"你的 Telegram 用户 ID：{update.effective_user.id}"
            )

    async def _start(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is not None:
            await message.reply_text(
                "Codex 已连接。直接发送文本开始任务。\n"
                "发送 /help 查看 Telegram 支持的 Codex 命令。"
            )

    async def _help(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is not None:
            await message.reply_text(
                "Codex Telegram 命令\n"
                "/new /status /stop\n"
                "/sessions /switch <序号|名称|Thread ID> /last\n"
                "/session_name <名称>\n"
                "/model [模型ID]\n"
                "/compact /fork\n"
                "/review [branch <分支>|commit <SHA>|custom <要求>]\n"
                "/skills /mcp /plugins /usage\n"
                "/permissions [read-only|workspace-write]\n"
                "/goal [set <目标>|clear]\n"
                "/whoami\n\n"
                "普通文本会直接提交为 Codex 任务。"
            )

    async def _new(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is None:
            return
        await self._require_bridge().new_session(update.effective_chat.id)
        await message.reply_text(
            "已退出当前会话，下一条消息将创建新 Codex Thread；旧会话仍可通过 /sessions 恢复。"
        )

    async def _sessions(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is None:
            return
        bridge = self._require_bridge()
        chat_id = update.effective_chat.id
        await self._reply_chunks(
            message,
            format_sessions(bridge.list_sessions(chat_id), bridge.status(chat_id).thread_id),
        )

    async def _switch(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        message = await self._authorized_message(update)
        if message is None:
            return
        selector = " ".join(context.args).strip()
        try:
            thread_id = await self._require_bridge().switch_session(
                update.effective_chat.id, selector
            )
        except Exception as exc:
            await self._command_error(message, exc)
            return
        await message.reply_text(f"已切换到 Codex Thread：{thread_id}")

    async def _last(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is None:
            return
        try:
            thread_id = await self._require_bridge().switch_last_session(
                update.effective_chat.id
            )
        except Exception as exc:
            await self._command_error(message, exc)
            return
        await message.reply_text(f"已切换到上一 Codex Thread：{thread_id}")

    async def _session_name(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        message = await self._authorized_message(update)
        if message is None:
            return
        label = " ".join(context.args).strip()
        try:
            thread_id = await self._require_bridge().rename_session(
                update.effective_chat.id, label
            )
        except Exception as exc:
            await self._command_error(message, exc)
            return
        await message.reply_text(f"已将当前会话命名为“{label}”：{thread_id}")

    async def _status(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is None:
            return
        status = self._require_bridge().status(update.effective_chat.id)
        await message.reply_text(
            "Codex 状态\n"
            f"Thread：{status.thread_id or '尚未创建'}\n"
            f"Turn：{status.turn_id or '空闲'}\n"
            f"模型：{status.model}\n"
            f"沙箱：{status.sandbox}\n"
            f"工作目录：{status.workdir}"
        )

    async def _stop(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is None:
            return
        stopped = await self._require_bridge().stop_turn(update.effective_chat.id)
        await message.reply_text("已请求停止当前任务。" if stopped else "当前没有运行中的任务。")

    async def _model(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        message = await self._authorized_message(update)
        if message is None:
            return
        bridge = self._require_bridge()
        if context.args:
            model = context.args[0]
            if await self._run_command(
                message, bridge.set_model(update.effective_chat.id, model)
            ):
                await message.reply_text(f"模型已切换为：{model}")
            return
        models = await bridge.list_models()
        await self._reply_chunks(message, format_models(models, bridge.status(update.effective_chat.id).model))

    async def _compact(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is None:
            return
        if await self._run_command(message, self._require_bridge().compact(update.effective_chat.id)):
            await message.reply_text("已启动当前 Thread 的上下文压缩。")

    async def _fork(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is None:
            return
        try:
            thread_id = await self._require_bridge().fork(update.effective_chat.id)
        except Exception as exc:
            await self._command_error(message, exc)
            return
        await message.reply_text(f"已分叉并切换到新 Thread：{thread_id}")

    async def _review(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        message = await self._authorized_message(update)
        if message is None:
            return
        try:
            target = parse_review_target(context.args)
            await self._require_bridge().review(update.effective_chat.id, target)
        except Exception as exc:
            await self._command_error(message, exc)
            return
        await message.reply_text("代码审查已启动，结果会流式返回。")

    async def _skills(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is not None:
            try:
                result = await self._require_bridge().list_skills()
                await self._reply_chunks(message, format_skills(result))
            except Exception as exc:
                await self._command_error(message, exc)

    async def _mcp(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is not None:
            try:
                result = await self._require_bridge().list_mcp_servers(update.effective_chat.id)
                await self._reply_chunks(message, format_mcp_servers(result))
            except Exception as exc:
                await self._command_error(message, exc)

    async def _plugins(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is not None:
            try:
                result = await self._require_bridge().list_plugins()
                await self._reply_chunks(message, format_plugins(result))
            except Exception as exc:
                await self._command_error(message, exc)

    async def _usage(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is not None:
            try:
                result = await self._require_bridge().account_usage()
                await message.reply_text(format_usage(result))
            except Exception as exc:
                await self._command_error(message, exc)

    async def _permissions(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        message = await self._authorized_message(update)
        if message is None:
            return
        bridge = self._require_bridge()
        if context.args:
            sandbox = context.args[0]
            if await self._run_command(message, bridge.set_sandbox(update.effective_chat.id, sandbox)):
                await message.reply_text(f"Telegram 沙箱已切换为：{sandbox}")
            return
        try:
            current, profiles = await bridge.permissions(update.effective_chat.id)
            await self._reply_chunks(message, format_permissions(current, profiles))
        except Exception as exc:
            await self._command_error(message, exc)

    async def _goal(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        message = await self._authorized_message(update)
        if message is None:
            return
        bridge = self._require_bridge()
        try:
            if not context.args:
                goal = await bridge.get_goal(update.effective_chat.id)
                await message.reply_text(format_goal(goal))
                return
            action = context.args[0].lower()
            if action == "clear":
                await bridge.clear_goal(update.effective_chat.id)
                await message.reply_text("Goal 已清除。")
                return
            objective = " ".join(context.args[1:] if action == "set" else context.args).strip()
            goal = await bridge.set_goal(update.effective_chat.id, objective)
            await message.reply_text(format_goal(goal))
        except Exception as exc:
            await self._command_error(message, exc)

    async def _unsupported_command(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        del context
        message = await self._authorized_message(update)
        if message is None or not message.text:
            return
        command = message.text.split(maxsplit=1)[0].split("@", 1)[0].lstrip("/").lower()
        if command in TERMINAL_ONLY_COMMANDS:
            await message.reply_text(
                f"/{command} 是 Codex CLI/界面专属命令，在 Telegram 中不适用。使用 /help 查看等效命令。"
            )
        else:
            await message.reply_text(f"不支持的命令：/{command}。使用 /help 查看可用命令。")

    async def _text(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        del context
        message = await self._authorized_message(update)
        if message is None or not message.text:
            return
        try:
            submission = await self._require_bridge().submit(
                update.effective_chat.id,
                message.text,
                source="telegram",
            )
        except Exception as exc:
            logger.exception("提交 Telegram 消息失败")
            await message.reply_text(f"提交失败：{exc}")
            return
        if submission.steered:
            await message.reply_text("已追加到当前 Codex 任务。")
        else:
            await message.reply_text("已发送给 Codex，正在处理。")

    async def _authorized_message(self, update: Update) -> Message | None:
        message = update.effective_message
        user_id = None if update.effective_user is None else update.effective_user.id
        if message is None:
            return None
        if not self._access.is_allowed(user_id):
            await message.reply_text("未授权。使用 /whoami 查看你的 Telegram 用户 ID。")
            return None
        return message

    async def _error(self, update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
        del update
        if isinstance(context.error, TelegramError):
            logger.error("Telegram API 错误：%s", context.error)
        else:
            logger.exception("Telegram handler 发生异常", exc_info=context.error)

    def _require_bridge(self) -> ChatBridge:
        if self._bridge is None:
            raise RuntimeError("ChatBridge 尚未绑定")
        return self._bridge

    async def _run_command(
        self, message: Message, operation: Awaitable[Any]
    ) -> bool:
        try:
            await operation
            return True
        except Exception as exc:
            await self._command_error(message, exc)
            return False

    @staticmethod
    async def _command_error(message: Message, exc: Exception) -> None:
        logger.exception("执行 Telegram Codex 命令失败")
        await message.reply_text(f"命令执行失败：{exc}")

    @staticmethod
    async def _reply_chunks(message: Message, text: str) -> None:
        for chunk in split_text(text):
            await message.reply_text(chunk)


def _format_approval(request: ApprovalRequest) -> str:
    parts = [request.title, "", request.details]
    if request.reason:
        parts.extend(["", f"原因：{request.reason}"])
    parts.extend(["", "请选择是否仅批准本次请求。5 分钟未处理将自动拒绝。"])
    text = "\n".join(parts)
    if len(text) > 3800:
        text = text[:3750] + "\n…（内容已截断）"
    return text
