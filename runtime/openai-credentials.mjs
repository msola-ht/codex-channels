import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { codexHomePath } from "./codex-home.mjs";

/** Local credential refresh time, never an authorization or live billing source. */
export async function readOpenAiCredentialRefreshTime(accountId, environment = process.env) {
  if (typeof accountId !== "string" || !accountId) return null;
  let file;
  try {
    file = await open(join(codexHomePath(environment), "auth.json"), constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) return null;
    const buffer = Buffer.alloc(128 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 128 * 1024) return null;
    const auth = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    const token = auth?.tokens?.id_token;
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/u.test(parts[1])) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.["https://api.openai.com/auth"];
    if (claims?.chatgpt_account_id !== accountId) return null;
    return timestamp(auth.last_refresh);
  } catch {
    // Optional cache metadata must not expose credential contents or break quota queries.
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}
