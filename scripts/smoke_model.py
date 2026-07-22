from __future__ import annotations

import asyncio

from codex_tg_bridge.codex.client import CodexClient
from codex_tg_bridge.config import load_settings


async def run() -> None:
    settings = load_settings()
    client = CodexClient(settings)
    completed = asyncio.Event()
    chunks: list[str] = []
    final_status = "unknown"
    target_turn_id: str | None = None

    async def on_event(method: str, params: dict[str, object]) -> None:
        nonlocal final_status
        if method == "item/agentMessage/delta" and params.get("turnId") == target_turn_id:
            chunks.append(str(params.get("delta", "")))
        elif method == "turn/completed":
            turn = params.get("turn")
            if isinstance(turn, dict) and turn.get("id") == target_turn_id:
                final_status = str(turn.get("status", "unknown"))
                completed.set()

    client.add_event_handler(on_event)
    try:
        await client.start()
        thread_id = await client.start_thread()
        target_turn_id = await client.start_turn(
            thread_id,
            "这是连接测试。不要调用工具，只回复：MODEL_OK",
        )
        await asyncio.wait_for(completed.wait(), timeout=180)
        print(f"model: {settings.codex_model or '<default>'}")
        print(f"status: {final_status}")
        print(f"response: {''.join(chunks).strip()}")
    finally:
        await client.stop()


if __name__ == "__main__":
    asyncio.run(run())
