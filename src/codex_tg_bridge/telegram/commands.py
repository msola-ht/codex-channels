from __future__ import annotations

from typing import Any

from codex_tg_bridge.codex.jsonrpc import JsonObject
from codex_tg_bridge.persistence.sqlite import SessionRecord


TERMINAL_ONLY_COMMANDS = {
    "agent",
    "app",
    "apps",
    "archive",
    "approve",
    "btw",
    "clear",
    "copy",
    "debug-config",
    "delete",
    "diff",
    "exit",
    "experimental",
    "fast",
    "feedback",
    "ide",
    "import",
    "keymap",
    "logout",
    "memories",
    "mention",
    "personality",
    "pet",
    "pets",
    "plan",
    "ps",
    "quit",
    "raw",
    "rename",
    "resume",
    "sandbox-add-read-dir",
    "setup-default-sandbox",
    "side",
    "statusline",
    "subagents",
    "theme",
    "title",
    "vim",
}


def parse_review_target(args: list[str]) -> JsonObject:
    if not args:
        return {"type": "uncommittedChanges"}
    kind = args[0].lower()
    value = " ".join(args[1:]).strip()
    if kind == "branch":
        if not value:
            raise ValueError("用法：/review branch <分支名>")
        return {"type": "baseBranch", "branch": value}
    if kind == "commit":
        if not value:
            raise ValueError("用法：/review commit <SHA>")
        return {"type": "commit", "sha": value}
    if kind == "custom":
        if not value:
            raise ValueError("用法：/review custom <审查要求>")
        return {"type": "custom", "instructions": value}
    return {"type": "custom", "instructions": " ".join(args)}


def format_models(models: list[JsonObject], current: str) -> str:
    if not models:
        return "没有发现可用模型。"
    lines = [f"当前模型：{current}", "可用模型："]
    for item in models:
        model = str(item.get("model") or item.get("id") or "unknown")
        display_name = str(item.get("displayName") or model)
        marker = " ← 当前" if model == current else ""
        default = "（默认）" if item.get("isDefault") else ""
        lines.append(f"- {model} · {display_name}{default}{marker}")
    return "\n".join(lines)


def format_sessions(
    sessions: list[SessionRecord], current_thread_id: str | None
) -> str:
    if not sessions:
        return "还没有历史会话。发送普通文本后会创建第一个 Codex Thread。"
    lines = [f"历史会话（{len(sessions)}）："]
    for index, session in enumerate(sessions, start=1):
        marker = " ← 当前" if session.thread_id == current_thread_id else ""
        label = session.label or "未命名"
        lines.append(f"{index}. {label} · {session.thread_id[:12]}{marker}")
    lines.append("切换：/switch <序号、名称或 Thread ID>；上一会话：/last")
    lines.append("命名当前会话：/session_name <名称>")
    return "\n".join(lines)


def format_skills(entries: list[JsonObject]) -> str:
    skills: list[JsonObject] = []
    errors = 0
    for entry in entries:
        skills.extend(item for item in entry.get("skills", []) if isinstance(item, dict))
        errors += len(entry.get("errors") or [])
    if not skills:
        return "没有发现可用 Skill。" + (f" 扫描错误：{errors}" if errors else "")
    lines = [f"可用 Skills（{len(skills)}）："]
    for item in skills:
        state = "启用" if item.get("enabled") else "禁用"
        scope = item.get("scope") or "unknown"
        lines.append(f"- {item.get('name', 'unknown')} [{scope}/{state}]")
    if errors:
        lines.append(f"扫描错误：{errors}")
    return "\n".join(lines)


def format_mcp_servers(servers: list[JsonObject]) -> str:
    if not servers:
        return "没有配置 MCP Server。"
    lines = [f"MCP Servers（{len(servers)}）："]
    for server in servers:
        tools = server.get("tools") or {}
        auth = _compact_value(server.get("authStatus"))
        lines.append(
            f"- {server.get('name', 'unknown')} · auth={auth} · tools={len(tools)}"
        )
    return "\n".join(lines)


def format_plugins(marketplaces: list[JsonObject]) -> str:
    plugins: list[JsonObject] = []
    for marketplace in marketplaces:
        plugins.extend(
            item for item in marketplace.get("plugins", []) if isinstance(item, dict)
        )
    if not plugins:
        return "没有发现 Plugin。"
    plugins.sort(key=lambda item: (not bool(item.get("installed")), str(item.get("name"))))
    lines = [f"Plugins（{len(plugins)}）："]
    for item in plugins[:60]:
        if item.get("installed"):
            state = "已安装/启用" if item.get("enabled") else "已安装/禁用"
        else:
            state = "可安装"
        lines.append(f"- {item.get('name', item.get('id', 'unknown'))} [{state}]")
    if len(plugins) > 60:
        lines.append(f"…另有 {len(plugins) - 60} 个未显示")
    return "\n".join(lines)


def format_usage(result: JsonObject) -> str:
    summary = result.get("summary") or {}
    if not isinstance(summary, dict):
        return "当前账号没有返回用量摘要。"
    fields = [
        ("累计 Tokens", "lifetimeTokens"),
        ("单日峰值 Tokens", "peakDailyTokens"),
        ("当前连续使用天数", "currentStreakDays"),
        ("最长连续使用天数", "longestStreakDays"),
        ("最长 Turn 秒数", "longestRunningTurnSec"),
    ]
    lines = ["账号用量："]
    for label, key in fields:
        value = summary.get(key)
        if value is not None:
            lines.append(f"- {label}：{value:,}" if isinstance(value, int) else f"- {label}：{value}")
    return "\n".join(lines) if len(lines) > 1 else "当前账号没有返回用量摘要。"


def format_permissions(current: str, profiles: list[JsonObject]) -> str:
    lines = [f"当前 Telegram 沙箱：{current}", "审批策略：on-request（TG/CLI 确认）"]
    if profiles:
        lines.append("Codex 可用权限配置：")
        for item in profiles:
            allowed = "可用" if item.get("allowed") else "被策略禁用"
            lines.append(f"- {item.get('id', 'unknown')} [{allowed}]")
    lines.append("切换：/permissions read-only 或 /permissions workspace-write")
    return "\n".join(lines)


def format_goal(goal: JsonObject | None) -> str:
    if goal is None:
        return "当前 Thread 没有 Goal。设置：/goal set <目标>"
    budget = goal.get("tokenBudget")
    budget_text = "无限制" if budget is None else str(budget)
    return (
        f"Goal：{goal.get('objective', '')}\n"
        f"状态：{goal.get('status', 'unknown')}\n"
        f"Tokens：{goal.get('tokensUsed', 0)} / {budget_text}\n"
        f"耗时：{goal.get('timeUsedSeconds', 0)} 秒"
    )


def _compact_value(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and value:
        return str(next(iter(value)))
    return "unknown"
