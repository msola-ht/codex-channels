from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from dotenv import dotenv_values


class ConfigurationError(ValueError):
    """Raised when required configuration is missing or unsafe."""


@dataclass(frozen=True, slots=True)
class Settings:
    telegram_bot_token: str
    telegram_allowed_user_ids: frozenset[int]
    codex_binary: str
    codex_workdir: Path
    codex_model: str | None
    codex_sandbox: str
    database_path: Path
    log_level: str
    approval_timeout_seconds: int
    local_socket_path: Path
    local_cli_chat_id: int


def _required(values: Mapping[str, str], name: str) -> str:
    value = values.get(name, "").strip()
    if not value:
        raise ConfigurationError(f"缺少必填配置：{name}")
    return value


def _parse_user_ids(raw: str) -> frozenset[int]:
    try:
        user_ids = frozenset(int(part.strip()) for part in raw.split(",") if part.strip())
    except ValueError as exc:
        raise ConfigurationError("TELEGRAM_ALLOWED_USER_IDS 必须是逗号分隔的整数") from exc
    if not user_ids or any(user_id <= 0 for user_id in user_ids):
        raise ConfigurationError("TELEGRAM_ALLOWED_USER_IDS 必须至少包含一个正整数")
    return user_ids


def load_settings(
    env_path: Path | str = Path(".env"),
    environ: Mapping[str, str] | None = None,
) -> Settings:
    """Load settings from .env, with process environment taking precedence."""

    file_values = {
        key: value
        for key, value in dotenv_values(env_path).items()
        if value is not None
    }
    process_values = dict(os.environ if environ is None else environ)
    values = {**file_values, **process_values}

    token = _required(values, "TELEGRAM_BOT_TOKEN")
    user_ids = _parse_user_ids(_required(values, "TELEGRAM_ALLOWED_USER_IDS"))

    codex_binary = values.get("CODEX_BINARY", "codex").strip() or "codex"
    if Path(codex_binary).is_absolute():
        if not Path(codex_binary).is_file():
            raise ConfigurationError("CODEX_BINARY 指向的文件不存在")
    elif shutil.which(codex_binary) is None:
        raise ConfigurationError(f"找不到 Codex 命令：{codex_binary}")

    workdir_raw = _required(values, "CODEX_WORKDIR")
    workdir = Path(workdir_raw).expanduser()
    if not workdir.is_absolute():
        raise ConfigurationError("CODEX_WORKDIR 必须是绝对路径")
    workdir = workdir.resolve()
    if not workdir.is_dir():
        raise ConfigurationError("CODEX_WORKDIR 必须是已存在的目录")

    sandbox = (
        values.get("CODEX_BRIDGE_SANDBOX", "workspace-write").strip()
        or "workspace-write"
    )
    if sandbox not in {"read-only", "workspace-write"}:
        raise ConfigurationError(
            "CODEX_BRIDGE_SANDBOX 只允许 read-only 或 workspace-write"
        )

    database_path = Path(
        values.get("DATABASE_PATH", "./data/bridge.sqlite3").strip()
        or "./data/bridge.sqlite3"
    ).expanduser()
    if not database_path.is_absolute():
        database_path = (Path.cwd() / database_path).resolve()

    model = values.get("CODEX_MODEL", "").strip() or None
    log_level = values.get("LOG_LEVEL", "INFO").strip().upper() or "INFO"
    try:
        approval_timeout = int(values.get("APPROVAL_TIMEOUT_SECONDS", "300"))
    except ValueError as exc:
        raise ConfigurationError("APPROVAL_TIMEOUT_SECONDS 必须是整数") from exc
    if not 30 <= approval_timeout <= 3600:
        raise ConfigurationError("APPROVAL_TIMEOUT_SECONDS 必须在 30 到 3600 之间")

    socket_path = Path(
        values.get("LOCAL_SOCKET_PATH", "./data/bridge.sock").strip()
        or "./data/bridge.sock"
    ).expanduser()
    if not socket_path.is_absolute():
        socket_path = (Path.cwd() / socket_path).resolve()

    cli_chat_raw = values.get("LOCAL_CLI_CHAT_ID", "").strip()
    if cli_chat_raw:
        try:
            local_cli_chat_id = int(cli_chat_raw)
        except ValueError as exc:
            raise ConfigurationError("LOCAL_CLI_CHAT_ID 必须是整数") from exc
        if local_cli_chat_id == 0:
            raise ConfigurationError("LOCAL_CLI_CHAT_ID 不能为 0")
    elif len(user_ids) == 1:
        local_cli_chat_id = next(iter(user_ids))
    else:
        raise ConfigurationError(
            "配置多个 Telegram 用户时必须显式设置 LOCAL_CLI_CHAT_ID"
        )

    return Settings(
        telegram_bot_token=token,
        telegram_allowed_user_ids=user_ids,
        codex_binary=codex_binary,
        codex_workdir=workdir,
        codex_model=model,
        codex_sandbox=sandbox,
        database_path=database_path,
        log_level=log_level,
        approval_timeout_seconds=approval_timeout,
        local_socket_path=socket_path,
        local_cli_chat_id=local_cli_chat_id,
    )
