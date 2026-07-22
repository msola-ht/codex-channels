from __future__ import annotations

import asyncio

from codex_tg_bridge.codex.client import CodexClient
from codex_tg_bridge.config import load_settings


async def run() -> None:
    settings = load_settings()
    client = CodexClient(settings)
    try:
        await client.start()
        models = await asyncio.wait_for(client.list_models(), timeout=30)
        skills = await asyncio.wait_for(client.list_skills(), timeout=30)
        mcp_servers = await asyncio.wait_for(client.list_mcp_servers(), timeout=30)
        plugins = await asyncio.wait_for(client.list_plugins(), timeout=30)
        usage = await asyncio.wait_for(client.account_usage(), timeout=30)
        profiles = await asyncio.wait_for(client.list_permission_profiles(), timeout=30)

        model_ids = {
            str(item.get("model") or item.get("id"))
            for item in models
            if item.get("model") or item.get("id")
        }
        print(f"models: ok ({len(models)})")
        print(f"configured model listed: {settings.codex_model in model_ids}")
        print(f"skill groups: ok ({len(skills)})")
        print(f"mcp servers: ok ({len(mcp_servers)})")
        print(f"plugin marketplaces: ok ({len(plugins)})")
        print(f"usage: {'ok' if 'summary' in usage else 'missing summary'}")
        print(f"permission profiles: ok ({len(profiles)})")
    finally:
        await client.stop()


if __name__ == "__main__":
    asyncio.run(run())
