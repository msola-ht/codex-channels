import { randomUUID } from "node:crypto";

import type { RpcServerRequest } from "../codex-client/json-rpc.js";
import { JsonRpcError } from "../codex-client/json-rpc.js";
import type { SessionRouter } from "../session-routing/router.js";
import type { InteractionDecision, InteractionPort } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

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
        const command = stringValue(params.command) ?? "未提供命令预览";
        const reason = stringValue(params.reason);
        const decision = await this.interaction.request(target, {
          type: "approval",
          requestId: interactionId,
          kind: "command",
          threadId,
          turnId,
          itemId,
          title: "Codex 请求执行命令",
          detail: [reason, command].filter(Boolean).join("\n\n"),
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
