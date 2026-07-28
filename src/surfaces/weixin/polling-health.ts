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
  private state: WeixinPollingHealthSnapshot = {
    phase: "stopped",
    consecutiveFailures: 0,
    lastSuccessfulPollAtMs: null,
    resumeAtMs: null,
  };

  start(): void {
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
      resumeAtMs: null,
    };
  }

  recordSuccess(atMs: number): void {
    this.state = {
      phase: "polling",
      consecutiveFailures: 0,
      lastSuccessfulPollAtMs: atMs,
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
    `微信链路：${phaseLabel(snapshot.phase)}`,
    `连续失败：${snapshot.consecutiveFailures} 次`,
    `最近成功轮询：${snapshot.lastSuccessfulPollAtMs === null
      ? "尚无"
      : elapsedLabel(nowMs - snapshot.lastSuccessfulPollAtMs)}`,
  ];
  if (snapshot.resumeAtMs !== null) {
    lines.push(
      `预计恢复：${snapshot.resumeAtMs <= nowMs
        ? "即将重试"
        : `${formatElapsedDuration(snapshot.resumeAtMs - nowMs)}后`}`,
    );
  }
  if (snapshot.phase === "credential-pause") {
    lines.push("处理建议：重新运行 codexc setup");
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

function elapsedLabel(elapsedMs: number): string {
  if (elapsedMs <= 1_000) {
    return "1秒内";
  }
  return `${formatElapsedDuration(elapsedMs)}前`;
}
