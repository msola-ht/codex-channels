import { randomBytes } from "node:crypto";

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
import {
  interactionCancelledTitle,
  interactionOutcome,
} from "../interaction-copy.js";
import { surfaceErrorMetadata } from "../error-metadata.js";
import { PendingInteractionRegistry } from "../pending-interaction-registry.js";
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
  prepareInteraction?(request: InteractionRequest): void;
  finishInteraction?(request: InteractionRequest, decision: InteractionDecision): void;
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

export type FeishuCardActionResult =
  | "accepted"
  | "invalid"
  | "stale";

export class FeishuInteractionPort implements InteractionPort {
  private readonly pending = new PendingInteractionRegistry<PendingInteraction>();
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
      return safeInteractionDecision(request);
    }
    return this.requestInteraction(target, request);
  }

  resolved(requestId: string): void {
    const resolution = this.pending.resolved(requestId);
    if (resolution?.pending) {
      this.finish(
        resolution.token,
        safeInteractionDecision(resolution.pending.request),
        interactionOutcome.resolvedElsewhere,
      );
    }
  }

  cancelAll(outcome = "连接已断开"): void {
    for (const [token, pending] of this.pending.entries()) {
      this.finish(
        token,
        safeInteractionDecision(pending.request),
        outcome,
      );
    }
  }

  stopForActor(target: ConversationTarget, actorId: string): boolean {
    const token = this.pending.newest(
      (pending) =>
        pending.target.surface === target.surface
        && pending.target.accountId === target.accountId
        && pending.target.conversationId === target.conversationId
        && pending.actorId === actorId,
    )?.[0];
    if (!token) {
      return false;
    }
    const pending = this.pending.get(token);
    if (!pending) {
      return false;
    }
    this.finish(
      token,
      safeInteractionDecision(pending.request),
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
    this.pending.clearPreparingResolutions();
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
    const pending = this.pending.get(token);
    if (!pending) {
      return "stale";
    }
    if (
      !supportedActionTag(pending.request, action)
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
      return safeInteractionDecision(request);
    }
    const authorizedActors = this.actorRegistry.actors(target).filter(
      (actorId) => this.access!.isAllowed({ target, actorId }),
    );
    if (authorizedActors.length !== 1) {
      return safeInteractionDecision(request);
    }

    const token = randomBytes(18).toString("base64url");
    if (!this.pending.reserve(request.requestId, token)) {
      return safeInteractionDecision(request);
    }
    this.delivery.prepareInteraction?.(request);
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
      this.pending.release(request.requestId, token);
      if (result.type === "failed") {
        throw result.error;
      }
      return safeInteractionDecision(request);
    }
    const messageId = result.messageId;
    if (!messageId) {
      return safeInteractionDecision(request);
    }

    return new Promise<InteractionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(
          token,
          safeInteractionDecision(request),
          interactionOutcome.timedOut,
        );
      }, request.expiresInMs);
      timer.unref();
      const activation = this.pending.activate(token, {
        requestId: request.requestId,
        target,
        actorId: authorizedActors[0]!,
        request,
        resolve,
        timer,
        messageId,
      });
      if (activation === "missing") {
        clearTimeout(timer);
        resolve(safeInteractionDecision(request));
      } else if (activation === "resolved-before-active") {
        this.finish(
          token,
          safeInteractionDecision(request),
          interactionOutcome.resolvedElsewhere,
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
          ...surfaceErrorMetadata(error),
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
    this.pending.release(request.requestId, token);
    await this.updateCard(
      target,
      messageId,
      request,
      safeInteractionDecision(request),
      "Gateway 已停止",
    );
    return undefined;
  }

  private finish(
    token: string,
    decision: InteractionDecision,
    outcome: string,
  ): void {
    const pending = this.pending.take(token);
    if (!pending) {
      return;
    }
    this.delivery?.finishInteraction?.(pending.request, decision);
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
      decision: safeInteractionDecision(request),
      outcome: interactionOutcome.cancelled,
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
          outcome: interactionOutcome.completed,
        }
      : undefined;
  }
  if (request.mode === "tool-approval") {
    return mapMcpToolApprovalDecision(request, action);
  }
  return action === "submit"
    ? mapElicitationFormDecision(formValues)
    : undefined;
}

