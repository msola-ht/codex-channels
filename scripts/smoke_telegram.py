from __future__ import annotations

import asyncio
import argparse

from telegram import Bot

from codex_tg_bridge.config import load_settings


async def run(send_test: bool) -> None:
    settings = load_settings()
    async with Bot(settings.telegram_bot_token) as bot:
        identity = await bot.get_me()
        commands = await bot.get_my_commands()
        print("telegram auth: ok")
        print(f"bot username: @{identity.username}")
        print(f"bot commands: {len(commands)}")
        if send_test:
            for user_id in sorted(settings.telegram_allowed_user_ids):
                await bot.send_message(
                    chat_id=user_id,
                    text=(
                        "Codex Telegram Bridge 测试成功。\n"
                        f"当前模型：{settings.codex_model or 'Codex 默认模型'}"
                    ),
                )
                print(f"test message: sent to user {user_id}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--send-test",
        action="store_true",
        help="向 .env 白名单用户发送一条测试消息",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    asyncio.run(run(args.send_test))
