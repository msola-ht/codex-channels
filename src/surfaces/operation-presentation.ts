import type { OperationUpdate } from "../conversation-core/index.js";
import { formatElapsedDuration } from "./elapsed-duration.js";

export function operationMetadata(record: OperationUpdate): string[] {
  return [
    record.durationMs === undefined || record.durationMs <= 0
      ? null
      : formatElapsedDuration(record.durationMs),
    record.exitCode === undefined ? null : `exit ${record.exitCode}`,
  ].filter((value): value is string => value !== null);
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
  return value
    .replaceAll("[REDACTED]", "[已隐藏]")
    .replace(
      /(?:\/[^/\s"'`;&|<>()[\]{}]+)*\/\.(?:codex-connect|codex)(?:\/[^/\s"'`;&|<>()[\]{}]+)*/gu,
      "[内部路径]",
    );
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
      return "调用 MCP 工具";
    case "dynamicTool":
      return "调用工具";
    case "subagent":
      return ({
        spawnAgent: "启动子代理",
        sendInput: "向子代理发送任务",
        resumeAgent: "恢复子代理",
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
