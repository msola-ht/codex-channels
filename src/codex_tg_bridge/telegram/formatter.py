from __future__ import annotations


TELEGRAM_TEXT_LIMIT = 4096
STREAM_PREVIEW_LIMIT = 3900


def split_text(text: str, limit: int = TELEGRAM_TEXT_LIMIT) -> list[str]:
    if not text:
        return []
    chunks: list[str] = []
    remaining = text
    while len(remaining) > limit:
        split_at = remaining.rfind("\n", 0, limit + 1)
        if split_at <= 0:
            split_at = limit
        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:].lstrip("\n")
    if remaining:
        chunks.append(remaining)
    return chunks


def stream_preview(text: str) -> str:
    if len(text) <= STREAM_PREVIEW_LIMIT:
        return text
    marker = "…（前文暂时折叠，回复仍在生成）\n\n"
    return marker + text[-(STREAM_PREVIEW_LIMIT - len(marker)):]
