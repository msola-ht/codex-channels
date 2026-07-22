from __future__ import annotations

import asyncio
from dataclasses import replace

from codex_tg_bridge.codex.client import CodexClient
from codex_tg_bridge.codex.jsonrpc import JsonObject
from codex_tg_bridge.config import load_settings


async def run() -> None:
    settings = replace(load_settings(), codex_sandbox="read-only")
    target = settings.codex_workdir / ".codex-tg-approval-smoke"
    if target.exists():
        raise RuntimeError(f"请先移走已有测试目标：{target}")

    client = CodexClient(settings)
    approval_methods: list[str] = []
    completed = asyncio.Event()

    async def on_request(method: str, params: JsonObject) -> JsonObject:
        approval_methods.append(method)
        if method == "item/permissions/requestApproval":
            return {"permissions": {}, "scope": "turn"}
        return {"decision": "decline"}

    async def on_event(method: str, params: JsonObject) -> None:
        del params
        if method == "turn/completed":
            completed.set()

    client.set_server_request_handler(on_request)
    client.add_event_handler(on_event)
    try:
        await client.start()
        thread_id = await client.start_thread(sandbox="read-only")
        await client.start_turn(
            thread_id,
            "请在当前工作目录创建名为 .codex-tg-approval-smoke 的空文件。",
            model=settings.codex_model,
        )
        await asyncio.wait_for(completed.wait(), timeout=120)
    finally:
        await client.stop()

    if target.exists():
        raise RuntimeError("审批拒绝后测试文件仍被创建，安全验证失败")
    if not approval_methods:
        raise RuntimeError("没有收到任何 App Server 审批请求")
    print("APPROVAL_SMOKE_OK methods=" + ",".join(approval_methods))


if __name__ == "__main__":
    asyncio.run(run())
