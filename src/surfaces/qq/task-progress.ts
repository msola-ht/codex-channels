import type { ConversationTarget, OperationUpdate, OutputEvent } from "../../conversation-core/index.js";
import {
  createSubagentCompletedPresentation, createSubagentContactedPresentation,
  createSubagentStartedPresentation, createTurnReasoningPresentation,
  escapeLifecycleLiteral, renderPlainLifecyclePresentation, renderStructuredLifecyclePresentation,
  type LifecyclePresentation, type LifecyclePresentationField,
} from "../lifecycle-presentation.js";
import {
  compactOperationDetail, operationMetadata, operationStatus, operationTitle,
  redactOperationDetail, shouldDisplayOperation,
} from "../operation-presentation.js";
import { createPlanPresentation, PlanProgressTracker } from "../plan-presentation.js";
import { TurnRetryMessages } from "../turn-retry-presentation.js";
import type { OperationUpdateDisplay } from "../types.js";
import { qqLiteralMarkdown } from "./message-markdown.js";

export type QqTaskProgressEvent = Extract<OutputEvent, {
  type: "turn.retry" | "turn.reasoning" | "plan.updated" | "subagent.spawned"
    | "subagent.contacted" | "subagent.completed" | "operation.updated";
}>;

type Presentation = { text: string; markdown: string };
type Send = (presentation: Presentation) => Promise<void>;
type PreparedProgress = (send: Send) => Promise<void>;

interface TurnPresentationState {
  targetKey: string;
  threadId: string;
  turnId: string;
  active: boolean;
  reasoningAttempted: boolean;
  planObservations: number;
  planDisplayed: boolean;
  plan: PlanProgressTracker;
  markdownPlan: PlanProgressTracker;
  retry: TurnRetryMessages<void>;
}

interface ProgressState {
  event: QqTaskProgressEvent;
  targetKey: string;
  turn: TurnPresentationState | undefined;
  active: boolean;
  attempted: boolean;
  sending: Promise<void> | undefined;
}

const maximumTurns = 128;
const maximumPresentations = 1_024;

export function isQqTaskProgressEvent(event: OutputEvent): event is QqTaskProgressEvent {
  switch (event.type) {
    case "turn.retry":
    case "turn.reasoning":
    case "plan.updated":
    case "subagent.spawned":
    case "subagent.contacted": return true;
    case "subagent.completed": return event.parentTurnId !== undefined;
    case "operation.updated":
      return event.operation.kind !== "contextCompaction"
        && !(event.operation.kind === "imageGeneration" && event.operation.status === "completed"
          && (event.operation.imagePath !== undefined || event.operation.imageFileId !== undefined
            || event.operation.imageDeliveryUnavailable === true));
    default: return false;
  }
}

/** Disposable presentation state. QqMessages owns authorization, budgets and ordering. */
export class QqTaskProgress {
  private readonly turns = new Map<string, TurnPresentationState>();
  private readonly presentations = new Map<string, ProgressState>();
  private readonly retiredTurns = new Map<string, string>();
  private readonly completedOperations = new Set<string>();
  private readonly observed = new WeakSet<OutputEvent>();
  private closed = false;

  constructor(private readonly options: {
    displaySettings?: import("../types.js").SurfaceMessageDisplaySettings;
    reasoningEnabled: boolean;
    planUpdatesEnabled: boolean;
    operationUpdates: OperationUpdateDisplay;
    debugEnabled: boolean;
  }) {}

