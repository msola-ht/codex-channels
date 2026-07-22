from __future__ import annotations

import tempfile
import unittest
import sqlite3
from pathlib import Path

from codex_tg_bridge.persistence.sqlite import SessionStore


class SessionStoreTests(unittest.TestCase):
    def test_saves_reads_and_deletes_mapping(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = SessionStore(Path(temp_dir) / "state.sqlite3")
            store.initialize()
            store.save(123, "thread-1")
            self.assertEqual(store.get_thread_id(123), "thread-1")
            self.assertEqual(store.get_chat_id("thread-1"), 123)
            store.save(123, "thread-2")
            self.assertEqual(store.get_thread_id(123), "thread-2")
            sessions = store.list_sessions(123)
            self.assertEqual([item.thread_id for item in sessions], ["thread-2", "thread-1"])
            store.rename_session(123, "thread-2", "当前项目")
            self.assertEqual(store.list_sessions(123)[0].label, "当前项目")
            store.set_model(123, "gpt-test")
            store.set_sandbox(123, "read-only")
            self.assertEqual(
                store.get_preferences(123),
                ("gpt-test", "read-only"),
            )
            store.delete(123)
            self.assertIsNone(store.get_thread_id(123))
            self.assertEqual(len(store.list_sessions(123)), 2)
            self.assertEqual(
                store.get_preferences(123),
                ("gpt-test", "read-only"),
            )
            store.close()

    def test_migrates_existing_active_mapping_into_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database_path = Path(temp_dir) / "state.sqlite3"
            connection = sqlite3.connect(database_path)
            connection.execute(
                """
                CREATE TABLE chat_sessions (
                    chat_id INTEGER PRIMARY KEY,
                    thread_id TEXT NOT NULL UNIQUE,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            connection.execute(
                "INSERT INTO chat_sessions (chat_id, thread_id) VALUES (?, ?)",
                (123, "legacy-thread"),
            )
            connection.commit()
            connection.close()

            store = SessionStore(database_path)
            store.initialize()
            self.assertEqual(store.list_sessions(123)[0].thread_id, "legacy-thread")
            store.close()


if __name__ == "__main__":
    unittest.main()
