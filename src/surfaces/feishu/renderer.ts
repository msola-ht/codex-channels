import type {
  OutputEvent,
  UserFacingError,
} from "../../conversation-core/index.js";
import type { SurfaceConfigurationChange } from "../types.js";

export function renderFeishuConfigurationChange(
  change: SurfaceConfigurationChange,
): string {
  switch (change.action) {
    case "reloaded":
      return [
        "Gateway 配置已热加载",
        ...(change.addedWorkspaces.length > 0
          ? [`新增 Workspace：${change.addedWorkspaces.map((workspace) => workspace.name).join("、")}`]
          : []),
      ].join("\n");
    case "restarting":
      return "Gateway 配置需要重启";
    case "reinstall-required":
      return "Gateway 配置尚未应用，请在本机重新安装服务";
    case "reload-failed":
      return "Gateway 配置热加载失败，当前有效配置继续运行";
  }
}

export function renderFeishuUserFacingError(
  error: UserFacingError,
): string {
  switch (error.code) {
    case "message.empty":
      return "消息不能为空";
    case "conversation.missing":
      return "当前还没有 Codex Thread";
    case "thread.bound":
      return "该 Codex Thread 已绑定到其他会话";
    case "workspace.missing":
      return "当前 Workspace 不存在或未获授权";
    default:
      return "Gateway 无法完成请求，请稍后重试";
  }
}

export function renderFeishuOutput(event: OutputEvent): string | null {
  switch (event.type) {
    case "turn.started":
    case "text.delta":
      return null;
    case "user.message":
      return `CLI 输入\n${event.text}`;
    case "text.completed":
      return event.text.trim() ? event.text : "Codex 返回了空消息。";
    case "operation.updated":
      return event.operation.status === "running"
        ? null
        : `${operationKindLabel(event.operation.kind)}：${operationStatusLabel(event.operation.status)}`;
    case "turn.completed":
      if (event.error) {
        return "Codex 任务失败，Gateway 已隐藏上游错误详情。";
      }
      return `Codex 任务状态：${turnStatusLabel(event.status)}`;
    case "thread.status":
      return `Thread 状态：${threadStatusLabel(event.status)}`;
    case "connection.lost":
      return "Codex 连接已中断，Gateway 已隐藏上游错误详情。";
    case "account.updated":
      return `Codex 账户状态已更新：认证=${event.authMode ?? "未登录"} · 套餐=${event.planType ?? "未知"}`;
    case "account.rateLimits.updated":
      return "Codex 额度状态已更新。";
    case "mcp.status.updated":
      return [
        `MCP Server：${event.name} · ${mcpStatusLabel(event.status)}`,
        ...(event.error ? ["原因：Gateway 已隐藏上游错误详情。"] : []),
      ].join("\n");
    case "warning":
      return "Codex 发出一条警告，Gateway 已隐藏上游详情。";
  }
}

function operationKindLabel(kind: Extract<OutputEvent, { type: "operation.updated" }>["operation"]["kind"]): string {
  const labels = {
    command: "运行命令",
    fileChange: "修改文件",
    mcpTool: "调用 MCP 工具",
    dynamicTool: "调用工具",
    subagent: "运行子代理",
    webSearch: "搜索网络",
    imageView: "查看图片",
    imageGeneration: "生成图片",
    sleep: "等待",
    plan: "更新计划",
    contextCompaction: "压缩上下文",
    reviewMode: "执行审查",
  } as const;
  return labels[kind];
}

function operationStatusLabel(
  status: Extract<OutputEvent, { type: "operation.updated" }>["operation"]["status"],
): string {
  const labels = {
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    declined: "已拒绝",
  } as const;
  return labels[status];
}

function turnStatusLabel(
  status: Extract<OutputEvent, { type: "turn.completed" }>["status"],
): string {
  const labels = {
    completed: "已完成",
    interrupted: "已中断",
    failed: "失败",
    inProgress: "运行中",
  } as const;
  return labels[status];
}

function threadStatusLabel(status: string): string {
  return status === "active"
    ? "运行中"
    : status === "idle"
      ? "空闲"
      : "未知";
}

function mcpStatusLabel(
  status: Extract<OutputEvent, { type: "mcp.status.updated" }>["status"],
): string {
  const labels = {
    starting: "启动中",
    ready: "已就绪",
    failed: "启动失败",
    cancelled: "已取消",
  } as const;
  return labels[status];
}
