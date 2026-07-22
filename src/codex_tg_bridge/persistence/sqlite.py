from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class SessionRecord:
    chat_id: int
    thread_id: str
    label: str | None
    created_at: str
    last_used_ns: int


class SessionStore:
    def __init__(self, database_path: Path) -> None:
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(database_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._lock = threading.Lock()

    def initialize(self) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_sessions (
                    chat_id INTEGER PRIMARY KEY,
                    thread_id TEXT NOT NULL UNIQUE,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS session_history (
                    chat_id INTEGER NOT NULL,
                    thread_id TEXT NOT NULL UNIQUE,
                    label TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    last_used_ns INTEGER NOT NULL,
                    PRIMARY KEY (chat_id, thread_id)
                )
                """
            )
            self._connection.execute(
                """
                INSERT OR IGNORE INTO session_history (
                    chat_id, thread_id, created_at, last_used_ns
                )
                SELECT
                    chat_id,
                    thread_id,
                    updated_at,
                    CAST(strftime('%s', updated_at) AS INTEGER) * 1000000000
                FROM chat_sessions
                """
            )
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_preferences (
                    chat_id INTEGER PRIMARY KEY,
                    model TEXT,
                    sandbox TEXT,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

    def get_thread_id(self, chat_id: int) -> str | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT thread_id FROM chat_sessions WHERE chat_id = ?",
                (chat_id,),
            ).fetchone()
        return None if row is None else str(row["thread_id"])

    def get_chat_id(self, thread_id: str) -> int | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT chat_id FROM chat_sessions WHERE thread_id = ?",
                (thread_id,),
            ).fetchone()
        return None if row is None else int(row["chat_id"])

    def save(self, chat_id: int, thread_id: str) -> None:
        now = time.time_ns()
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO session_history (chat_id, thread_id, last_used_ns)
                VALUES (?, ?, ?)
                ON CONFLICT(chat_id, thread_id) DO UPDATE SET
                    last_used_ns = excluded.last_used_ns
                """,
                (chat_id, thread_id, now),
            )
            self._connection.execute(
                """
                INSERT INTO chat_sessions (chat_id, thread_id, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(chat_id) DO UPDATE SET
                    thread_id = excluded.thread_id,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (chat_id, thread_id),
            )

    def touch(self, chat_id: int, thread_id: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE session_history
                SET last_used_ns = ?
                WHERE chat_id = ? AND thread_id = ?
                """,
                (time.time_ns(), chat_id, thread_id),
            )

    def list_sessions(self, chat_id: int) -> list[SessionRecord]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT chat_id, thread_id, label, created_at, last_used_ns
                FROM session_history
                WHERE chat_id = ?
                ORDER BY last_used_ns DESC
                """,
                (chat_id,),
            ).fetchall()
        return [
            SessionRecord(
                chat_id=int(row["chat_id"]),
                thread_id=str(row["thread_id"]),
                label=None if row["label"] is None else str(row["label"]),
                created_at=str(row["created_at"]),
                last_used_ns=int(row["last_used_ns"]),
            )
            for row in rows
        ]

    def rename_session(self, chat_id: int, thread_id: str, label: str) -> None:
        with self._lock, self._connection:
            cursor = self._connection.execute(
                """
                UPDATE session_history
                SET label = ?
                WHERE chat_id = ? AND thread_id = ?
                """,
                (label, chat_id, thread_id),
            )
            if cursor.rowcount != 1:
                raise ValueError("会话不属于当前 Telegram 用户")

    def delete(self, chat_id: int) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "DELETE FROM chat_sessions WHERE chat_id = ?",
                (chat_id,),
            )

    def get_preferences(self, chat_id: int) -> tuple[str | None, str | None]:
        with self._lock:
            row = self._connection.execute(
                "SELECT model, sandbox FROM chat_preferences WHERE chat_id = ?",
                (chat_id,),
            ).fetchone()
        if row is None:
            return None, None
        model = None if row["model"] is None else str(row["model"])
        sandbox = None if row["sandbox"] is None else str(row["sandbox"])
        return model, sandbox

    def set_model(self, chat_id: int, model: str) -> None:
        self._set_preference(chat_id, "model", model)

    def set_sandbox(self, chat_id: int, sandbox: str) -> None:
        self._set_preference(chat_id, "sandbox", sandbox)

    def _set_preference(self, chat_id: int, column: str, value: str) -> None:
        if column not in {"model", "sandbox"}:
            raise ValueError("不支持的会话配置字段")
        with self._lock, self._connection:
            self._connection.execute(
                f"""
                INSERT INTO chat_preferences (chat_id, {column}, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(chat_id) DO UPDATE SET
                    {column} = excluded.{column},
                    updated_at = CURRENT_TIMESTAMP
                """,
                (chat_id, value),
            )

    def close(self) -> None:
        with self._lock:
            self._connection.close()
