from __future__ import annotations

import asyncio
import logging

from codex_tg_bridge.application import ApprovalRequest, EventSink
from codex_tg_bridge.local.server import LocalControlServer


logger = logging.getLogger(__name__)


class MultiplexEventSink(EventSink):
    def __init__(
        self,
        telegram: EventSink,
        local: LocalControlServer,
    ) -> None:
        self._telegram = telegram
        self._local = local

    async def on_input(self, chat_id: int, text: str, source: str) -> None:
        await self._fanout("on_input", chat_id, text, source)

    async def on_delta(
        self, chat_id: int, turn_id: str, item_id: str, delta: str
    ) -> None:
        await self._fanout("on_delta", chat_id, turn_id, item_id, delta)

    async def on_completed(self, chat_id: int, turn_id: str, status: str) -> None:
        await self._fanout("on_completed", chat_id, turn_id, status)

    async def on_error(self, chat_id: int, message: str) -> None:
        await self._fanout("on_error", chat_id, message)

    async def request_approval(
        self, chat_id: int, request: ApprovalRequest
    ) -> bool:
        tasks = {
            asyncio.create_task(self._telegram.request_approval(chat_id, request))
        }
        if self._local.has_clients(chat_id):
            tasks.add(asyncio.create_task(self._local.request_approval(chat_id, request)))

        errors: list[BaseException] = []
        try:
            while tasks:
                done, tasks = await asyncio.wait(
                    tasks, return_when=asyncio.FIRST_COMPLETED
                )
                decisions: list[bool] = []
                for task in done:
                    try:
                        decisions.append(task.result())
                    except Exception as exc:
                        errors.append(exc)
                        logger.warning("审批界面不可用", exc_info=exc)
                if decisions:
                    return all(decisions)
            if errors:
                logger.error("所有审批界面均不可用，已安全拒绝")
            return False
        finally:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    async def _fanout(self, method: str, *args: object) -> None:
        results = await asyncio.gather(
            getattr(self._telegram, method)(*args),
            getattr(self._local, method)(*args),
            return_exceptions=True,
        )
        for result in results:
            if isinstance(result, BaseException):
                logger.warning("事件界面广播失败：%s", method, exc_info=result)
