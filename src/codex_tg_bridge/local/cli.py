from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from codex_tg_bridge.config import ConfigurationError, load_settings


async def run() -> None:
    settings = load_settings()
    try:
        reader, writer = await asyncio.open_unix_connection(
            str(settings.local_socket_path)
        )
    except (FileNotFoundError, ConnectionRefusedError) as exc:
        raise RuntimeError(
            f"无法连接 Bridge：{settings.local_socket_path}；请先启动 codex-tg-bridge"
        ) from exc

    writer.write(
        (json.dumps({"type": "hello", "client": "cli"}) + "\n").encode()
    )
    await writer.drain()

    receive_task = asyncio.create_task(_receive(reader))
    try:
        while not receive_task.done():
            line = await asyncio.to_thread(input, "> ")
            text = line.strip()
            if text in {"/quit", "/exit"}:
                break
            writer.write(
                (json.dumps({"type": "input", "text": line}, ensure_ascii=False) + "\n").encode()
            )
            await writer.drain()
    except (EOFError, KeyboardInterrupt):
        pass
    finally:
        writer.close()
        await writer.wait_closed()
        receive_task.cancel()
        await asyncio.gather(receive_task, return_exceptions=True)


async def _receive(reader: asyncio.StreamReader) -> None:
    while line := await reader.readline():
        payload = json.loads(line)
        _display(payload)


def _display(payload: dict[str, Any]) -> None:
    kind = payload.get("type")
    if kind == "ready":
        print(f"已连接共享 Codex 会话（chat_id={payload.get('chat_id')}）")
        print("输入 /help 查看命令。")
    elif kind == "delta":
        if payload.get("new_item"):
            print()
        print(str(payload.get("text", "")), end="", flush=True)
    elif kind == "input":
        print(f"\n[Telegram 指令]\n{payload.get('text', '')}")
    elif kind == "completed":
        print(f"\n[任务结束：{payload.get('status', 'completed')}]")
    elif kind == "approval":
        print("\n[需要审批]")
        print(payload.get("title", "Codex 权限请求"))
        print(payload.get("details", ""))
        if payload.get("reason"):
            print(f"原因：{payload['reason']}")
        print(
            f"批准：/approve {payload.get('token')}  "
            f"拒绝：/decline {payload.get('token')}"
        )
    elif kind == "approval_result":
        print(f"\n[审批 {payload.get('token')}：{payload.get('outcome')}]")
    else:
        prefix = "错误：" if kind == "error" else ""
        print(prefix + str(payload.get("message", payload)))


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    except (ConfigurationError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