function mapMcpToolApprovalDecision(
  request: Extract<InteractionRequest, { type: "elicitation" }>,
  action: string,
): {
  decision: Extract<InteractionDecision, { type: "elicitation" }>;
  outcome: string;
} | undefined {
  const scope = action === "mcp-once"
    ? "once"
    : action === "mcp-session" && request.toolApproval?.allowSession
      ? "session"
      : action === "mcp-always" && request.toolApproval?.allowAlways
        ? "always"
        : undefined;
  if (!scope) {
    return undefined;
  }
  return {
    decision: {
      type: "elicitation",
      action: "accept",
      content: null,
      scope,
    },
    outcome: scope === "session"
      ? interactionOutcome.mcpAllowedSession
      : scope === "always"
        ? interactionOutcome.mcpAllowedAlways
        : interactionOutcome.mcpAllowedOnce,
  };
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
  const allowedFields = new Set<string>();
  for (const [index, question] of request.questions.entries()) {
    let answer: string | undefined;
    if (question.options.length > 0) {
      const choiceField = `q${index}_choice`;
      const otherField = `q${index}_other`;
      allowedFields.add(choiceField);
      const choice = formValues[choiceField]?.trim();
      const other = question.allowOther
        ? formValues[otherField]?.trim()
        : undefined;
      if (question.allowOther) {
        allowedFields.add(otherField);
      }
      if (other) {
        answer = other;
      } else if (choice && question.options.includes(choice)) {
        answer = choice;
      }
    } else {
      const textField = `q${index}_text`;
      allowedFields.add(textField);
      answer = formValues[textField]?.trim();
    }
    if (
      !answer
    ) {
      return undefined;
    }
    answers[question.id] = [answer];
  }
  if (Object.keys(formValues).some((field) => !allowedFields.has(field))) {
    return undefined;
  }
  return {
    decision: { type: "user-input", answers },
    outcome: interactionOutcome.answered,
  };
}

function supportedActionTag(
  request: InteractionRequest,
  action: FeishuCardAction,
): boolean {
  if (action.tag === "button") {
    return true;
  }
  return request.type !== "approval"
    && action.tag === "form_submit"
    && action.value.decision === "submit";
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
      outcome: interactionOutcome.formSubmitted,
    };
  } catch {
    return undefined;
  }
}

function renderMismatchedOutcomeCard(title: string): FeishuCardDocument {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "grey",
      title: {
        tag: "plain_text",
        content: interactionCancelledTitle,
      },
    },
    body: {
      elements: [{
        tag: "div",
        text: {
          tag: "plain_text",
          content: title,
        },
      }],
    },
  };
}

function mapApprovalDecision(
  request: Extract<InteractionRequest, { type: "approval" }>,
  action: string,
): {
  decision: Extract<InteractionDecision, { type: "approval" }>;
  outcome: string;
} | undefined {
  const choice = feishuApprovalChoice(action);
  return choice ? resolveApprovalChoice(request, choice) : undefined;
}

function feishuApprovalChoice(
  action: string,
): ApprovalChoice | undefined {
  const typedAction = action as FeishuApprovalAction;
  switch (typedAction) {
    case "approve-once":
      return { type: "once" };
    case "approve-session":
      return { type: "session" };
    case "approve-execpolicy":
      return { type: "execpolicy" };
    case "reject":
      return { type: "reject" };
    default: {
      const match = /^approve-network-(\d+)$/u.exec(action);
      return match
        ? { type: "networkpolicy", amendmentIndex: Number(match[1]) }
        : undefined;
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
