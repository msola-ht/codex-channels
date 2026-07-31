import {
  UserFacingError,
  conversationTargetKey,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type {
  ModelInputModality,
  ModelOption,
  ModelSelectionPort,
} from "./model-port.js";
import type { TurnOverrides } from "./turn-port.js";
import type { SessionRouter } from "../session-routing/index.js";

export interface ModelSelectionState {
  models: ModelOption[];
  model: string;
  modelProvider?: string;
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
    private readonly codex: ModelSelectionPort,
    private readonly router: SessionRouter,
    private readonly configuredDefaultModel?: string,
    private readonly supplementaryModels: readonly ModelOption[] = [],
  ) {}

  async state(target: ConversationTarget): Promise<ModelSelectionState> {
    const models = await this.listModels();
    return this.resolveState(target, models);
  }

  async requireInputModality(
    target: ConversationTarget,
    modality: ModelInputModality,
  ): Promise<void> {
    const current = await this.state(target);
    const model = current.models.find((candidate) => candidate.model === current.model);
    if (!model) {
      throw new UserFacingError(
        "model.current.missing",
        `当前模型不在可用模型列表中：${current.model}`,
        { model: current.model },
      );
    }
    if (model.inputModalities.includes(modality)) {
      return;
    }
    if (modality === "audio") {
      throw new UserFacingError(
        "model.input.audio.unsupported",
        `当前模型 ${current.model} 不支持语音输入，请发送文字或图片`,
        { model: current.model },
      );
    }
    throw new UserFacingError(
      "model.input.unsupported",
      `当前模型 ${current.model} 不支持该输入类型`,
      { model: current.model, modality },
    );
  }

  async selectModel(target: ConversationTarget, selector: string): Promise<ModelSelectionState> {
    const models = await this.listModels();
    const selected = resolveModel(models, selector);
    if (selected.available === false) {
      throw new UserFacingError(
        "model.unavailable",
        `${selected.displayName} 暂不可用${selected.unavailableReason ? `：${selected.unavailableReason}` : ""}`,
        {
          model: selected.model,
          ...(selected.provider ? { provider: selected.provider } : {}),
          ...(selected.unavailableReason ? { reason: selected.unavailableReason } : {}),
        },
      );
    }
    const current = this.resolveState(target, models);
    const selectedProvider = selected.provider ?? "openai";
    const providerChanged = selectedProvider !== current.modelProvider;
    if (providerChanged) {
      if (this.router.current(target)) {
        await this.router.fork(target, {
          model: selected.model,
          modelProvider: selectedProvider,
          ...(selected.catalogPath
            ? { config: { model_catalog_json: selected.catalogPath } }
            : {}),
        });
      } else {
        await this.router.newSession(target);
      }
    }
    const supported = selected.supportedReasoningEfforts.map((option) => option.effort);
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
      ...(providerChanged ? { modelProvider: selectedProvider } : {}),
      ...(selected.catalogPath ? { modelCatalogPath: selected.catalogPath } : {}),
      effort,
      ...(currentFast
        ? { serviceTier: selectedFastTier ?? standardServiceTierRequestValue }
        : {}),
    });
    return this.resolveState(target, models);
  }

  async selectEffort(target: ConversationTarget, selector: string): Promise<ModelSelectionState> {
    const models = await this.listModels();
    const current = this.resolveState(target, models);
    const model = models.find((candidate) => candidate.model === current.model);
    if (!model) {
      throw new UserFacingError(
        "model.current.missing",
        `当前模型不在可用模型列表中：${current.model}`,
        { model: current.model },
      );
    }
    const options = model.supportedReasoningEfforts.map((option) => option.effort);
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
    const models = await this.listModels();
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
    await this.codex.writeDefaultFastMode(enable);
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

  threadStartOptions(target: ConversationTarget) {
    const pending = this.pendingByConversation.get(this.key(target));
    return {
      ...(pending?.model ? { model: pending.model } : {}),
      ...(pending?.modelProvider ? { modelProvider: pending.modelProvider } : {}),
      ...(pending?.modelCatalogPath
        ? { config: { model_catalog_json: pending.modelCatalogPath } }
        : {}),
    };
  }

  markApplied(target: ConversationTarget): void {
    const key = this.key(target);
    const pending = this.pendingByConversation.get(key);
    const binding = this.router.current(target);
    const current = this.router.modelSettings(target);
    if (pending && binding && current) {
      this.router.updateModelSettings(binding.threadId, {
        model: pending.model ?? current.model,
        modelProvider: pending.modelProvider ?? current.modelProvider ?? "openai",
        effort: pending.effort ?? current.effort,
        serviceTier: hasServiceTierOverride(pending)
          ? pending.serviceTier ?? null
          : current.serviceTier,
        collaborationMode: current.collaborationMode,
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
      modelProvider: pending?.modelProvider ?? current?.modelProvider ?? "openai",
      effort: pending?.effort ?? current?.effort ?? null,
      serviceTier: serviceTierPending ? pending?.serviceTier ?? null : current?.serviceTier ?? null,
      pending: pending !== undefined,
      modelPending: hasOverride(pending, "model"),
      effortPending: hasOverride(pending, "effort"),
      serviceTierPending,
    };
  }

  private resolveState(target: ConversationTarget, models: ModelOption[]): ModelSelectionState {
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
      modelProvider: pending?.modelProvider
        ?? current?.modelProvider
        ?? catalogModel?.provider
        ?? "openai",
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

  private async listModels(): Promise<ModelOption[]> {
    const primary = await this.codex.listModels();
    const combined = new Map(primary.map((model) => [model.model, model]));
    for (const model of this.supplementaryModels) {
      combined.set(model.model, model);
    }
    return [...combined.values()];
  }
}

export function fastServiceTierId(model: ModelOption): string | undefined {
  const tier = model.serviceTiers.find(
    (candidate) =>
      candidate.id.toLowerCase() === "fast"
      || candidate.name.trim().toLowerCase() === "fast",
  );
  if (tier) {
    return tier.id;
  }
  return undefined;
}

export function isFastServiceTier(serviceTier: string | null, model?: ModelOption): boolean {
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

export function resolveModel(models: ModelOption[], selector: string): ModelOption {
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
