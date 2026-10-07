import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OutputEvent } from "../conversation-core/index.js";
import { readGeneratedImage } from "./generated-image.js";
import { shouldDisplayOperation } from "./operation-presentation.js";
import type { OperationUpdateDisplay } from "./types.js";
import { resolveSurfaceDelivery } from "./delivery-policy.js";
import { securePrivateDirectorySync, securePrivateFileSync } from "../../runtime/private-file.mjs";

/** Result and compaction lifecycle retention is separate from other live intermediate output. */
export function isPersistentOutput(event: OutputEvent, display: OperationUpdateDisplay = "full"): boolean {
  if (resolveSurfaceDelivery(event.target.surface, event).disposition === "ignore") return false;
  switch (event.type) {
    case "text.completed": case "turn.completed": case "subagent.completed": case "autoApprovalReview.updated":
    case "turn.started": case "subagent.spawned": case "subagent.contacted":
    case "connection.lost": case "connection.restored": case "thread.availability": case "thread.name":
    case "mcp.oauth.completed": case "warning": case "conversation.idle.released": return true;
    case "operation.updated": return event.operation.kind === "contextCompaction" || (event.operation.status !== "running" && (
      (event.operation.kind === "imageGeneration" && event.operation.status === "completed" && event.operation.imagePath !== undefined)
      || shouldDisplayOperation(event.operation, display)
    ));
    case "text.delta": case "user.message": case "plan.updated": case "thread.status":
    case "turn.reasoning": case "account.updated":
    case "account.rateLimits.updated": case "mcp.status.updated": return false;
    default: { const exhaustive: never = event; throw new Error(`未分类输出：${String(exhaustive)}`); }
  }
}

/** Retain every failed result for inspection without fencing later delivery or interactions. */
export function mayReleaseUncertainOutputBarrier(event: OutputEvent): boolean {
  return isPersistentOutput(event);
}

export interface PersistentOutputPayload {
  version: 1;
  event: OutputEvent;
  owner: string;
  image?: { base64: string; format: "png" | "jpeg" };
}

export async function snapshotPersistentOutput(event: OutputEvent, owner: string): Promise<PersistentOutputPayload> {
  if (event.type === "operation.updated" && event.operation.imagePath !== undefined) {
    const overhead = Buffer.byteLength(JSON.stringify({ version: 1, event, owner })) + 256;
    const imageBudget = Math.floor((4 * 1024 * 1024 - overhead) * 3 / 4);
    if (imageBudget <= 0) throw new Error("持久图片超出单条容量");
    const image = await readGeneratedImage(event.operation.imagePath, imageBudget);
    const operation = { ...event.operation };
    delete operation.imagePath;
    return { version: 1, event: { ...event, operation }, owner, image: { base64: image.bytes.toString("base64"), format: image.format } };
  }
  return { version: 1, event, owner };
}

/** The input was authenticated by the version-locked journal, never received from an external caller. */
export function decodePersistentOutput(payload: string): PersistentOutputPayload {
  const value = JSON.parse(payload) as PersistentOutputPayload;
  if (value.version !== 1 || typeof value.owner !== "string" || !isPersistentOutput(value.event)) throw new Error("持久输出格式不受支持");
  return value;
}

export async function withPersistentOutputImage<T>(payload: PersistentOutputPayload, directory: string, run: (event: OutputEvent) => Promise<T>): Promise<T> {
  if (!payload.image) return run(payload.event);
  if (payload.event.type !== "operation.updated") throw new Error("持久图片归属无效");
  const temporary = await mkdtemp(join(directory, "image-"));
  securePrivateDirectorySync(temporary);
  try {
    const path = join(temporary, `result.${payload.image.format}`);
    await writeFile(path, Buffer.from(payload.image.base64, "base64"), { mode: 0o600, flag: "wx" });
    securePrivateFileSync(path);
    return await run({ ...payload.event, operation: { ...payload.event.operation, imagePath: path } });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