  observe(event: OutputEvent): void {
    if (this.closed || this.observed.has(event)) return;
    this.observed.add(event);
    const target = targetKey(event.target);
    if (event.type === "turn.started" || event.type === "turn.completed"
      || event.type === "connection.lost" || event.type === "conversation.idle.released") {
      for (const [key, turn] of this.turns) {
        if (turn.targetKey !== target || turn.threadId !== event.threadId) continue;
        if (event.type === "turn.started" && turn.turnId === event.turnId) continue;
        if (event.type === "turn.completed" && turn.turnId !== event.turnId) continue;
        if (event.type === "connection.lost") {
          turn.retry.observe(event, false);
          this.invalidatePresentations(turn);
          continue;
        }
        this.retireTurn(key, turn);
      }
      if (event.type === "turn.completed") this.rememberRetired(
        JSON.stringify([target, event.threadId, event.turnId]), target,
      );
      if (event.type === "turn.started") this.ensureTurn(event);
      return;
    }
    if (!isQqTaskProgressEvent(event)) return;
    // QQ operation notices are append-only; publish the terminal result once
    // instead of creating separate running and completed bubbles.
    if (event.type === "operation.updated" && event.operation.status === "running") return;
    if (isReliableProgress(event)) {
      if (event.type === "operation.updated") {
        const key = presentationKey(event);
        const running = this.presentations.get(key);
        if (running) running.active = false;
        this.presentations.delete(key);
        this.completedOperations.add(key);
        if (this.completedOperations.size > 4_096) this.completedOperations.delete(this.completedOperations.values().next().value!);
      }
      return;
    }
    const turn = event.type === "subagent.completed" ? undefined : this.ensureTurn(event);
    if (event.type !== "subagent.completed" && !turn) return;
    if (turn) turn.retry.observe(event, false);
    const settings = this.displaySettings(event.target);
    if ((event.type === "turn.reasoning" && !settings.reasoningEnabled)
      || (event.type === "plan.updated" && !settings.planUpdatesEnabled)
      || (event.type === "operation.updated" && !shouldDisplayOperation(event.operation, settings.operationUpdates))) return;
    const key = presentationKey(event);
    if (event.type === "operation.updated" && this.completedOperations.has(key)) return;
    const existing = this.presentations.get(key);
    if (existing?.attempted && sameRevision(existing.event, event)) {
      existing.event = event;
      return;
    }
    if (!existing && this.presentations.size >= maximumPresentations && !this.releasePresentation()) return;
    if (existing) existing.active = false;
    this.presentations.set(key, {
      event, targetKey: target, turn, active: true, attempted: false, sending: undefined,
    });
  }

  prepare(event: QqTaskProgressEvent, retained = false): PreparedProgress | undefined {
    if (this.closed) return isReliableProgress(event) ? failedProgress : undefined;
    if (event.type === "subagent.completed" && event.parentTurnId === undefined) return failedProgress;
    // Live snapshots still use current preferences. A stored terminal result must
    // render even when compact would hide this sleep/subagent operation.
    if (event.type === "operation.updated" && (event.operation.status === "running"
      || (!retained && !shouldDisplayOperation(event.operation, this.displaySettings(event.target).operationUpdates)))) return undefined;
    if (isReliableProgress(event)) {
      const values = this.render(event);
      if (values.length === 0) return failedProgress;
      // Reliable delivery owns occurrence identity, ordering, confirmation and retries.
      // Always render the supplied enriched event and propagate the actual send result.
      return async send => {
        if (this.closed) await failedProgress();
        for (const value of values) await send(value);
      };
    }
    const state = this.presentations.get(presentationKey(event));
    if (!state || !state.active) return undefined;
    if (state.attempted && !state.sending) return undefined;
    if (state.event !== event) return undefined;
    if (event.type === "turn.retry") {
      const retry = state.turn?.retry.prepare(state.event as Extract<OutputEvent, { type: "turn.retry" }>, true);
      if (!retry) return undefined;
      return send => this.sendOnce(state, async () => retry(async text => {
        await send({ text, markdown: escapeLifecycleLiteral(text) });
      }));
    }
    if (event.type === "turn.reasoning") {
      const turn = state.turn!;
      if (turn.reasoningAttempted) return undefined;
      return send => this.sendOnce(state, async () => {
        if (turn.reasoningAttempted) return;
        // Bound append-only notices even if a platform call has an unknown result.
        turn.reasoningAttempted = true;
        await send(presentLifecycle(createTurnReasoningPresentation(
          event.background ? event.threadId : undefined, event.elapsedMs, event.final === true,
        )));
      });
    }
    if (event.type === "plan.updated") {
      const turn = state.turn!;
      return send => this.sendOnce(state, async () => {
        // Observation never counts an unseen plan as displayed. The latest snapshot
        // starts with its full plan until a platform call actually succeeds.
        if (turn.planObservations >= 64) return;
        turn.planObservations++;
        const bounded = { ...event, steps: event.steps.slice(0, 128).map(step => ({
          ...step, step: boundStepIdentity(step.step),
        })) };
        const plans = !turn.planDisplayed ? [createPlanPresentation(event)]
          : event.steps.length > 128 ? [] : turn.plan.accept(bounded);
        const markdownInput = escapePlan(event);
        const markdownBounded = escapePlan(bounded);
        const markdownPlans = !turn.planDisplayed ? [createPlanPresentation(markdownInput)]
          : event.steps.length > 128 ? [] : turn.markdownPlan.accept(markdownBounded);
        for (const [index, plan] of plans.entries()) {
          if (!this.isCurrent(state)) return;
          await send({ text: plan.text, markdown: markdownPlans[index]!.text });
          if (!turn.planDisplayed) {
            turn.plan.accept(bounded);
            turn.markdownPlan.accept(markdownBounded);
            turn.planDisplayed = true;
          }
        }
      });
    }
    const values = this.render(event);
    if (values.length === 0) return undefined;
    return send => this.sendOnce(state, async () => {
      for (const value of values) {
        if (!this.isCurrent(state)) {
          return;
        }
        await send(value);
      }
    });
  }

