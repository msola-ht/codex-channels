import { randomBytes } from "node:crypto";

import type {
  InteractionDecision,
  InteractionPort,
  InteractionRequest,
} from "../../approval/index.js";
import type { ConversationTarget } from "../../conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../../policy/index.js";
import type { Logger } from "pino";
import {
  renderFeishuApprovalCard,
  renderFeishuApprovalOutcomeCard,
  type FeishuApprovalAction,
  type FeishuCardDocument,
} from "./approval-card.js";
import type { FeishuCardAction } from "./card-action.js";
import {
  renderFeishuInputCard,
  renderFeishuInputOutcomeCard,
  supportsFeishuInputRequest,
} from "./input-card.js";

interface FeishuInteractionDelivery {
  deliverCard(
    chatId: string,
    card: FeishuCardDocument,
  ): Promise<string>;
  updateCard(
    chatId: string,
    messageId: string,
    card: FeishuCardDocument,
  ): Promise<void>;
}

interface PendingInteraction {
  requestId: string;
  target: ConversationTarget;
  actorId: string;
  request: InteractionRequest;
  resolve(decision: InteractionDecision): void;
  timer: NodeJS.Timeout;
  messageId: string;
}

const maximumConcurrentInteractions = 100;

export type FeishuCardActionResult =
  | "accepted"
  | "invalid"
  | "stale";

