import type { CodexAppServerClient, TurnOverrides } from "../codex-client/index.js";
import type { Model } from "../codex-protocol/index.js";
import {
  UserFacingError,
  conversationTargetKey,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { SessionRouter } from "../session-routing/index.js";

export interface ModelSelectionState {
  models: Model[];
  model: string;
  effort: string | null;
  serviceTier: string | null;
  pending: boolean;
  modelPending: boolean;
  effortPending: boolean;
  serviceTierPending: boolean;
}

const standardServiceTierRequestValue = "default";

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
    const pending = this.pendingByConversation.get(this.key(target));
    const currentModel = current.models.find((candidate) => candidate.model === current.model);
    const currentFast = isFastServiceTier(current.serviceTier, currentModel);
    const selectedFastTier = fastServiceTierId(selected);
    this.pendingByConversation.set(this.key(target), {
      ...pending,
      model: selected.model,
      effort,
      ...(currentFast
        ? { serviceTier: selectedFastTier ?? standardServiceTierRequestValue }
        : {}),
    });
    return this.resolveState(target, models);
  }

  async selectEffort(target: ConversationTarget, selector: string): Promise<ModelSelectionState> {
    const models = await this.codex.listModels();
    const current = this.resolveState(target, models);
    const model = models.find((candidate) => candidate.model === current.model);
    if (!model) {
      throw new UserFacingError(
        "model.current.missing",
        `当前模型不在可用模型列表中：${current.model}`,
        { model: current.model },
      );
    }
    const options = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);
    const effort = resolveEffort(options, selector);
    const pending = this.pendingByConversation.get(this.key(target));
    this.pendingByConversation.set(this.key(target), { ...pending, effort });
    return this.resolveState(target, models);
  }

  async selectFastMode(target: ConversationTarget, selector: string): Promise<ModelSelectionState> {
    const normalized = selector.trim().toLowerCase();
    if (normalized && !new Set(["on", "off", "status"]).has(normalized)) {
      throw new UserFacingError("fast.usage", "Fast 模式参数必须是 on、off 或 status");
    }
    const models = await this.codex.listModels();
    const current = this.resolveState(target, models);
    const model = models.find((candidate) => candidate.model === current.model);
    const currentFast = isFastServiceTier(current.serviceTier, model);
    if (normalized === "status") {
      return current;
    }
    const enable = normalized ? normalized === "on" : !currentFast;
    const tierId = model ? fastServiceTierId(model) : undefined;
    if (enable) {
      if (!tierId) {
        throw new UserFacingError(
          "fast.unsupported",
          `当前模型不支持 Fast 模式：${current.model}`,
          { model: current.model },
        );
      }
    }
    const selectedTier = enable ? tierId! : standardServiceTierRequestValue;
    await this.codex.writeDefaultServiceTier(selectedTier);
    if ((enable && currentFast) || (!enable && !currentFast)) {
      return current;
    }
    const pending = this.pendingByConversation.get(this.key(target));
    this.pendingByConversation.set(this.key(target), {
      ...pending,
      serviceTier: selectedTier,
    });
    return this.resolveState(target, models);
  }

  turnOverrides(target: ConversationTarget): TurnOverrides {
    return { ...this.pendingByConversation.get(this.key(target)) };
  }

  markApplied(target: ConversationTarget): void {
    const key = this.key(target);
    const pending = this.pendingByConversation.get(key);
    const binding = this.router.current(target);
    const current = this.router.modelSettings(target);
    if (pending && binding && current) {
      this.router.updateModelSettings(binding.threadId, {
        model: pending.model ?? current.model,
        effort: pending.effort ?? current.effort,
        serviceTier: hasServiceTierOverride(pending)
          ? pending.serviceTier ?? null
          : current.serviceTier,
      });
    }
    this.pendingByConversation.delete(key);
  }

  clear(target: ConversationTarget): void {
    this.pendingByConversation.delete(this.key(target));
  }

  status(target: ConversationTarget): Omit<ModelSelectionState, "models"> {
    const pending = this.pendingByConversation.get(this.key(target));
    const current = this.router.modelSettings(target);
    const serviceTierPending = hasServiceTierOverride(pending);
    return {
      model: pending?.model ?? current?.model ?? this.configuredDefaultModel ?? "默认模型",
      effort: pending?.effort ?? current?.effort ?? null,
      serviceTier: serviceTierPending ? pending?.serviceTier ?? null : current?.serviceTier ?? null,
      pending: pending !== undefined,
      modelPending: hasOverride(pending, "model"),
      effortPending: hasOverride(pending, "effort"),
      serviceTierPending,
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
    const serviceTierPending = hasServiceTierOverride(pending);
    return {
      models,
      model,
      effort: pending?.effort ?? current?.effort ?? catalogModel?.defaultReasoningEffort ?? null,
      serviceTier: serviceTierPending
        ? pending?.serviceTier ?? null
        : current
          ? current.serviceTier
          : catalogModel?.defaultServiceTier ?? null,
      pending: pending !== undefined,
      modelPending: hasOverride(pending, "model"),
      effortPending: hasOverride(pending, "effort"),
      serviceTierPending,
    };
  }

  private key(target: ConversationTarget): string {
    return conversationTargetKey(target);
  }
}

export function fastServiceTierId(model: Model): string | undefined {
  const tier = model.serviceTiers.find(
    (candidate) =>
      candidate.id.toLowerCase() === "fast"
      || candidate.name.trim().toLowerCase() === "fast",
  );
  if (tier) {
    return tier.id;
  }
  return model.additionalSpeedTiers.some((candidate) => candidate.toLowerCase() === "fast")
    ? "fast"
    : undefined;
}

export function isFastServiceTier(serviceTier: string | null, model?: Model): boolean {
  if (!serviceTier) {
    return false;
  }
  const normalized = serviceTier.toLowerCase();
  return normalized === "fast"
    || normalized === "priority"
    || (model !== undefined && fastServiceTierId(model) === serviceTier);
}

function hasServiceTierOverride(pending: TurnOverrides | undefined): boolean {
  return hasOverride(pending, "serviceTier");
}

function hasOverride(pending: TurnOverrides | undefined, key: keyof TurnOverrides): boolean {
  return pending !== undefined && Object.hasOwn(pending, key);
}

export function resolveModel(models: Model[], selector: string): Model {
  const normalized = selector.trim();
  if (!normalized) {
    throw new UserFacingError(
      "model.selector.required",
      "需要提供模型序号、模型 ID 或名称",
    );
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
  const ambiguous = exact.length > 1;
  throw new UserFacingError(
    ambiguous ? "model.selector.ambiguous" : "model.selector.not-found",
    ambiguous ? "模型选择不唯一" : "找不到指定模型",
  );
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
  throw new UserFacingError(
    "effort.unsupported",
    `当前模型不支持该思考强度，可选：${options.join("、")}`,
    { options },
  );
}
