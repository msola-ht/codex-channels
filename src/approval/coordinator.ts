import { randomUUID } from "node:crypto";

import { JsonRpcError, type RpcServerRequest } from "../codex-client/index.js";
import type { SessionRouter } from "../session-routing/index.js";
import type { InteractionDecision, InteractionPort } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

type AdditionalPermissionsResult =
  | { valid: true; detail?: string }
  | { valid: false };

export class ApprovalCoordinator {
  constructor(
    private readonly router: SessionRouter,
    private readonly interaction: InteractionPort,
    private readonly timeoutMs: number,
  ) {}

  async handle(request: RpcServerRequest): Promise<unknown> {
    const params = asRecord(request.params);
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    const itemId = stringValue(params.itemId);
    if (!threadId) {
      return this.safeDecline(request.method, params);
    }
    const target = this.router.targetForThread(threadId);
    if (!target) {
      return this.safeDecline(request.method, params);
    }

    const interactionId = String(request.id ?? randomUUID());
    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        if (!turnId || !itemId) {
          return this.safeDecline(request.method, params);
        }
        if (!offersOneTimeCommandApproval(params.availableDecisions)) {
          return { decision: "decline" };
        }
        const command = stringValue(params.command) ?? "未提供命令预览";
        const reason = stringValue(params.reason);
        const additionalPermissions = formatAdditionalPermissions(params.additionalPermissions);
        if (!additionalPermissions.valid) {
          return { decision: "decline" };
        }
        const decision = await this.interaction.request(target, {
          type: "approval",
          requestId: interactionId,
          kind: "command",
          threadId,
          turnId,
          itemId,
          title: "Codex 请求执行命令",
          detail: [reason, command, additionalPermissions.detail].filter(Boolean).join("\n\n"),
          expiresInMs: this.timeoutMs,
        });
        return { decision: isApproved(decision) ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        if (!turnId || !itemId) {
          return this.safeDecline(request.method, params);
        }
        const detail = stringValue(params.reason) ?? "Codex 请求修改文件";
        const decision = await this.interaction.request(target, {
          type: "approval",
          requestId: interactionId,
          kind: "file",
          threadId,
          turnId,
          itemId,
          title: "Codex 请求修改文件",
          detail,
          expiresInMs: this.timeoutMs,
        });
        return { decision: isApproved(decision) ? "accept" : "decline" };
      }
      case "item/permissions/requestApproval": {
        if (!turnId || !itemId) {
          return this.safeDecline(request.method, params);
        }
        const requested = asRecord(params.permissions);
        const decision = await this.interaction.request(target, {
          type: "approval",
          requestId: interactionId,
          kind: "permissions",
          threadId,
          turnId,
          itemId,
          title: "Codex 请求临时权限",
          detail: stringValue(params.reason) ?? JSON.stringify(requested, null, 2),
          expiresInMs: this.timeoutMs,
        });
        return {
          permissions: isApproved(decision)
            ? {
                ...(requested.network ? { network: requested.network } : {}),
                ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
              }
            : {},
          scope: "turn",
        };
      }
      case "item/tool/requestUserInput": {
        if (!turnId || !itemId) {
          return this.safeDecline(request.method, params);
        }
        const questions = Array.isArray(params.questions) ? params.questions : [];
        const normalized = questions.map((question) => {
          const record = asRecord(question);
          const options = Array.isArray(record.options)
            ? record.options
                .map((option) => stringValue(asRecord(option).label))
                .filter((option): option is string => Boolean(option))
            : [];
          return {
            id: stringValue(record.id) ?? randomUUID(),
            header: stringValue(record.header) ?? "问题",
            question: stringValue(record.question) ?? "请输入回答",
            options,
            allowOther: record.isOther === true,
            secret: record.isSecret === true,
          };
        });
        const decision = await this.interaction.request(target, {
          type: "user-input",
          requestId: interactionId,
          threadId,
          turnId,
          itemId,
          title: "Codex 需要补充信息",
          questions: normalized,
          expiresInMs:
            typeof params.autoResolutionMs === "number" ? params.autoResolutionMs : this.timeoutMs,
        });
        return { answers: decision.type === "user-input" ? mapAnswers(decision.answers) : {} };
      }
      case "mcpServer/elicitation/request": {
        const mode = params.mode === "url" ? "url" : "form";
        const url = stringValue(params.url);
        const decision = await this.interaction.request(target, {
          type: "elicitation",
          requestId: interactionId,
          threadId,
          turnId: turnId ?? null,
          title: `MCP ${stringValue(params.serverName) ?? "Server"} 请求输入`,
          message: stringValue(params.message) ?? "MCP Server 请求用户输入",
          mode,
          ...(mode === "url" && url ? { url } : {}),
          expiresInMs: this.timeoutMs,
        });
        if (decision.type !== "elicitation") {
          return { action: "cancel", content: null, _meta: null };
        }
        return { action: decision.action, content: decision.content, _meta: null };
      }
      default:
        throw new JsonRpcError(-32601, `不支持的 App Server 请求：${request.method}`);
    }
  }

  resolved(requestId: string | number): void {
    this.interaction.resolved?.(String(requestId));
  }

  private safeDecline(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" };
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "mcpServer/elicitation/request":
        return { action: "cancel", content: null, _meta: null };
      default:
        throw new JsonRpcError(-32601, `不支持的 App Server 请求：${method}`, params);
    }
  }
}

