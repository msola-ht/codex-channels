from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import Any


class SecretRedactionFilter(logging.Filter):
    def __init__(self, secrets: Iterable[str]) -> None:
        super().__init__()
        self._secrets = tuple(secret for secret in secrets if secret)

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = self._redact(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(self._redact(value) for value in record.args)
        elif isinstance(record.args, dict):
            record.args = {
                key: self._redact(value) for key, value in record.args.items()
            }
        return True

    def _redact(self, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        for secret in self._secrets:
            value = value.replace(secret, "[REDACTED]")
        return value


def configure_secret_safe_logging(level: int, telegram_token: str) -> None:
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    redaction_filter = SecretRedactionFilter([telegram_token])
    for handler in logging.getLogger().handlers:
        handler.addFilter(redaction_filter)

    # httpx 的 INFO 日志包含完整 Telegram Bot API URL，其中嵌入 Bot Token。
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

