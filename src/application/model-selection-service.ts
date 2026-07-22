import type { CodexAppServerClient, TurnOverrides } from "../codex-client/client.js";
import type { Model } from "../codex-protocol/index.js";
import type { ConversationTarget } from "../conversation-core/events.js";
import type { SessionRouter } from "../session-routing/router.js";

export interface ModelSelectionState {
  models: Model[];
  model: string;
  effort: string | null;
  pending: boolean;
}

export class ModelSelectionService {
  private readonly pendingByConversation = new Map<string, TurnOverrides>();

  constructor(
    private readonly codex: CodexAppServerClient,
    private readonly router: SessionRouter,
    private readonly configuredDefaultModel?: string,
  ) {}

  async state(target: ConversationTarget): Promise<ModelSelectionState> {
    const models = await this.codex.listModels();
    return this.resolveState(target, models);
  }

  async selectModel(target: ConversationTarget, selector: string): Promise<ModelSelectionState> {
    const models = await this.codex.listModels();
    const selected = resolveModel(models, selector);
    const current = this.resolveState(target, models);
    const supported = selected.supportedReasoningEfforts.map((option) => option.reasoningEffort);
    const effort = current.effort && supported.includes(current.effort)
      ? current.effort
      : selected.defaultReasoningEffort;
    this.pendingByConversation.set(this.key(target), { model: selected.model, effort });
    return this.resolveState(target, models);
  }

  async selectEffort(target: ConversationTarget, selector: string): Promise<ModelSelectionState> {
    const models = await this.codex.listModels();
    const current = this.resolveState(target, models);
    const model = models.find((candidate) => candidate.model === current.model);
    if (!model) {
      throw new Error(`当前模型不在可用模型列表中：${current.model}`);
    }
    const options = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);
    const effort = resolveEffort(options, selector);
    const pending = this.pendingByConversation.get(this.key(target));
    this.pendingByConversation.set(this.key(target), {
      ...(pending?.model ? { model: pending.model } : {}),
      effort,
    });
    return this.resolveState(target, models);
  }

  turnOverrides(target: ConversationTarget): TurnOverrides {
    return { ...this.pendingByConversation.get(this.key(target)) };
  }

  markApplied(target: ConversationTarget): void {
    this.pendingByConversation.delete(this.key(target));
  }

  clear(target: ConversationTarget): void {
    this.pendingByConversation.delete(this.key(target));
  }

  status(target: ConversationTarget): Omit<ModelSelectionState, "models"> {
    const pending = this.pendingByConversation.get(this.key(target));
    const current = this.router.modelSettings(target);
    return {
      model: pending?.model ?? current?.model ?? this.configuredDefaultModel ?? "默认模型",
      effort: pending?.effort ?? current?.effort ?? null,
      pending: pending !== undefined,
    };
  }

  private resolveState(target: ConversationTarget, models: Model[]): ModelSelectionState {
    if (models.length === 0) {
      throw new Error("App Server 没有返回可用模型");
    }
    const pending = this.pendingByConversation.get(this.key(target));
    const current = this.router.modelSettings(target);
    const fallback = models.find((model) => model.model === this.configuredDefaultModel)
      ?? models.find((model) => model.isDefault)
      ?? models[0]!;
    const model = pending?.model ?? current?.model ?? fallback.model;
    const catalogModel = models.find((candidate) => candidate.model === model);
    return {
      models,
      model,
      effort: pending?.effort ?? current?.effort ?? catalogModel?.defaultReasoningEffort ?? null,
      pending: pending !== undefined,
    };
  }

  private key(target: ConversationTarget): string {
    return `${target.surface}:${target.conversationId}`;
  }
}

export function resolveModel(models: Model[], selector: string): Model {
  const normalized = selector.trim();
  if (!normalized) {
    throw new Error("用法：/model <序号、模型 ID 或名称>");
  }
  if (/^\d+$/.test(normalized)) {
    const model = models[Number(normalized) - 1];
    if (model) {
      return model;
    }
  }
  const exact = models.filter(
    (model) => model.model === normalized || model.id === normalized || model.displayName === normalized,
  );
  if (exact.length === 1) {
    return exact[0]!;
  }
  throw new Error(exact.length > 1 ? "模型选择不唯一" : "找不到指定模型");
}

export function resolveEffort(options: string[], selector: string): string {
  const normalized = selector.trim().toLowerCase();
  if (/^\d+$/.test(normalized)) {
    const effort = options[Number(normalized) - 1];
    if (effort) {
      return effort;
    }
  }
  const effort = options.find((option) => option.toLowerCase() === normalized);
  if (effort) {
    return effort;
  }
  throw new Error(`当前模型不支持该思考强度，可选：${options.join("、")}`);
}
