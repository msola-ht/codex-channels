import { randomBytes } from "node:crypto";

import type { Logger } from "pino";

import {
  resolveApprovalChoice,
  safeInteractionDecision,
  type ApprovalChoice,
  type InteractionDecision,
  type InteractionPort,
  type InteractionRequest,
} from "../../approval/index.js";
import type { ConversationTarget } from "../../conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../../policy/index.js";
import { sanitizeWeixinMarkdownText } from "./operation-format.js";

type ApprovalRequest = Extract<InteractionRequest, { type: "approval" }>;

interface WeixinInteractionDelivery {
  deliverText(target: ConversationTarget, text: string): Promise<void>;
  deliverTextSequence(
    target: ConversationTarget,
    texts: readonly string[],
  ): Promise<void>;
}

interface PendingApproval {
  requestId: string;
  target: ConversationTarget;
  actorId: string;
  request: ApprovalRequest;
  resolve(decision: InteractionDecision): void;
  timer: NodeJS.Timeout;
}

export type WeixinApprovalTextResult = "handled" | "not-command";

const maximumConcurrentInteractions = 100;
const maximumPromptCharacters = 16_000;
const maximumPromptMessageCharacters = 4_000;
const interactionTokenPattern = /^[A-Za-z0-9_-]{8,64}$/;

export class WeixinInteractionPort implements InteractionPort {
  private readonly pendingByToken = new Map<string, PendingApproval>();
  private readonly tokenByRequest = new Map<string, string>();
  private closed = false;

  constructor(
    private readonly delivery?: WeixinInteractionDelivery,
    private readonly actorRegistry?: ConversationActorRegistry,
    private readonly access?: SurfaceAccessPolicy,
    private readonly logger?: Logger,
    private readonly createToken = () => randomBytes(12).toString("base64url"),
  ) {}

  request(
    target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    if (request.type !== "approval") {
      return Promise.resolve(safeInteractionDecision(request));
    }
    return this.requestApproval(target, request);
  }

  async handleText(
    target: ConversationTarget,
    actorId: string,
    text: string,
  ): Promise<WeixinApprovalTextResult> {
    const command = parseApprovalCommand(text);
    if (command === null) {
      return "not-command";
    }
    if (command === "invalid") {
      await this.notify(target, "审批命令格式无效，请复制审批提示中的完整命令。");
      return "handled";
    }
    const pending = this.pendingByToken.get(command.token);
    if (!pending) {
      await this.notify(target, "审批请求不存在、已过期或已处理。");
      return "handled";
    }
    if (
      this.closed
      || !sameTarget(target, pending.target)
      || actorId !== pending.actorId
      || !this.access?.isAllowed({ target, actorId })
    ) {
      await this.notify(target, "审批命令与当前账号或会话不匹配。");
      return "handled";
    }
    const choice = approvalChoice(command);
    const resolution = choice === undefined
      ? undefined
      : resolveApprovalChoice(pending.request, choice);
    if (!resolution) {
      await this.notify(target, "该审批选项未由当前请求提供。");
      return "handled";
    }
    await this.finish(
      command.token,
      resolution.decision,
      `Codex 审批已处理：${resolution.outcome}。`,
    );
    return "handled";
  }

  resolved(requestId: string): void {
    const token = this.tokenByRequest.get(requestId);
    if (!token) {
      return;
    }
    const pending = this.pendingByToken.get(token);
    if (!pending) {
      return;
    }
    void this.finish(
      token,
      safeInteractionDecision(pending.request),
      "Codex 审批已在其他客户端处理。",
    );
  }

  cancelAll(outcome = "Gateway 已停止"): void {
    this.closed = true;
    for (const [token, pending] of this.pendingByToken) {
      void this.finish(
        token,
        safeInteractionDecision(pending.request),
        `Codex 审批已取消：${outcome}。`,
      );
    }
  }

  private async requestApproval(
    target: ConversationTarget,
    request: ApprovalRequest,
  ): Promise<InteractionDecision> {
    if (
      this.closed
      || !this.delivery
      || !this.actorRegistry
      || !this.access
      || this.tokenByRequest.has(request.requestId)
      || this.tokenByRequest.size >= maximumConcurrentInteractions
    ) {
      return safeInteractionDecision(request);
    }
    const actors = this.actorRegistry.actors(target).filter(
      (actorId) => this.access!.isAllowed({ target, actorId }),
    );
    if (actors.length !== 1) {
      return safeInteractionDecision(request);
    }
    const token = this.createToken();
    if (
      !interactionTokenPattern.test(token)
      || this.pendingByToken.has(token)
    ) {
      return safeInteractionDecision(request);
    }
    const prompt = renderApprovalPrompt(request, token);
    if (
      prompt.reduce((length, message) => length + message.length, 0)
        > maximumPromptCharacters
    ) {
      await this.notify(target, "审批详情过长，微信端已安全拒绝本次请求。");
      return safeInteractionDecision(request);
    }

    let resolveDecision!: (decision: InteractionDecision) => void;
    const decision = new Promise<InteractionDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const timer = setTimeout(() => {
      void this.finish(
        token,
        safeInteractionDecision(request),
        "Codex 审批请求已超时并拒绝。",
      );
    }, request.expiresInMs);
    timer.unref();
    this.tokenByRequest.set(request.requestId, token);
    this.pendingByToken.set(token, {
      requestId: request.requestId,
      target,
      actorId: actors[0]!,
      request,
      resolve: resolveDecision,
      timer,
    });

    try {
      await this.delivery.deliverTextSequence(target, prompt);
    } catch (error) {
      await this.finish(
        token,
        safeInteractionDecision(request),
      );
      this.logger?.warn(
        {
          requestId: request.requestId,
          requestType: request.type,
          threadId: request.threadId,
          turnId: request.turnId,
          surface: target.surface,
          accountId: target.accountId,
          conversationId: target.conversationId,
          errorType: error instanceof Error ? error.name : typeof error,
        },
        "微信审批请求发送失败",
      );
      throw error;
    }
    this.logger?.info(
      {
        requestId: request.requestId,
        requestType: request.type,
        threadId: request.threadId,
        turnId: request.turnId,
        surface: target.surface,
        accountId: target.accountId,
        conversationId: target.conversationId,
      },
      "微信审批请求已送达",
    );
    return decision;
  }

