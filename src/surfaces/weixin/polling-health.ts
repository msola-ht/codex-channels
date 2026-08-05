import type { WeixinUpdatesRetryEvent } from "./updates-monitor.js";
import { formatElapsedDuration } from "../elapsed-duration.js";

export type WeixinPollingHealthPhase =
  | "backoff"
  | "credential-pause"
  | "polling"
  | "retry"
  | "stopped";

export interface WeixinPollingHealthSnapshot {
  phase: WeixinPollingHealthPhase;
  consecutiveFailures: number;
  lastSuccessfulPollAtMs: number | null;
  resumeAtMs: number | null;
}

export class WeixinPollingHealth {
  private pendingSuccessfulPollAtMs: number | null = null;

  private state: WeixinPollingHealthSnapshot = {
    phase: "stopped",
    consecutiveFailures: 0,
    lastSuccessfulPollAtMs: null,
    resumeAtMs: null,
  };

  start(): void {
    this.pendingSuccessfulPollAtMs = null;
    this.state = {
      ...this.state,
      phase: "polling",
      consecutiveFailures: 0,
      resumeAtMs: null,
    };
  }

  recordPollStart(): void {
    this.state = {
      ...this.state,
      phase: "polling",
      lastSuccessfulPollAtMs:
        this.pendingSuccessfulPollAtMs ?? this.state.lastSuccessfulPollAtMs,
      resumeAtMs: null,
    };
    this.pendingSuccessfulPollAtMs = null;
  }

  recordSuccess(atMs: number): void {
    this.pendingSuccessfulPollAtMs = atMs;
    this.state = {
      ...this.state,
      phase: "polling",
      consecutiveFailures: 0,
      resumeAtMs: null,
    };
  }

  recordRetry(event: WeixinUpdatesRetryEvent, atMs: number): void {
    this.state = {
      ...this.state,
      phase: event.phase,
      consecutiveFailures:
        event.phase === "credential-pause" ? 0 : event.attempt,
      resumeAtMs: atMs + event.delayMs,
    };
  }

  snapshot(): WeixinPollingHealthSnapshot {
    return { ...this.state };
  }

  stop(): void {
    this.state = {
      ...this.state,
      phase: "stopped",
      resumeAtMs: null,
    };
  }
}

export function renderWeixinPollingHealth(
  snapshot: WeixinPollingHealthSnapshot,
  nowMs = Date.now(),
): string {
  const lines = [
    `- 微信链路：${phaseLabel(snapshot.phase)}`,
    `- 连续失败：${snapshot.consecutiveFailures} 次`,
    `- 上次后台轮询：${snapshot.lastSuccessfulPollAtMs === null
      ? "尚无"
      : formatLocalTimestamp(snapshot.lastSuccessfulPollAtMs)}`,
  ];
  if (snapshot.resumeAtMs !== null) {
    lines.push(
      `- 预计恢复：${snapshot.resumeAtMs <= nowMs
        ? "即将重试"
        : `${formatElapsedDuration(snapshot.resumeAtMs - nowMs)}后`}`,
    );
  }
  if (snapshot.phase === "credential-pause") {
    lines.push("- 处理建议：重新运行 codexc setup");
  }
  return lines.join("\n");
}

function phaseLabel(phase: WeixinPollingHealthPhase): string {
  switch (phase) {
    case "polling":
      return "轮询中";
    case "retry":
      return "短重试中";
    case "backoff":
      return "退避中";
    case "credential-pause":
      return "Token 失效暂停";
    case "stopped":
      return "已停止";
  }
}

function formatLocalTimestamp(timestampMs: number): string {
  const timestamp = new Date(timestampMs);
  return [
    timestamp.getFullYear().toString().padStart(4, "0"),
    (timestamp.getMonth() + 1).toString().padStart(2, "0"),
    timestamp.getDate().toString().padStart(2, "0"),
  ].join("-")
    + " "
    + [
      timestamp.getHours().toString().padStart(2, "0"),
      timestamp.getMinutes().toString().padStart(2, "0"),
      timestamp.getSeconds().toString().padStart(2, "0"),
    ].join(":");
}
