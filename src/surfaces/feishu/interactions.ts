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
import { PendingInteractionRegistry, waitForInteractionPreparation } from "../pending-interaction-registry.js";
import { DeliveryReceipt } from "../delivery-receipt.js";
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
import type { ObserveFeishuCardCreation } from "./outbox-message-port.js";

interface FeishuInteractionDelivery {
  deliverCard(
    chatId: string,
    card: FeishuCardDocument,
    signal?: AbortSignal,
    observeCreation?: ObserveFeishuCardCreation,
  ): Promise<string>;
  updateCard(
    chatId: string,
    messageId: string,
    card: FeishuCardDocument,
    signal?: AbortSignal,
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
  private readonly preparations = new Set<Promise<unknown>>();
  private readonly statusUpdates = new Set<Promise<void>>();
  private readonly preparationDisposals = new Set<() => void>();
  private readonly statusAbort = new AbortController();
  private closePromise: Promise<void> | undefined;
  private cleanupClosed = false;
  private closed = false;

  constructor(
    private readonly delivery?: FeishuInteractionDelivery,
    private readonly actorRegistry?: ConversationActorRegistry,
    private readonly access?: SurfaceAccessPolicy,
    private readonly logger?: Logger,
    private readonly activity?: (target: ConversationTarget) => void,
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
    const resolution = this.pending.resolved(requestId, interactionOutcome.resolvedElsewhere);
    if (resolution?.pending) {
      this.finish(
        resolution.token,
        safeInteractionDecision(resolution.pending.request),
        resolution.pending.request.type === "user-input" && resolution.pending.request.asynchronous
          ? "问题已失效" : interactionOutcome.resolvedElsewhere,
      );
    }
  }

  cancelAll(outcome = "连接已断开"): void {
    this.pending.cancelPreparing(outcome);
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

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.cancelAll("Gateway 已停止");
    this.closePromise = this.drainClose();
    return this.closePromise;
  }

  private async drainClose(): Promise<void> {
    await waitAtMost(Promise.allSettled([...this.preparations]), 5_000);
    this.cleanupClosed = true;
    for (const dispose of this.preparationDisposals) dispose();
    this.preparationDisposals.clear();
    this.preparations.clear();
    await waitAtMost(Promise.allSettled([...this.statusUpdates]), 5_000);
    this.statusAbort.abort();
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
    try {
      this.activity?.(pending.target);
    } catch (error) {
      this.logger?.warn(
        {
          ...interactionLogMetadata(pending.target, pending.request),
          errorType: error instanceof Error ? error.name : typeof error,
        },
        "飞书交互活动刷新失败",
      );
    }
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
    if (!this.pending.reserve(request.requestId, token, () => this.delivery?.finishInteraction?.(request, safeInteractionDecision(request)))) {
      return safeInteractionDecision(request);
    }
    const signal = this.pending.signal(token);
    const cardPreparation = this.observePreparation(target, request, signal);
    const preparation = this.prepareInteractionCard(
      target,
      request,
      token,
      signal,
      cardPreparation.observe,
      cardPreparation.receive,
    );
    this.preparations.add(preparation);
    void preparation.then(
      () => { cardPreparation.settled(); this.preparations.delete(preparation); },
      () => { cardPreparation.settled(); this.preparations.delete(preparation); },
    );
    let messageId: Awaited<typeof preparation>;
    try {
      messageId = await waitForInteractionPreparation(signal, preparation);
    } catch (error) {
      const cancelled = signal.aborted;
      cardPreparation.invalidate();
      this.pending.release(request.requestId, token);
      if (!cancelled) throw error;
      return safeInteractionDecision(request);
    }
    if (!messageId) {
      cardPreparation.invalidate();
      this.pending.release(request.requestId, token);
      return safeInteractionDecision(request);
    }
    cardPreparation.receive(messageId);
    if (signal.aborted || this.closed || !this.access.isAllowed({ target, actorId: authorizedActors[0]! })) {
      cardPreparation.invalidate();
      this.pending.release(request.requestId, token);
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
        cardPreparation.invalidate();
        resolve(safeInteractionDecision(request));
      } else {
        cardPreparation.activate();
      }
    });
  }

  private async prepareInteractionCard(
    target: ConversationTarget,
    request: InteractionRequest,
    token: string,
    signal: AbortSignal,
    observeCreation: ObserveFeishuCardCreation,
    receive: (messageId: string) => void,
  ): Promise<string | undefined> {
    let messageId: string;
    try {
      this.delivery!.prepareInteraction?.(request);
      messageId = await this.delivery!.deliverCard(
        target.conversationId,
        request.type === "approval"
          ? renderFeishuApprovalCard(request, token)
          : renderFeishuInputCard(request, token),
        signal,
        observeCreation,
      );
      receive(messageId);
    } catch (error) {
      if (signal.aborted) return undefined;
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
    return messageId;
  }

  private observePreparation(target: ConversationTarget, request: InteractionRequest, signal: AbortSignal) {
    // Only preparation owns invalidation cleanup. Activation transfers ownership
    // to pending/finish, whose outcome must not be replaced by its release abort.
    const holder: { current: {
      target: ConversationTarget; request: InteractionRequest; messageId?: string;
      invalid: boolean; cleanupStarted: boolean; creationPending: boolean; preparationSettled: boolean;
    } | undefined } = {
      current: { target, request, invalid: false, cleanupStarted: false, creationPending: false, preparationSettled: false },
    };
    const cleanupOnce = (): void => {
      const state = holder.current;
      if (!state || !state.messageId || state.cleanupStarted || this.cleanupClosed) return;
      if (!state.invalid && !signal.aborted && !this.closed) return;
      state.cleanupStarted = true;
      const outcome = this.closed ? "Gateway 已停止"
        : signal.aborted && signal.reason instanceof Error ? signal.reason.message : "请求已失效";
      void this.updateCard(state.target, state.messageId, state.request, safeInteractionDecision(state.request), outcome);
      dispose();
    };
    const receive = (messageId: string): void => {
      if (!holder.current) return;
      holder.current.messageId = messageId;
      cleanupOnce();
    };
    const dispose = (): void => {
      signal.removeEventListener("abort", cleanupOnce);
      holder.current = undefined;
      this.preparationDisposals.delete(dispose);
    };
    const disposeIfFinished = (): void => {
      const state = holder.current;
      if (state?.preparationSettled && !state.creationPending && (state.invalid || signal.aborted)) dispose();
    };
    signal.addEventListener("abort", cleanupOnce);
    this.preparationDisposals.add(dispose);
    return {
      receive,
      observe: (creation: Promise<string>): void => {
        if (holder.current) holder.current.creationPending = true;
        const observed = creation.then(receive, () => {}).then(() => {
          if (holder.current) holder.current.creationPending = false;
          disposeIfFinished();
        });
        this.preparations.add(observed);
        void observed.then(() => this.preparations.delete(observed));
      },
      invalidate: (): void => {
        if (holder.current) holder.current.invalid = true;
        cleanupOnce();
        disposeIfFinished();
      },
      activate: dispose,
      settled: (): void => {
        if (holder.current) holder.current.preparationSettled = true;
        disposeIfFinished();
      },
    };
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

    void this.updateCard(
      pending.target,
      pending.messageId,
      pending.request,
      decision,
      outcome,
    );
  }

  private updateCard(
    target: ConversationTarget,
    messageId: string,
    request: InteractionRequest,
    decision: InteractionDecision,
    outcome: string,
  ): Promise<void> {
    if (this.cleanupClosed) return Promise.resolve();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.statusAbort.signal]);
    let onAbort!: () => void;
    const cancelled = new Promise<void>((resolve) => { onAbort = resolve; });
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 5_000);
    timer.unref();
    // Status cleanup has its own budget and must survive a failed creation receipt.
    const update = Promise.resolve().then(() => DeliveryReceipt.without(() => this.delivery!.updateCard(
      target.conversationId,
      messageId,
      request.type === "approval" && decision.type === "approval"
        ? renderFeishuApprovalOutcomeCard(request, decision, outcome)
        : request.type !== "approval" && decision.type !== "approval"
          ? renderFeishuInputOutcomeCard(request, decision, outcome)
          : renderMismatchedOutcomeCard(request.title),
      signal,
    ))).catch(() => {
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
    const statusUpdate = Promise.race([update, cancelled]).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      this.statusUpdates.delete(statusUpdate);
    });
    this.statusUpdates.add(statusUpdate);
    return statusUpdate;
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
  if (action === "mcp-decline") {
    return {
      decision: { type: "elicitation", action: "decline", content: null },
      outcome: interactionOutcome.mcpDeclined,
    };
  }
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