  cancelTarget(target: ConversationTarget): void {
    const key = targetKey(target);
    for (const [turnKey, turn] of this.turns) {
      if (turn.targetKey === key) this.retireTurn(turnKey, turn);
    }
    for (const [presentationKey, state] of this.presentations) {
      if (state.targetKey !== key) continue;
      state.active = false;
      this.presentations.delete(presentationKey);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const turn of this.turns.values()) { turn.active = false; turn.retry.clear(); }
    for (const state of this.presentations.values()) state.active = false;
    this.turns.clear();
    this.presentations.clear();
    this.retiredTurns.clear();
    this.completedOperations.clear();
  }

  private ensureTurn(event: Exclude<QqTaskProgressEvent, { type: "subagent.completed" }>
    | Extract<OutputEvent, { type: "turn.started" }>): TurnPresentationState | undefined {
    const key = JSON.stringify([targetKey(event.target), event.threadId, event.turnId]);
    if (this.retiredTurns.has(key)) return undefined;
    const existing = this.turns.get(key);
    if (existing) return existing;
    if (this.turns.size >= maximumTurns) {
      const oldest = this.turns.entries().next().value!;
      this.retireTurn(oldest[0], oldest[1]);
    }
    const turn: TurnPresentationState = {
      targetKey: targetKey(event.target), threadId: event.threadId, turnId: event.turnId,
      active: true, reasoningAttempted: false, planObservations: 0, planDisplayed: false,
      plan: new PlanProgressTracker(), markdownPlan: new PlanProgressTracker(), retry: new TurnRetryMessages<void>(),
    };
    this.turns.set(key, turn);
    return turn;
  }

  private retireTurn(key: string, turn: TurnPresentationState): void {
    turn.active = false;
    turn.retry.clear();
    this.turns.delete(key);
    this.rememberRetired(key, turn.targetKey);
    this.invalidatePresentations(turn);
  }

  private invalidatePresentations(turn: TurnPresentationState): void {
    for (const [key, state] of this.presentations) {
      if (state.turn !== turn) continue;
      state.active = false;
      this.presentations.delete(key);
    }
  }

  private rememberRetired(key: string, target: string): void {
    this.retiredTurns.set(key, target);
    if (this.retiredTurns.size > 4_096) this.retiredTurns.delete(this.retiredTurns.keys().next().value!);
  }

  private releasePresentation(): boolean {
    for (const [key, state] of this.presentations) {
      if (state.sending) continue;
      state.active = false;
      this.presentations.delete(key);
      return true;
    }
    return false;
  }

  private isCurrent(state: ProgressState): boolean {
    return !this.closed && state.active && this.presentations.get(presentationKey(state.event)) === state
      && state.turn?.active === true;
  }

  private sendOnce(state: ProgressState, send: () => Promise<void>): Promise<void> {
    if (!this.isCurrent(state)) return Promise.resolve();
    if (state.sending) return state.sending;
    if (state.attempted) return Promise.resolve();
    state.attempted = true;
    const sending = send().finally(() => { state.sending = undefined; });
    state.sending = sending;
    return sending;
  }

  private render(event: QqTaskProgressEvent): Presentation[] {
    switch (event.type) {
      case "subagent.spawned": return [presentLifecycle(createSubagentStartedPresentation(event))];
      case "subagent.contacted": return [presentLifecycle(createSubagentContactedPresentation(event))];
      case "subagent.completed": return [presentLifecycle(createSubagentCompletedPresentation(event, this.options.debugEnabled))];
      case "operation.updated": return [presentOperation(event.operation, this.displaySettings(event.target).operationUpdates)];
      case "turn.retry":
      case "plan.updated":
      case "turn.reasoning": return [];
    }
  }

  private displaySettings(target: ConversationTarget) {
    return this.options.displaySettings?.(target) ?? {
      operationUpdates: this.options.operationUpdates,
      planUpdatesEnabled: this.options.planUpdatesEnabled,
      reasoningEnabled: this.options.reasoningEnabled,
      completion: "detailed" as const,
    };
  }
}