export class FeishuInteractionPort implements InteractionPort {
  private readonly pendingByToken = new Map<string, PendingInteraction>();
  private readonly tokenByRequest = new Map<string, string>();
  private readonly resolvedBeforePending = new Set<string>();
  private readonly preparations = new Set<Promise<string | undefined>>();
  private readonly preparationCancellations = new Set<() => void>();
  private readonly statusUpdates = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly delivery?: FeishuInteractionDelivery,
    private readonly actorRegistry?: ConversationActorRegistry,
    private readonly access?: SurfaceAccessPolicy,
    private readonly logger?: Logger,
  ) {}

  async request(
    target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    if (
      request.type !== "approval"
      && !supportsFeishuInputRequest(request)
    ) {
      return timeoutDecision(request);
    }
    return this.requestInteraction(target, request);
  }

  resolved(requestId: string): void {
    const token = this.tokenByRequest.get(requestId);
    if (!token) {
      return;
    }
    const pending = this.pendingByToken.get(token);
    if (pending) {
      this.finish(
        token,
        timeoutDecision(pending.request),
        "已在其他客户端处理",
      );
    } else {
      this.resolvedBeforePending.add(token);
    }
  }

  cancelAll(outcome = "连接已断开"): void {
    for (const token of this.pendingByToken.keys()) {
      const pending = this.pendingByToken.get(token);
      if (!pending) {
        continue;
      }
      this.finish(
        token,
        timeoutDecision(pending.request),
        outcome,
      );
    }
  }

  stopForActor(target: ConversationTarget, actorId: string): boolean {
    const token = [...this.pendingByToken.entries()]
      .reverse()
      .find(([, pending]) =>
        pending.target.surface === target.surface
        && pending.target.accountId === target.accountId
        && pending.target.conversationId === target.conversationId
        && pending.actorId === actorId
      )?.[0];
    if (!token) {
      return false;
    }
    const pending = this.pendingByToken.get(token);
    if (!pending) {
      return false;
    }
    this.finish(
      token,
      timeoutDecision(pending.request),
      "已停止",
    );
    return true;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const cancel of this.preparationCancellations) {
        cancel();
      }
      this.preparationCancellations.clear();
    }
    this.cancelAll("Gateway 已停止");
    this.resolvedBeforePending.clear();
    await waitAtMost(Promise.allSettled([...this.preparations]), 5_000);
    await waitAtMost(Promise.allSettled([...this.statusUpdates]), 5_000);
  }

  handleCardAction(action: FeishuCardAction): FeishuCardActionResult {
    if (this.closed) {
      return "stale";
    }
    const token = action.value.interaction_token;
    const actionName = action.value.decision;
    if (!token || !actionName) {
      return "invalid";
    }
    const pending = this.pendingByToken.get(token);
    if (!pending) {
      return "stale";
    }
    if (
      action.tag !== "button"
      || action.chatId !== pending.target.conversationId
      || action.messageId !== pending.messageId
      || action.actorOpenId !== pending.actorId
      || !this.access?.isAllowed({
        target: pending.target,
        actorId: action.actorOpenId,
      })
    ) {
      return "invalid";
    }
    const mapped = mapInteractionDecision(
      pending.request,
      actionName,
      action.formValues,
    );
    if (!mapped) {
      return "invalid";
    }
    this.finish(token, mapped.decision, mapped.outcome);
    return "accepted";
  }

  private async requestInteraction(
    target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    if (
      this.closed
      || !this.delivery
      || !this.actorRegistry
      || !this.access
    ) {
      return timeoutDecision(request);
    }
    if (this.tokenByRequest.has(request.requestId)) {
      return timeoutDecision(request);
    }
    if (this.tokenByRequest.size >= maximumConcurrentInteractions) {
      return timeoutDecision(request);
    }
    const authorizedActors = this.actorRegistry.actors(target).filter(
      (actorId) => this.access!.isAllowed({ target, actorId }),
    );
    if (authorizedActors.length !== 1) {
      return timeoutDecision(request);
    }

    const token = randomBytes(18).toString("base64url");
    this.tokenByRequest.set(request.requestId, token);
    const preparation = this.prepareInteractionCard(
      target,
      request,
      token,
    );
    this.preparations.add(preparation);
    void preparation.then(
      () => this.preparations.delete(preparation),
      () => this.preparations.delete(preparation),
    );
    let cancelPreparation!: () => void;
    const cancelled = new Promise<{ type: "closed" }>((resolve) => {
      cancelPreparation = () => resolve({ type: "closed" });
    });
    this.preparationCancellations.add(cancelPreparation);
    const result = await Promise.race([
      preparation.then(
        (messageId) => ({
          type: "prepared" as const,
          messageId,
        }),
        (error: unknown) => ({
          type: "failed" as const,
          error,
        }),
      ),
      cancelled,
    ]);
    this.preparationCancellations.delete(cancelPreparation);
    if (result.type !== "prepared") {
      if (this.tokenByRequest.get(request.requestId) === token) {
        this.tokenByRequest.delete(request.requestId);
      }
      this.resolvedBeforePending.delete(token);
      if (result.type === "failed") {
        throw result.error;
      }
      return timeoutDecision(request);
    }
    const messageId = result.messageId;
    if (!messageId) {
      return timeoutDecision(request);
    }

    return new Promise<InteractionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(
          token,
          timeoutDecision(request),
          "请求已超时",
        );
      }, request.expiresInMs);
      timer.unref();
      this.pendingByToken.set(token, {
        requestId: request.requestId,
        target,
        actorId: authorizedActors[0]!,
        request,
        resolve,
        timer,
        messageId,
      });
      if (this.resolvedBeforePending.delete(token)) {
        this.finish(
          token,
          timeoutDecision(request),
          "已在其他客户端处理",
        );
      }
    });
  }

  private async prepareInteractionCard(
    target: ConversationTarget,
    request: InteractionRequest,
    token: string,
  ): Promise<string | undefined> {
    let messageId: string;
    try {
      messageId = await this.delivery!.deliverCard(
        target.conversationId,
        request.type === "approval"
          ? renderFeishuApprovalCard(request, token)
          : renderFeishuInputCard(request, token),
      );
    } catch (error) {
      this.logger?.warn(
        {
          ...interactionLogMetadata(target, request),
          errorType: error instanceof Error ? error.name : typeof error,
        },
        "飞书交互请求发送失败",
      );
      throw error;
    }
    this.logger?.info(
      {
        ...interactionLogMetadata(target, request),
        messageId,
      },
      "飞书交互请求已送达",
    );
    if (!this.closed) {
      return messageId;
    }
    this.tokenByRequest.delete(request.requestId);
    await this.updateCard(
      target,
      messageId,
      request,
      timeoutDecision(request),
      "Gateway 已停止",
    );
    return undefined;
  }

  private finish(
    token: string,
    decision: InteractionDecision,
    outcome: string,
  ): void {
    const pending = this.pendingByToken.get(token);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingByToken.delete(token);
    this.tokenByRequest.delete(pending.requestId);
    pending.resolve(decision);

    const statusUpdate = this.updateCard(
      pending.target,
      pending.messageId,
      pending.request,
      decision,
      outcome,
    );
    this.statusUpdates.add(statusUpdate);
    void statusUpdate.finally(() => this.statusUpdates.delete(statusUpdate));
  }

  private updateCard(
    target: ConversationTarget,
    messageId: string,
    request: InteractionRequest,
    decision: InteractionDecision,
    outcome: string,
  ): Promise<void> {
    return this.delivery!.updateCard(
      target.conversationId,
      messageId,
      request.type === "approval" && decision.type === "approval"
        ? renderFeishuApprovalOutcomeCard(request, decision, outcome)
        : request.type !== "approval" && decision.type !== "approval"
          ? renderFeishuInputOutcomeCard(request, decision, outcome)
          : renderMismatchedOutcomeCard(request.title),
    ).catch(() => {
      this.logger?.warn(
        {
          surface: target.surface,
          accountId: target.accountId,
          conversationId: target.conversationId,
          requestId: request.requestId,
        },
        "飞书交互卡片状态更新失败",
      );
    });
  }
}