function isApproved(decision: InteractionDecision): boolean {
  return decision.type === "approval" && decision.approved;
}

function mapAnswers(answers: Record<string, string[]>): Record<string, { answers: string[] }> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
  );
}

function formatAdditionalPermissions(value: unknown): AdditionalPermissionsResult {
  if (value === undefined || value === null) {
    return { valid: true };
  }
  if (!isRecordWithOnly(value, ["network", "fileSystem"])) {
    return { valid: false };
  }

  const lines: string[] = [];
  if (value.network !== undefined && value.network !== null) {
    if (
      !isRecordWithOnly(value.network, ["enabled"])
      || !("enabled" in value.network)
      || (value.network.enabled !== null && typeof value.network.enabled !== "boolean")
    ) {
      return { valid: false };
    }
    lines.push(`网络：${value.network.enabled === true ? "开启" : value.network.enabled === false ? "关闭" : "不变"}`);
  }

  if (value.fileSystem !== undefined && value.fileSystem !== null) {
    const fileSystem = value.fileSystem;
    if (!isRecordWithOnly(fileSystem, ["read", "write", "globScanMaxDepth", "entries"])) {
      return { valid: false };
    }
    const read = permissionPaths(fileSystem.read);
    const write = permissionPaths(fileSystem.write);
    if (read === null || write === null) {
      return { valid: false };
    }
    if (read.length > 0) {
      lines.push(`读取：${read.join("、")}`);
    }
    if (write.length > 0) {
      lines.push(`写入：${write.join("、")}`);
    }
    if (
      fileSystem.globScanMaxDepth !== undefined
      && (
        typeof fileSystem.globScanMaxDepth !== "number"
        || !Number.isInteger(fileSystem.globScanMaxDepth)
        || fileSystem.globScanMaxDepth < 0
      )
    ) {
      return { valid: false };
    }
    if (fileSystem.globScanMaxDepth !== undefined) {
      lines.push(`Glob 扫描深度：${fileSystem.globScanMaxDepth}`);
    }
    if (fileSystem.entries !== undefined) {
      if (!Array.isArray(fileSystem.entries)) {
        return { valid: false };
      }
      for (const entry of fileSystem.entries) {
        if (
          !isRecordWithOnly(entry, ["path", "access"])
          || !["read", "write", "deny"].includes(String(entry.access))
        ) {
          return { valid: false };
        }
        const path = permissionEntryPath(entry.path);
        if (!path) {
          return { valid: false };
        }
        const access = entry.access === "read" ? "读取" : entry.access === "write" ? "写入" : "拒绝";
        lines.push(`${access}规则：${path}`);
      }
    }
  }

  return lines.length > 0
    ? { valid: true, detail: `额外权限：\n${lines.join("\n")}` }
    : { valid: true, detail: "额外权限：未请求扩展" };
}

function offersOneTimeCommandApproval(value: unknown): boolean {
  return value === undefined
    || value === null
    || (Array.isArray(value) && value.includes("accept"));
}

function permissionPaths(value: unknown): string[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

function permissionEntryPath(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  if (value.type === "path" && isRecordWithOnly(value, ["type", "path"])) {
    return stringValue(value.path);
  }
  if (value.type === "glob_pattern" && isRecordWithOnly(value, ["type", "pattern"])) {
    return stringValue(value.pattern);
  }
  if (value.type !== "special" || !isRecordWithOnly(value, ["type", "value"])) {
    return undefined;
  }
  return formatSpecialPath(value.value);
}

function formatSpecialPath(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return undefined;
  }
  const labels: Record<string, string> = {
    root: "根目录",
    minimal: "最小系统路径",
    project_roots: "项目目录",
    tmpdir: "系统临时目录",
    slash_tmp: "/tmp",
  };
  if (value.kind === "unknown") {
    if (!isRecordWithOnly(value, ["kind", "path", "subpath"]) || typeof value.path !== "string") {
      return undefined;
    }
    return typeof value.subpath === "string" ? `${value.path}/${value.subpath}` : value.path;
  }
  if (!(value.kind in labels) || !isRecordWithOnly(value, ["kind", "subpath"])) {
    return undefined;
  }
  if (value.subpath !== undefined && value.subpath !== null && typeof value.subpath !== "string") {
    return undefined;
  }
  return typeof value.subpath === "string"
    ? `${labels[value.kind]}/${value.subpath}`
    : labels[value.kind];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordWithOnly(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowedKeys.includes(key));
}
