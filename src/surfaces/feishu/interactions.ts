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

interface PendingApproval {
  requestId: string;
  target: ConversationTarget;
  actorId: string;
  request: Extract<InteractionRequest, { type: "approval" }>;
  resolve(decision: InteractionDecision): void;
  timer: NodeJS.Timeout;
  messageId: string;
}

export type FeishuCardActionResult =
  | "accepted"
  | "invalid"
  | "stale";

export class FeishuInteractionPort implements InteractionPort {
  private readonly pendingByToken = new Map<string, PendingApproval>();
  private readonly tokenByRequest = new Map<string, string>();
  private readonly resolvedBeforePending = new Set<string>();
  private readonly preparations = new Set<Promise<string | undefined>>();
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
    switch (request.type) {
      case "user-input":
        return { type: "user-input", answers: {} };
      case "elicitation":
        return {
          type: "elicitation",
          action: "cancel",
          content: null,
        };
      case "approval":
        return this.requestApproval(target, request);
    }
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
        { type: "approval", approved: false },
        "已在其他客户端处理",
      );
    } else {
      this.resolvedBeforePending.add(token);
    }
  }

  cancelAll(outcome = "连接已断开"): void {
    for (const token of this.pendingByToken.keys()) {
      this.finish(
        token,
        { type: "approval", approved: false },
        outcome,
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
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
    const mapped = mapApprovalDecision(pending.request, actionName);
    if (!mapped) {
      return "invalid";
    }
    this.finish(token, mapped.decision, mapped.outcome);
    return "accepted";
  }

  private async requestApproval(
    target: ConversationTarget,
    request: Extract<InteractionRequest, { type: "approval" }>,
  ): Promise<InteractionDecision> {
    if (
      this.closed
      || !this.delivery
      || !this.actorRegistry
      || !this.access
    ) {
      return { type: "approval", approved: false };
    }
    const authorizedActors = this.actorRegistry.actors(target).filter(
      (actorId) => this.access!.isAllowed({ target, actorId }),
    );
    if (authorizedActors.length !== 1) {
      return { type: "approval", approved: false };
    }

    const token = randomBytes(18).toString("base64url");
    this.tokenByRequest.set(request.requestId, token);
    const preparation = this.prepareApprovalCard(
      target,
      request,
      token,
    );
    this.preparations.add(preparation);
    let messageId: string | undefined;
    try {
      messageId = await preparation;
    } catch (error) {
      if (this.tokenByRequest.get(request.requestId) === token) {
        this.tokenByRequest.delete(request.requestId);
      }
      this.resolvedBeforePending.delete(token);
      throw error;
    } finally {
      this.preparations.delete(preparation);
    }
    if (!messageId) {
      return { type: "approval", approved: false };
    }

    return new Promise<InteractionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(
          token,
          { type: "approval", approved: false },
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
          { type: "approval", approved: false },
          "已在其他客户端处理",
        );
      }
    });
  }

  private async prepareApprovalCard(
    target: ConversationTarget,
    request: Extract<InteractionRequest, { type: "approval" }>,
    token: string,
  ): Promise<string | undefined> {
    const messageId = await this.delivery!.deliverCard(
      target.conversationId,
      renderFeishuApprovalCard(request, token),
    );
    if (!this.closed) {
      return messageId;
    }
    this.tokenByRequest.delete(request.requestId);
    await this.updateCard(
      target,
      messageId,
      request,
      { type: "approval", approved: false },
      "Gateway 已停止",
    );
    return undefined;
  }

  private finish(
    token: string,
    decision: Extract<InteractionDecision, { type: "approval" }>,
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
    request: Extract<InteractionRequest, { type: "approval" }>,
    decision: Extract<InteractionDecision, { type: "approval" }>,
    outcome: string,
  ): Promise<void> {
    return this.delivery!.updateCard(
      target.conversationId,
      messageId,
      renderFeishuApprovalOutcomeCard(
        request,
        decision,
        outcome,
      ),
    ).catch(() => {
      this.logger?.warn(
        {
          surface: target.surface,
          accountId: target.accountId,
          conversationId: target.conversationId,
          requestId: request.requestId,
        },
        "飞书审批卡片状态更新失败",
      );
    });
  }
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