function targetKey(target: ConversationTarget): string {
  return JSON.stringify([target.surface, target.accountId, target.conversationId]);
}

function presentationKey(event: QqTaskProgressEvent): string {
  const target = targetKey(event.target);
  switch (event.type) {
    case "subagent.completed": return JSON.stringify([target, event.parentThreadId, event.parentTurnId, event.agentThreadId, event.type]);
    case "subagent.spawned":
    case "subagent.contacted": return JSON.stringify([target, event.threadId, event.turnId, event.type, event.agentThreadId]);
    case "operation.updated": return JSON.stringify([target, event.threadId, event.turnId, event.type, event.operation.itemId]);
    default: return JSON.stringify([target, event.threadId, event.turnId, event.type]);
  }
}

function isReliableProgress(event: QqTaskProgressEvent): boolean {
  return event.type === "subagent.spawned" || event.type === "subagent.contacted" || event.type === "subagent.completed"
    || (event.type === "operation.updated" && event.operation.status !== "running");
}

function sameRevision(a: QqTaskProgressEvent, b: QqTaskProgressEvent): boolean {
  if (a.type === "operation.updated" && b.type === "operation.updated") {
    return a.operation.kind === b.operation.kind && a.operation.status === b.operation.status;
  }
  return a === b;
}

function failedProgress(): Promise<never> {
  return Promise.reject(new Error("QQ 任务过程终态已失效或未准入，尚未发送。"));
}

function boundStepIdentity(value: string): string {
  const characters = Array.from(value);
  return characters.length <= 240 ? value : `${characters.slice(0, 239).join("")}…`;
}

function escapePlan(event: Extract<OutputEvent, { type: "plan.updated" }>): Extract<OutputEvent, { type: "plan.updated" }> {
  return { ...event, explanation: event.explanation === null ? null : escapeLifecycleLiteral(event.explanation),
    steps: event.steps.map(step => ({ ...step, step: escapeLifecycleLiteral(step.step) })) };
}

function presentLifecycle(presentation: LifecyclePresentation): Presentation {
  const safe: LifecyclePresentation = {
    ...presentation, title: escapeLifecycleLiteral(presentation.title),
    fields: [...presentation.fields, ...(presentation.footer ? [presentation.footer] : [])].map(escapeLifecycleField),
    ...(presentation.sections ? { sections: presentation.sections.map(section => ({
      title: escapeLifecycleLiteral(section.title), fields: section.fields.map(escapeLifecycleField),
    })) } : {}),
  };
  return { text: renderPlainLifecyclePresentation(presentation), markdown: renderStructuredLifecyclePresentation(safe, false) };
}

function escapeLifecycleField(field: LifecyclePresentationField): LifecyclePresentationField {
  if ("title" in field) return {
    ...field, title: escapeLifecycleLiteral(field.title),
    ...(field.value === undefined ? {} : { value: escapeLifecycleLiteral(field.value) }),
    fields: field.fields.map(escapeLifecycleField),
  };
  return { ...field, label: escapeLifecycleLiteral(field.label), value: escapeLifecycleLiteral(field.value),
    ...(field.subfields ? { subfields: field.subfields.map(subfield => ({
      ...subfield, label: escapeLifecycleLiteral(subfield.label), value: escapeLifecycleLiteral(subfield.value),
    })) } : {}),
  };
}

function presentOperation(operation: OperationUpdate, display: OperationUpdateDisplay): Presentation {
  const metadata = operationMetadata(operation);
  const detail = operation.detail === undefined ? "" : display === "compact"
    ? compactOperationDetail(operation.detail) : redactOperationDetail(operation.detail);
  const title = `${operationTitle(operation)} · ${operationStatus(operation.status)}`;
  const text = [
    title,
    ...(metadata.length ? [metadata.join(" · ")] : []),
    ...(detail ? ["", detail] : []),
  ].join("\n");
  // Match Feishu's emphasis/code hierarchy, while QQ keeps its own safe
  // literal candidate and the original plain fallback for unsupported syntax.
  const code = display === "compact" && !detail.includes("`")
    ? `\`${detail}\`` : qqLiteralMarkdown(detail);
  const markdown = [
    `**${escapeLifecycleLiteral(title)}**${metadata.length ? ` · ${metadata.map(escapeLifecycleLiteral).join(" · ")}` : ""}`,
    ...(detail ? ["", code ?? escapeLifecycleLiteral(detail)] : []),
  ].join("\n");
  return { text, markdown };
}
