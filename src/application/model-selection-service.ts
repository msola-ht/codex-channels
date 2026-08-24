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
  providerPending?: boolean;
}

export interface ModelSelectionPreference {
  model: string;
  modelProvider: string;
  effort: string | null;
  serviceTier: string | null;
}

export interface OfficialModelCatalogProvider {
  provider: string;
  displayName: string;
  defaultModel: string;
}

const standardServiceTierRequestValue = "default";

export class ModelSelectionService {
  private readonly pendingByConversation = new Map<string, TurnOverrides>();

  constructor(
    private readonly codex: ModelSelectionPort,
    private readonly router: SessionRouter,
    private readonly configuredDefaultModel?: string,
    private readonly supplementaryModels: readonly ModelOption[] = [],
    private readonly primaryProvider = "openai",
    private readonly officialCatalogProviders: readonly OfficialModelCatalogProvider[] = [],
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
    const model = findModel(current.models, current.model, current.modelProvider);
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
    if (modality === "image") {
      throw new UserFacingError(
        "model.input.image.unsupported",
        `当前模型 ${current.model} 不支持图片输入，请发送文字或切换支持图片的模型`,
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
    const selectedFastTier = fastServiceTierId(selected);
    const providerDefaultTier = providerChanged && selectedFastTier
      ? await this.codex.readDefaultServiceTier(
          this.router.workspace(target).cwd,
          selectedProvider,
        )
      : undefined;
    if (providerChanged) {
      await this.router.newSession(target);
    }
    const supported = selected.supportedReasoningEfforts.map((option) => option.effort);
    const effort = !providerChanged && current.effort && supported.includes(current.effort)
      ? current.effort
      : selected.defaultReasoningEffort;
    const pending = { ...this.pendingByConversation.get(this.key(target)) };
    if (providerChanged) {
      delete pending.serviceTier;
    }
    const currentModel = findModel(current.models, current.model, current.modelProvider);
    const currentFast = isFastServiceTier(current.serviceTier, currentModel);
    this.pendingByConversation.set(this.key(target), {
      ...pending,
      model: selected.model,
      ...(providerChanged ? { modelProvider: selectedProvider } : {}),
      effort,
      ...(providerChanged
        ? selectedFastTier
          ? {
              serviceTier: isFastServiceTier(providerDefaultTier ?? null, selected)
                ? selectedFastTier
                : standardServiceTierRequestValue,
            }
          : {}
        : currentFast
          ? { serviceTier: selectedFastTier ?? standardServiceTierRequestValue }
          : {}),
    });
    return this.resolveState(target, models);
  }

  async selectEffort(target: ConversationTarget, selector: string): Promise<ModelSelectionState> {
    const models = await this.listModels();
    const current = this.resolveState(target, models);
    const model = findModel(models, current.model, current.modelProvider);
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
    const model = findModel(models, current.model, current.modelProvider);
    const currentFast = isFastServiceTier(current.serviceTier, model);
    if (normalized === "status") {
      return current;
    }
    const tierId = model ? fastServiceTierId(model) : undefined;
    if (!tierId) {
      throw new UserFacingError(
        "fast.unsupported",
        `当前模型不支持 Fast 模式：${current.model}`,
        { model: current.model },
      );
    }
    const enable = normalized ? normalized === "on" : !currentFast;
    const selectedTier = enable ? tierId : standardServiceTierRequestValue;
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

  hasPending(target: ConversationTarget): boolean {
    return this.pendingByConversation.has(this.key(target));
  }

  threadStartOptions(target: ConversationTarget) {
    const pending = this.pendingByConversation.get(this.key(target));
    return {
      ...(pending?.model ? { model: pending.model } : {}),
      ...(pending?.modelProvider
        ? { modelProvider: this.normalizeProvider(pending.modelProvider) ?? this.primaryProvider }
        : {}),
    };
  }

  capturePreference(target: ConversationTarget): ModelSelectionPreference | undefined {
    const pending = this.pendingByConversation.get(this.key(target));
    const current = this.router.modelSettings(target);
    const model = pending?.model ?? current?.model;
    if (!model) return undefined;
    const serviceTierPending = hasServiceTierOverride(pending);
    return {
      model,
      modelProvider: this.normalizeProvider(pending?.modelProvider ?? current?.modelProvider)
        ?? this.primaryProvider,
      effort: pending?.effort ?? current?.effort ?? null,
      serviceTier: serviceTierPending
        ? pending?.serviceTier ?? null
        : current?.serviceTier ?? null,
    };
  }

  restorePreference(
    target: ConversationTarget,
    preference: ModelSelectionPreference | undefined,
  ): void {
    const key = this.key(target);
    this.pendingByConversation.delete(key);
    if (!preference) return;
    const currentProvider = this.normalizeProvider(
      this.router.modelSettings(target)?.modelProvider,
    )
      ?? this.primaryProvider;
    const preferredProvider = this.normalizeProvider(preference.modelProvider)
      ?? this.primaryProvider;
    if (this.router.current(target) && currentProvider !== preferredProvider) return;
    this.pendingByConversation.set(key, {
      model: preference.model,
      modelProvider: preferredProvider,
      ...(preference.effort ? { effort: preference.effort } : {}),
      serviceTier: preference.serviceTier,
    });
  }

  markApplied(target: ConversationTarget): void {
    const key = this.key(target);
    const pending = this.pendingByConversation.get(key);
    const binding = this.router.current(target);
    const current = this.router.modelSettings(target);
    if (pending && binding && current) {
      this.router.updateModelSettings(binding.threadId, {
        model: pending.model ?? current.model,
        modelProvider: this.normalizeProvider(pending.modelProvider ?? current.modelProvider)
          ?? this.primaryProvider,
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
      modelProvider: this.normalizeProvider(pending?.modelProvider ?? current?.modelProvider)
        ?? this.primaryProvider,
      effort: pending?.effort ?? current?.effort ?? null,
      serviceTier: serviceTierPending ? pending?.serviceTier ?? null : current?.serviceTier ?? null,
      pending: pending !== undefined,
      modelPending: hasOverride(pending, "model"),
      effortPending: hasOverride(pending, "effort"),
      serviceTierPending,
      providerPending: hasOverride(pending, "modelProvider"),
    };
  }

  private resolveState(target: ConversationTarget, models: ModelOption[]): ModelSelectionState {
    if (models.length === 0) {
      throw new Error("App Server 没有返回可用模型");
    }
    const pending = this.pendingByConversation.get(this.key(target));
    const current = this.router.modelSettings(target);
    const configuredDefault = this.configuredDefaultModel
      ? findModel(models, this.configuredDefaultModel, this.primaryProvider)
      : undefined;
    if (this.configuredDefaultModel && !configuredDefault) {
      throw new UserFacingError(
        "model.configured-default.missing",
        `配置的默认模型不属于当前主 Provider ${this.primaryProvider}：${this.configuredDefaultModel}`,
        {
          model: this.configuredDefaultModel,
          provider: this.primaryProvider,
        },
      );
    }
    const fallback = configuredDefault
      ?? models.find((model) =>
        model.isDefault && (model.provider ?? "openai") === this.primaryProvider)
      ?? models.find((model) => (model.provider ?? "openai") === this.primaryProvider)
      ?? models[0]!;
    const model = pending?.model ?? current?.model ?? fallback.model;
    const selectedProvider = this.normalizeProvider(
      pending?.modelProvider
        ?? current?.modelProvider
        ?? fallback.provider
        ?? this.primaryProvider,
    ) ?? this.primaryProvider;
    const catalogModel = findModel(models, model, selectedProvider);
    const serviceTierPending = hasServiceTierOverride(pending);
    return {
      models,
      model,
      modelProvider: this.normalizeProvider(
        pending?.modelProvider
          ?? current?.modelProvider
          ?? catalogModel?.provider
          ?? this.primaryProvider,
      ) ?? this.primaryProvider,
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
      providerPending: hasOverride(pending, "modelProvider"),
    };
  }

  private key(target: ConversationTarget): string {
    return conversationTargetKey(target);
  }

  private normalizeProvider(provider: string | undefined): string | undefined {
    if (provider === undefined) return undefined;
    return provider === "openai" && this.primaryProvider !== "openai"
      ? this.primaryProvider
      : provider;
  }

  private async listModels(): Promise<ModelOption[]> {
    const primary = (await this.codex.listModels()).map((model) =>
      this.primaryProvider === "openai"
        ? model
        : { ...model, provider: this.primaryProvider });
    const combined = new Map(primary.map((model) => [modelKey(model), model]));
    for (const provider of this.officialCatalogProviders) {
      for (const model of primary) {
        const aliased = {
          ...model,
          provider: provider.provider,
          displayName: `${provider.displayName} · ${model.displayName}`,
          isDefault: model.model === provider.defaultModel,
        };
        combined.set(modelKey(aliased), aliased);
      }
    }
    for (const model of this.supplementaryModels) {
      combined.set(modelKey(model), model);
    }
    return [...combined.values()];
  }
}

function findModel(
  models: ModelOption[],
  model: string,
  provider?: string,
): ModelOption | undefined {
  const normalizedProvider = provider ?? "openai";
  return models.find((candidate) =>
    candidate.model === model && (candidate.provider ?? "openai") === normalizedProvider);
}

function modelKey(model: ModelOption): string {
  return `${model.provider ?? "openai"}\0${model.model}`;
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
    `当前模型不支持该思考等级，可选：${options.join("、")}`,
    { options },
  );
}
