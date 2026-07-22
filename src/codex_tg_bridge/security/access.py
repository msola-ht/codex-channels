from __future__ import annotations

from collections.abc import Collection


class AccessController:
    def __init__(self, allowed_user_ids: Collection[int]) -> None:
        self._allowed_user_ids = frozenset(allowed_user_ids)

    def is_allowed(self, user_id: int | None) -> bool:
        return user_id is not None and user_id in self._allowed_user_ids

