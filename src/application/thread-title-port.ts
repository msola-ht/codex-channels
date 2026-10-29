import { createHash } from "node:crypto";
import type { TurnInput } from "./turn-port.js";

/** Explicit user text provenance; never infer this from a synthetic attachment body. */
export interface TitleInputContext {
  actorId: string;
  text: string;
  source: "task" | "caption" | "transcription" | "answer";
}

export interface CompletedThreadTitleInput {
  threadId: string;
  turnId: string;
  itemId: string;
  clientUserMessageId: string;
  digest: string;
}

/** Both wire encoding and completion projection preserve text segment boundaries. */
export function threadTitleInputDigest(input: readonly TurnInput[]): string {
  return createHash("sha256").update(JSON.stringify(input.filter(item => item.type === "text")
    .map(item => item.text))).digest("hex");
}

export interface GenerateThreadTitleRequest {
  threadId: string;
  cwd: string;
  model: string;
  modelProvider: string;
  permissionProfile: { type: "builtin" } | { type: "custom"; id: string };
  candidate: string;
  signal: AbortSignal;
  /** Absolute deadline for preflight, including Provider admission. */
  deadlineMs: number;
  beforeSubmit(): void;
}

export type GenerateThreadTitleResult =
  | { type: "generated"; title: string }
  | { type: "skipped" | "failed" | "cleanupUnconfirmed"; reason: string };

export interface SetGeneratedThreadNameRequest {
  threadId: string;
  cwd: string;
  title: string;
  deadlineMs: number;
  beforeSubmit(): void;
}

export type SetGeneratedThreadNameResult =
  | { type: "applied" }
  | { type: "alreadyNamed"; name: string }
  | { type: "unconfirmed" };

export interface ThreadTitlePort {
  generateThreadTitle(request: GenerateThreadTitleRequest): Promise<GenerateThreadTitleResult>;
  setGeneratedThreadName(request: SetGeneratedThreadNameRequest): Promise<SetGeneratedThreadNameResult>;
}