  private async finish(
    token: string,
    decision: InteractionDecision,
    outcome?: string,
  ): Promise<void> {
    const pending = this.pendingByToken.get(token);
    if (!pending) {
      return;
    }
    this.pendingByToken.delete(token);
    if (this.tokenByRequest.get(pending.requestId) === token) {
      this.tokenByRequest.delete(pending.requestId);
    }
    clearTimeout(pending.timer);
    pending.resolve(decision);
    if (outcome !== undefined) {
      await this.notify(pending.target, outcome);
    }
  }

  private async notify(
    target: ConversationTarget,
    text: string,
  ): Promise<void> {
    try {
      await this.delivery?.deliverText(target, text);
    } catch (error) {
      this.logger?.warn(
        {
          surface: target.surface,
          accountId: target.accountId,
          conversationId: target.conversationId,
          errorType: error instanceof Error ? error.name : typeof error,
        },
        "微信审批状态发送失败",
      );
    }
  }
}

type ParsedApprovalCommand =
  | { action: "deny"; token: string }
  | {
      action: "approve";
      token: string;
      scope: "once" | "session" | "rule";
    }
  | {
      action: "approve";
      token: string;
      scope: "network";
      amendmentNumber: number;
    };

function parseApprovalCommand(
  text: string,
): ParsedApprovalCommand | "invalid" | null {
  const normalized = text.trim();
  if (
    !/^\/(?:批准一次|批准会话|保存命令规则|保存网络规则|拒绝)(?:\s|$)/u
      .test(normalized)
  ) {
    return null;
  }
  const parts = normalized.split(/\s+/u);
  if (
    parts[0] === "/拒绝"
    && parts.length === 2
    && interactionTokenPattern.test(parts[1]!)
  ) {
    return { action: "deny", token: parts[1]! };
  }
  if (
    !interactionTokenPattern.test(parts[1] ?? "")
  ) {
    return "invalid";
  }
  if (
    parts.length === 2
    && (
      parts[0] === "/批准一次"
      || parts[0] === "/批准会话"
      || parts[0] === "/保存命令规则"
    )
  ) {
    return {
      action: "approve",
      token: parts[1]!,
      scope: parts[0] === "/批准一次"
        ? "once"
        : parts[0] === "/批准会话" ? "session" : "rule",
    };
  }
  if (
    parts.length === 3
    && parts[0] === "/保存网络规则"
    && /^[1-9]\d*$/u.test(parts[2]!)
  ) {
    return {
      action: "approve",
      token: parts[1]!,
      scope: "network",
      amendmentNumber: Number(parts[2]),
    };
  }
  return "invalid";
}

function approvalChoice(
  command: ParsedApprovalCommand,
): ApprovalChoice | undefined {
  if (command.action === "deny") {
    return { type: "reject" };
  }
  switch (command.scope) {
    case "once":
      return { type: "once" };
    case "session":
      return { type: "session" };
    case "rule":
      return { type: "execpolicy" };
    case "network":
      return Number.isSafeInteger(command.amendmentNumber)
        ? {
            type: "networkpolicy",
            amendmentIndex: command.amendmentNumber - 1,
          }
        : undefined;
  }
}

function renderApprovalPrompt(
  request: ApprovalRequest,
  token: string,
): readonly string[] {
  const choices = [
    { label: "批准一次", command: `/批准一次 ${token}` },
    ...(request.allowSession
      ? [{ label: "批准当前会话", command: `/批准会话 ${token}` }]
      : []),
    ...(request.execPolicyAmendment
      ? [{ label: "保存命令规则", command: `/保存命令规则 ${token}` }]
      : []),
    ...(request.networkPolicyAmendments ?? []).map(
      (_amendment, index) => ({
        label: `保存网络规则 ${index + 1}`,
        command: `/保存网络规则 ${token} ${index + 1}`,
      }),
    ),
    { label: "拒绝", command: `/拒绝 ${token}` },
  ];
  return [
    [
      sanitizeWeixinMarkdownText(request.title),
      "审批内容（仅供核对，不是操作命令）：",
      sanitizeWeixinMarkdownText(request.detail),
      `有效期：${Math.max(1, Math.ceil(request.expiresInMs / 1_000))} 秒`,
      "请完整复制并发送以下一条命令。",
      "普通数字、“同意”或修改后的命令不会批准。",
    ].join("\n\n"),
    ...packApprovalChoiceMessages(choices),
  ];
}

function packApprovalChoiceMessages(
  choices: readonly { label: string; command: string }[],
): string[] {
  const messages: string[] = [];
  let current = "";
  for (const choice of choices) {
    const block = [
      choice.label,
      `\`\`\`text\n${choice.command}\n\`\`\``,
    ].join("\n\n");
    const candidate = current.length === 0 ? block : `${current}\n\n${block}`;
    if (
      current.length > 0
      && candidate.length > maximumPromptMessageCharacters
    ) {
      messages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    messages.push(current);
  }
  return messages;
}

function sameTarget(
  left: ConversationTarget,
  right: ConversationTarget,
): boolean {
  return left.surface === right.surface
    && left.accountId === right.accountId
    && left.conversationId === right.conversationId;
}