function interactionLogMetadata(
  target: ConversationTarget,
  request: InteractionRequest,
): Record<string, unknown> {
  return {
    surface: target.surface,
    accountId: target.accountId,
    conversationId: target.conversationId,
    requestId: request.requestId,
    requestType: request.type,
    threadId: request.threadId,
    turnId: request.turnId,
  };
}

function mapInteractionDecision(
  request: InteractionRequest,
  action: string,
  formValues: Readonly<Record<string, string>> | undefined,
): {
  decision: InteractionDecision;
  outcome: string;
} | undefined {
  if (request.type === "approval") {
    return mapApprovalDecision(request, action);
  }
  if (action === "cancel") {
    return {
      decision: timeoutDecision(request),
      outcome: "已取消",
    };
  }
  if (request.type === "user-input") {
    return action === "submit"
      ? mapUserInputDecision(request, formValues)
      : undefined;
  }
  if (request.mode === "url") {
    return action === "complete"
      ? {
          decision: {
            type: "elicitation",
            action: "accept",
            content: null,
          },
          outcome: "已确认完成",
        }
      : undefined;
  }
  return action === "submit"
    ? mapElicitationFormDecision(formValues)
    : undefined;
}

function mapUserInputDecision(
  request: Extract<InteractionRequest, { type: "user-input" }>,
  formValues: Readonly<Record<string, string>> | undefined,
): {
  decision: Extract<InteractionDecision, { type: "user-input" }>;
  outcome: string;
} | undefined {
  if (!formValues) {
    return undefined;
  }
  const answers: Record<string, string[]> = {};
  for (const [index, question] of request.questions.entries()) {
    const answer = formValues[`q${index}`]?.trim();
    if (
      !answer
      || (
        question.options.length > 0
        && !question.allowOther
        && !question.options.includes(answer)
      )
    ) {
      return undefined;
    }
    answers[question.id] = [answer];
  }
  if (Object.keys(formValues).length !== request.questions.length) {
    return undefined;
  }
  return {
    decision: { type: "user-input", answers },
    outcome: "已提交回答",
  };
}

function mapElicitationFormDecision(
  formValues: Readonly<Record<string, string>> | undefined,
): {
  decision: Extract<InteractionDecision, { type: "elicitation" }>;
  outcome: string;
} | undefined {
  if (
    !formValues
    || Object.keys(formValues).length !== 1
    || typeof formValues.content !== "string"
  ) {
    return undefined;
  }
  try {
    const content = JSON.parse(formValues.content) as unknown;
    return {
      decision: {
        type: "elicitation",
        action: "accept",
        content,
      },
      outcome: "已提交表单",
    };
  } catch {
    return undefined;
  }
}

function timeoutDecision(request: InteractionRequest): InteractionDecision {
  if (request.type === "approval") {
    return { type: "approval", approved: false };
  }
  if (request.type === "user-input") {
    return { type: "user-input", answers: {} };
  }
  return { type: "elicitation", action: "cancel", content: null };
}

function renderMismatchedOutcomeCard(title: string): FeishuCardDocument {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "grey",
      title: {
        tag: "plain_text",
        content: "Codex 交互已取消",
      },
    },
    elements: [{
      tag: "div",
      text: {
        tag: "plain_text",
        content: title,
      },
    }],
  };
}

function mapApprovalDecision(
  request: Extract<InteractionRequest, { type: "approval" }>,
  action: string,
): {
  decision: Extract<InteractionDecision, { type: "approval" }>;
  outcome: string;
} | undefined {
  const typedAction = action as FeishuApprovalAction;
  switch (typedAction) {
    case "approve-once":
      return {
        decision: {
          type: "approval",
          approved: true,
          scope: "once",
        },
        outcome: "已批准一次",
      };
    case "approve-session":
      if (!request.allowSession) {
        return undefined;
      }
      return {
        decision: {
          type: "approval",
          approved: true,
          scope: "session",
        },
        outcome: request.networkApprovalContext
          ? `本会话已允许 ${request.networkApprovalContext.host}`
          : "已在本次会话中始终同意",
      };
    case "approve-execpolicy":
      if (!request.execPolicyAmendment) {
        return undefined;
      }
      return {
        decision: {
          type: "approval",
          approved: true,
          scope: "execpolicy",
        },
        outcome: "已保存命令前缀规则",
      };
    case "reject":
      return {
        decision: {
          type: "approval",
          approved: false,
        },
        outcome: "已拒绝",
      };
    default: {
      const match = /^approve-network-(\d+)$/u.exec(action);
      const amendment = match
        ? request.networkPolicyAmendments?.[Number(match[1])]
        : undefined;
      if (!amendment) {
        return undefined;
      }
      return {
        decision: {
          type: "approval",
          approved: true,
          scope: "networkpolicy",
          networkPolicyAmendment: amendment,
        },
        outcome: `已保存网络${amendment.action === "allow" ? "允许" : "拒绝"}规则`,
      };
    }
  }
}

async function waitAtMost<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
