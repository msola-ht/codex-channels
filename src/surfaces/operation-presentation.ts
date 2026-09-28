import type { OperationUpdate, OutputEvent } from "../conversation-core/index.js";
import { formatElapsedDuration } from "./elapsed-duration.js";
import { visibleUpstreamMessage } from "./output-copy.js";
import type { OperationUpdateDisplay } from "./types.js";

export function isComputerUseOperation(record: OperationUpdate): boolean {
  return record.kind === "mcpTool" && record.action === "computerUse";
}

export function shouldDisplayOperation(
  record: OperationUpdate,
  display: OperationUpdateDisplay,
): boolean {
  if (display === "hidden") {
    return false;
  }
  if (display === "full" || record.kind !== "subagent") {
    return true;
  }
  return record.status === "failed"
    || record.status === "declined"
    || (record.action === "spawnAgent" && record.status === "completed");
}

export function isExecutionOperation(record: OperationUpdate): boolean {
  return record.kind === "command"
    || record.kind === "fileChange"
    || record.kind === "mcpTool"
    || record.kind === "dynamicTool"
    || record.kind === "webSearch"
    || record.kind === "imageView"
    || record.kind === "imageGeneration";
}

export function operationMetadata(record: OperationUpdate): string[] {
  return [
    record.durationMs === undefined || record.durationMs <= 0
      ? null
      : formatElapsedDuration(record.durationMs),
    record.exitCode === undefined ? null : `exit ${record.exitCode}`,
    mcpToolCapabilityLabel(record),
  ].filter((value): value is string => value !== null);
}

export function mcpToolCapabilityLabel(record: OperationUpdate): string | null {
  if (record.kind !== "mcpTool" || isComputerUseOperation(record)) return null;
  if (record.readOnlyHint === true) return "上游标记只读";
  if (record.readOnlyHint === false) return "可能写入";
  return "读写属性未知";
}

export function compactOperationDetail(value: string): string {
  const normalized = redactOperationDetail(value)
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(normalized);
  return characters.length <= 160
    ? normalized
    : `${characters.slice(0, 159).join("")}…`;
}

export function redactOperationDetail(value: string): string {
  return visibleUpstreamMessage(value);
}

export function operationStatus(status: OperationUpdate["status"]): string {
  return ({
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    declined: "已拒绝",
  } as const)[status];
}

export function operationTitle(record: OperationUpdate): string {
  switch (record.kind) {
    case "command":
      return "运行命令";
    case "fileChange":
      return "修改文件";
    case "mcpTool":
      return isComputerUseOperation(record) ? "电脑与浏览器操作" : "调用 MCP 工具";
    case "dynamicTool":
      return "调用工具";
    case "subagent":
      return ({
        spawnAgent: "启动子代理",
        sendInput: "向子代理发送任务",
        sendMessage: "向子代理发送消息",
        followupTask: "向子代理追加任务",
        resumeAgent: "恢复子代理",
        interruptAgent: "中断子代理",
        listAgents: "查看子代理",
        wait: "等待子代理",
        closeAgent: "关闭子代理",
        started: "子代理已启动",
        interacted: "子代理正在交互",
        interrupted: "子代理已中断",
      } as Record<string, string>)[record.action ?? ""] ?? "子代理活动";
    case "webSearch":
      return "搜索网页";
    case "imageView":
      return "查看图片";
    case "imageGeneration":
      return "生成图片";
    case "sleep":
      return "等待";
    case "plan":
      return "更新计划";
    case "contextCompaction":
      return "压缩上下文";
    case "reviewMode":
      return record.action === "exited" ? "退出审查模式" : "进入审查模式";
  }
}

/** Separate lifecycle notices: never merge a queued start into its completion. */
export class ContextCompactionNotices {
  private readonly states = new Map<string, OperationUpdate["status"]>();

  accept(event: Extract<OutputEvent, { type: "operation.updated" }>, retained = false): string | null {
    if (event.operation.kind !== "contextCompaction") return null;
    const { itemId, status } = event.operation;
    const key = JSON.stringify([
      event.target.surface, event.target.accountId, event.target.conversationId,
      event.threadId, event.turnId, itemId,
    ]);
    const previous = this.states.get(key);
    if (!retained && (previous === status || (previous !== undefined && previous !== "running"))) return null;
    this.states.set(key, status);
    // Keep only recent presentation state; this is not a second Item history.
    if (this.states.size > 256) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
    return ({
      running: "开始压缩上下文…",
      completed: "上下文压缩已完成。",
      failed: "上下文压缩失败。",
      declined: "上下文压缩已拒绝。",
    } as const)[status];
  }
}
