import { createHash } from "node:crypto";
import { acceleratedServiceTierId, normalizeServiceTier } from "../../runtime/service-tier.mjs";
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
import type { SessionRouter, ThreadModelSettings } from "../session-routing/index.js";

export interface ModelSelectionState {
  /** Opaque identity for short-lived selection pages; contains no model input. */
  selectionScope?: string;
  models: ModelOption[];
  model: string;
  modelProvider?: string;
  providerFilter?: string;
  effort: string | null;
  serviceTier: string | null;
  serviceTierKnown: boolean;
  effectiveServiceTier?: string | null | undefined;
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
  /** Process-local provenance; never part of the stored preference schema. */
  serviceTierExplicit?: boolean;
}

export interface ModelSelectionIdentity {
  provider: string;
  model: string;
}

export type ModelSelectionSnapshot = Omit<ModelSelectionState, "models" | "selectionScope"> & {
  selectionScope: string;
};

export type ModelSelectionRequest = { snapshot: ModelSelectionSnapshot } & (
  | { kind: "browse-provider"; provider: string }
  | { kind: "model"; provider: string; model: string }
  | { kind: "effort"; effort: string }
  | { kind: "fast"; mode: "on" | "off" | "ultrafast" }
);

export function modelSelectionSnapshot(state: Omit<ModelSelectionState, "models">): ModelSelectionSnapshot {
  if (!state.selectionScope) {
    throw new UserFacingError("model.selection.expired", "模型选项已失效，请重新打开选择卡片");
  }
  return {
    selectionScope: state.selectionScope,
    model: state.model,
    ...(state.modelProvider === undefined ? {} : { modelProvider: state.modelProvider }),
    ...(state.providerFilter === undefined ? {} : { providerFilter: state.providerFilter }),
    effort: state.effort,
    serviceTier: state.serviceTier,
    serviceTierKnown: state.serviceTierKnown === true,
    ...(state.effectiveServiceTier === undefined ? {} : { effectiveServiceTier: state.effectiveServiceTier }),
    pending: state.pending,
    modelPending: state.modelPending,
    effortPending: state.effortPending,
    serviceTierPending: state.serviceTierPending,
    ...(state.providerPending === undefined ? {} : { providerPending: state.providerPending }),
  };
}

interface SelectionExpectation {
  threadId: string | undefined;
  scope?: string;
  snapshot?: ModelSelectionSnapshot;
  catalog?: ModelCatalog;
  defaults?: string;
}

export interface OfficialModelCatalogProvider {
  provider: string;
  displayName: string;
  defaultModel: string;
}

export interface IndependentModelCatalogProvider {
  provider: string;
  displayName: string;
  defaultModel?: string;
}

const standardServiceTierRequestValue = "default";

interface ModelCatalog {
  models: ModelOption[];
  queriedProviders: ReadonlySet<string>;
  /** Only a successful source can prove that an identity is absent. */
  confirmedProviders: ReadonlySet<string>;
}

export class ModelSelectionService {
  private readonly pendingByConversation = new Map<string, TurnOverrides>();
  private readonly explicitServiceTierByConversation = new Set<string>();
  private readonly pendingProviderSwitches = new Set<string>();
  private readonly providerFilterByConversation = new Map<string, string>();
  private readonly independentCatalogDefaults = new Map<string, string>();

  constructor(
    private readonly codex: ModelSelectionPort,
    private readonly router: SessionRouter,
    private readonly configuredDefaultModel?: string,
    private supplementaryModels: readonly ModelOption[] = [],
    private readonly primaryProvider = "openai",
    private readonly officialCatalogProviders: readonly OfficialModelCatalogProvider[] = [],
    private readonly openaiAuthenticated: () => boolean = () => true,
    private readonly providersWithoutSubscription: () => ReadonlySet<string> = () => new Set(),
    private readonly defaultThirdPartyProvider?: string,
    private readonly independentCatalogProviders: readonly IndependentModelCatalogProvider[] = [],
  ) {}

  updateSupplementaryModels(models: readonly ModelOption[], provider?: string): void {
    this.supplementaryModels = provider === undefined ? models : [
      ...this.supplementaryModels.filter((model) => model.provider !== provider),
      ...models.filter((model) => model.provider === provider),
    ];
  }

  async state(target: ConversationTarget, requireSelection = false, assertAuthorized?: () => void, expected?: SelectionExpectation): Promise<ModelSelectionState> {
    assertAuthorized?.();
    let filter = this.providerFilterByConversation.get(this.key(target));
    if (filter !== undefined && this.providersWithoutSubscription().has(filter)) {
      this.providerFilterByConversation.delete(this.key(target));
      filter = undefined;
    }
    assertAuthorized = this.selectionGuard(target, assertAuthorized, {
      threadId: this.router.current(target)?.threadId,
      scope: this.selectionScope(target),
    });
    assertAuthorized?.();
    const catalog = await this.listModels(requireSelection ? this.status(target).modelProvider : filter, assertAuthorized);
    const { models } = catalog;
    const state = await this.selectionState(target, catalog, filter, assertAuthorized, expected);
    assertAuthorized?.();
    if (requireSelection && state.modelProvider === undefined) {
      throw new UserFacingError("model.provider.selection-required", "请先通过 /model 选择提供商和模型");
    }
    if (requireSelection) {
      const unavailable = models.find(model => model.provider === state.modelProvider && model.available === false);
      if (unavailable && !models.some(model => model.provider === state.modelProvider && model.available !== false)) {
        this.requireAvailableModel(unavailable);
      }
    }
    return state;
  }

  async selectSetting(target: ConversationTarget, selection: ModelSelectionRequest, assertAuthorized?: () => void): Promise<ModelSelectionState> {
    const expected: SelectionExpectation = {
      threadId: this.router.current(target)?.threadId,
      scope: selection.snapshot.selectionScope,
    };
    const guard = this.selectionGuard(target, assertAuthorized, expected);
    guard();
    const current = await this.state(target, false, guard, expected);
    guard();
    if (JSON.stringify(modelSelectionSnapshot(current)) !== JSON.stringify(modelSelectionSnapshot(selection.snapshot))) {
      throw new UserFacingError("model.selection.expired", "模型设置已变化，请重新打开选择卡片");
    }
    expected.snapshot = modelSelectionSnapshot(current);
    expected.defaults = this.selectionDefaults(target, expected.snapshot);
    switch (selection.kind) {
      case "browse-provider":
        return this.browseProvider(target, selection.provider, assertAuthorized, expected);
      case "model":
        return this.selectModel(target, selection, assertAuthorized, expected);
      case "effort":
        return this.selectEffort(target, selection.effort, assertAuthorized, expected);
      case "fast":
        return this.selectFastMode(target, selection.mode, assertAuthorized, expected);
    }
  }

  async browseProvider(target: ConversationTarget, provider: string, assertAuthorized?: () => void, expected?: SelectionExpectation): Promise<ModelSelectionState> {
    assertAuthorized = this.selectionGuard(target, assertAuthorized, expected);
    const catalog = await this.listModels(!expected && /^\d+$/.test(provider.trim()) ? undefined : provider.trim(), assertAuthorized);
    const { models } = catalog;
    const resolvedProvider = expected
      ? listProviders(this.selectableModels(models)).find(entry => entry === provider)
      : resolveProvider(this.selectableModels(models), provider);
    if (resolvedProvider === undefined) {
      throw new UserFacingError(
        "model.provider.not-found",
        `找不到指定提供商：${provider}`,
        { provider },
      );
    }
    const filtered = filterModelsByProvider(models, resolvedProvider);
    if (filtered.length === 0) {
      throw new UserFacingError(
        "model.provider.no-models",
        `提供商 ${resolvedProvider} 下没有可用模型`,
        { provider: resolvedProvider },
      );
    }
    await this.validateSelection(target, catalog, assertAuthorized, expected);
    assertAuthorized?.();
    this.providerFilterByConversation.set(this.key(target), resolvedProvider);
    this.acceptSelectionChange(target, expected);
    // A new page must use the same directed catalog coverage as its next
    // refresh, not capabilities retained only by the preceding operation.
    return this.selectionState(target, catalog, resolvedProvider, assertAuthorized);
  }

  clearProviderBrowse(target: ConversationTarget, assertAuthorized?: () => void): void {
    assertAuthorized?.();
    this.providerFilterByConversation.delete(this.key(target));
  }

  async requireInputModality(
    target: ConversationTarget,
    modality: ModelInputModality,
    assertAuthorized?: () => void,
  ): Promise<void> {
    assertAuthorized = this.selectionGuard(target, assertAuthorized);
    const current = await this.resolveState(
      target, await this.listModels(this.status(target).modelProvider, assertAuthorized), undefined, assertAuthorized,
    );
    assertAuthorized?.();
    if (current.modelProvider === undefined) {
      throw new UserFacingError("model.provider.selection-required", "请先通过 /model 选择提供商和模型");
    }
    const model = findModel(current.models, current.model, current.modelProvider);
    if (!model) {
      throw new UserFacingError(
        "model.current.missing",
        `当前模型不在可用模型列表中：${current.model}`,
        { model: current.model },
      );
    }
    this.requireAvailableModel(model);
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

  async selectModel(target: ConversationTarget, selector: string | ModelSelectionIdentity, assertAuthorized?: () => void,
    expected: SelectionExpectation = { threadId: this.router.current(target)?.threadId }): Promise<ModelSelectionState> {
    assertAuthorized = this.selectionGuard(target, assertAuthorized, expected);
    const providerFilter = this.providerFilterByConversation.get(this.key(target));
    const catalog = await this.listModels(typeof selector === "string" ? providerFilter : selector.provider, assertAuthorized);
    const { models } = catalog;
    const eligible = this.selectableModels(models);
    const selectableModels = providerFilter === undefined
      ? eligible
      : filterModelsByProvider(eligible, providerFilter);
    const selected = typeof selector === "string"
      ? resolveModel(selectableModels, selector)
      : findModel(eligible, selector.model, selector.provider);
    if (!selected) {
      throw new UserFacingError("model.selection.expired", "模型选项已失效，请重新发送 /model 选择");
    }
    this.requireAvailableModel(selected);
    const current = await this.resolveState(target, catalog, undefined, assertAuthorized, !expected.snapshot, expected);
    assertAuthorized?.();
    const selectedProvider = selected.provider ?? "openai";
    const providerChanged = selectedProvider !== current.modelProvider;
    const leavesThread = providerChanged && this.router.modelSettings(target) !== undefined;
    const resetOfficialFast = selectedProvider === "openai";
    const selectedFastTier = fastServiceTierId(selected);
    const selectedUltrafastTier = ultrafastServiceTierId(selected);
    const providerDefaultEffort = providerChanged
      ? await this.codex.readDefaultReasoningEffort(
          this.router.workspace(target).cwd,
          selectedProvider,
          assertAuthorized,
        )
      : undefined;
    assertAuthorized?.();
    const providerDefaultTier = providerChanged && (selectedFastTier || selectedUltrafastTier) && !resetOfficialFast
      ? await this.codex.readDefaultServiceTier(
          this.router.workspace(target).cwd,
          selectedProvider,
          assertAuthorized,
        )
      : undefined;
    assertAuthorized?.();
    this.requireSubscribedProvider(selectedProvider);
    const supported = selected.supportedReasoningEfforts.map((option) => option.effort);
    const effort = !providerChanged && current.effort && supported.includes(current.effort)
      ? current.effort
      : providerDefaultEffort && supported.includes(providerDefaultEffort)
        ? providerDefaultEffort
        : selected.defaultReasoningEffort;
    const pending = { ...this.pending(target) };
    if (providerChanged) {
      delete pending.serviceTier;
    }
    const currentModel = findModel(current.models, current.model, current.modelProvider);
    const currentFast = current.serviceTierKnown && isFastServiceTier(current.serviceTier, currentModel);
    const nextPending: TurnOverrides = {
      ...pending,
      model: selected.model,
      modelProvider: selectedProvider,
      effort,
      ...(resetOfficialFast
        ? { serviceTier: standardServiceTierRequestValue }
        : providerChanged
        ? selectedFastTier || selectedUltrafastTier
          ? {
              serviceTier: providerDefaultTier === "ultrafast"
                ? selectedUltrafastTier ?? standardServiceTierRequestValue
                : isFastServiceTier(providerDefaultTier ?? null, selected)
                  ? selectedFastTier ?? standardServiceTierRequestValue
                  : standardServiceTierRequestValue,
            }
          : {}
        : current.serviceTierKnown && current.serviceTier === "ultrafast"
          ? { serviceTier: selectedUltrafastTier ?? standardServiceTierRequestValue }
          : currentFast
          ? { serviceTier: selectedFastTier ?? standardServiceTierRequestValue }
          : current.serviceTierKnown && current.serviceTier && current.serviceTier !== standardServiceTierRequestValue
            ? { serviceTier: standardServiceTierRequestValue }
            : {}),
    };
    if (nextPending.serviceTier && nextPending.serviceTier !== standardServiceTierRequestValue) {
      assertAuthorized?.();
      const acceleration = await this.codex.readModelAccelerationSettings(this.router.workspace(target).cwd, selectedProvider, assertAuthorized);
      assertAuthorized?.();
      if (!(nextPending.serviceTier === "ultrafast" ? acceleration.ultrafastEnabled : acceleration.fastEnabled)) {
        nextPending.serviceTier = standardServiceTierRequestValue;
      }
    }
    await this.validateSelection(target, catalog, assertAuthorized, expected);
    if (resetOfficialFast) {
      // 与显式 /fast off 使用同一用户默认值，避免 App Server 重启后重新加载旧 Fast 偏好。
      // Finish inherited-state checks first: a successful user-layer write need
      // not replace a Workspace override. The explicit pending tier follows.
      await this.codex.writeDefaultServiceTier("default", assertAuthorized);
      assertAuthorized?.();
    }
    if (providerChanged) {
      assertAuthorized?.();
      await this.router.newSession(target, false, {
        model: selected.model, modelProvider: selectedProvider,
        effort, serviceTier: nextPending.serviceTier ?? null,
      }, undefined, assertAuthorized, () => {
        // Advance at the synchronous commit, before callbacks or an await can
        // expose another actor's changes. Removal by anyone else still fails.
        expected.threadId = undefined;
        this.acceptSelectionChange(target, expected);
      });
    }
    if (!resetOfficialFast) await this.validateSelection(target, catalog, assertAuthorized, expected);
    assertAuthorized?.();
    this.requireSubscribedProvider(selectedProvider);
    this.setPending(target, nextPending, assertAuthorized, true);
    if (leavesThread) this.pendingProviderSwitches.add(this.key(target));
    this.providerFilterByConversation.set(this.key(target), selectedProvider);
    this.acceptSelectionChange(target, expected);
    assertAuthorized?.();
    return this.selectionState(target, catalog, selectedProvider, assertAuthorized, expected);
  }

  async selectEffort(target: ConversationTarget, selector: string, assertAuthorized?: () => void, expected?: SelectionExpectation): Promise<ModelSelectionState> {
    assertAuthorized = this.selectionGuard(target, assertAuthorized, expected);
    const catalog = await this.listModels(this.status(target).modelProvider, assertAuthorized);
    const { models } = catalog;
    const current = await this.resolveState(target, catalog, undefined, assertAuthorized, false, expected);
    assertAuthorized?.();
    const model = findModel(models, current.model, current.modelProvider);
    if (!model) {
      throw new UserFacingError(
        "model.current.missing",
        `当前模型不在可用模型列表中：${current.model}`,
        { model: current.model },
      );
    }
    this.requireAvailableModel(model);
    const options = model.supportedReasoningEfforts.map((option) => option.effort);
    const effort = expected ? options.find(option => option === selector) : resolveEffort(options, selector);
    if (effort === undefined) {
      throw new UserFacingError("model.selection.expired", "思考等级选项已失效，请重新打开选择卡片");
    }
    await this.validateSelection(target, catalog, assertAuthorized, expected);
    const pending = this.pending(target);
    this.setPending(target, { ...pending, effort }, assertAuthorized);
    this.acceptSelectionChange(target, expected);
    // Publish the same catalog scope and selectable projection as a page refresh;
    // the directed current-model lookup is only for validating this operation.
    return this.state(target, false, assertAuthorized, expected);
  }

  async selectFastMode(target: ConversationTarget, selector: string, assertAuthorized?: () => void, expected?: SelectionExpectation): Promise<ModelSelectionState> {
    assertAuthorized = this.selectionGuard(target, assertAuthorized, expected);
    const normalized = selector.trim().toLowerCase();
    if (normalized && !new Set(["on", "ultrafast", "off", "status"]).has(normalized)) {
      throw new UserFacingError("fast.usage", "加速参数必须是 on、ultrafast、off 或 status");
    }
    const catalog = await this.listModels(this.status(target).modelProvider, assertAuthorized);
    const { models } = catalog;
    const current = await this.resolveState(target, catalog, undefined, assertAuthorized, false, expected);
    assertAuthorized?.();
    const model = findModel(models, current.model, current.modelProvider);
    const currentFast = isFastServiceTier(current.serviceTier, model);
    if (normalized === "status") {
      return current;
    }
    if (!normalized && current.serviceTierKnown !== true) {
      throw new UserFacingError("fast.selection.unknown", "当前用户选择未知，请明确指定速度档位");
    }
    const accelerated = currentFast || current.serviceTier === "ultrafast";
    const requested = normalized || (accelerated ? "off" : "on");
    if (requested !== "off" && model) this.requireAvailableModel(model);
    const tierId = model
      ? requested === "ultrafast" ? ultrafastServiceTierId(model) : fastServiceTierId(model)
      : undefined;
    // Standard is always a valid escape from an active tier, even if the catalog changed.
    if (requested !== "off" && !tierId) {
      throw new UserFacingError(
        "fast.unsupported",
        `当前模型不支持 ${requested === "ultrafast" ? "Ultrafast" : "Fast"}：${current.model}`,
        { model: current.model, tier: requested === "ultrafast" ? "Ultrafast" : "Fast" },
      );
    }
    if (requested !== "off") {
      assertAuthorized?.();
      const acceleration = await this.codex.readModelAccelerationSettings(
        this.router.workspace(target).cwd,
        current.modelProvider ?? this.primaryProvider,
        assertAuthorized,
      );
      assertAuthorized?.();
      if (!(requested === "ultrafast" ? acceleration.ultrafastEnabled : acceleration.fastEnabled)) {
        throw new UserFacingError("fast.disabled", `Codex ${requested === "ultrafast" ? "Ultrafast" : "Fast"} 已关闭或受策略限制，不能启用该档位`);
      }
    }
    const selectedTier = requested === "off" ? standardServiceTierRequestValue : tierId!;
    this.requireSubscribedProvider(current.modelProvider ?? this.primaryProvider);
    await this.validateSelection(target, catalog, assertAuthorized, expected);
    assertAuthorized?.();
    if (current.modelProvider === this.primaryProvider) {
      await this.codex.writeDefaultServiceTier(
        requested === "off" ? "default" : requested === "ultrafast" ? "ultrafast" : "fast",
        assertAuthorized,
      );
    }
    assertAuthorized?.();
    this.requireSubscribedProvider(current.modelProvider ?? this.primaryProvider);
    this.explicitServiceTierByConversation.add(this.key(target));
    if (current.serviceTierKnown === true && current.serviceTier === selectedTier) {
      return current;
    }
    const pending = this.pending(target);
    this.setPending(target, {
      ...pending,
      serviceTier: selectedTier,
    }, assertAuthorized, true);
    this.acceptSelectionChange(target, expected);
    return this.resolveState(target, catalog, undefined, assertAuthorized, false, expected);
  }

  turnOverrides(target: ConversationTarget): TurnOverrides {
    return { ...this.pending(target) };
  }

  hasPending(target: ConversationTarget): boolean {
    return this.pending(target) !== undefined;
  }

  threadStartOptions(target: ConversationTarget) {
    const pending = this.pending(target);
    if (!this.router.current(target) && this.officialUnavailable()) {
      const selection = pending?.modelProvider
        ? { provider: pending.modelProvider, model: pending.model }
        : this.defaultThirdPartySelection();
      if (!selection) {
        throw new UserFacingError(
          this.thirdPartyProviders().length === 0
            ? "model.official.not-logged-in"
            : "model.provider.selection-required",
          "请先通过 /model 选择提供商和模型",
        );
      }
      this.requireSubscribedProvider(selection.provider);
      const model = pending?.model ?? selection.model;
      return {
        ...(model === undefined ? {} : { model }),
        modelProvider: selection.provider,
      };
    }
    return {
      ...(pending?.model ? { model: pending.model } : {}),
      ...(pending?.modelProvider
        ? { modelProvider: pending.modelProvider }
        : {}),
    };
  }

  capturePreference(target: ConversationTarget): ModelSelectionPreference | undefined {
    const pending = this.pending(target);
    const current = this.router.modelSettings(target);
    const model = pending?.model ?? current?.model;
    if (!model) return undefined;
    const serviceTierPending = hasServiceTierOverride(pending);
    if (!serviceTierPending && current && current.serviceTierKnown !== true) {
      throw new UserFacingError("fast.selection.unknown", "当前用户选择的速度档位未知，无法固定保存");
    }
    return {
      model,
      modelProvider: pending?.modelProvider ?? this.normalizeProvider(current?.modelProvider)
        ?? this.primaryProvider,
      effort: pending?.effort ?? current?.effort ?? null,
      serviceTier: serviceTierPending
        ? pending?.serviceTier ?? null
        : current?.serviceTier ?? null,
      ...(this.explicitServiceTierByConversation.has(this.key(target)) ? { serviceTierExplicit: true } : {}),
    };
  }

  restorePreference(
    target: ConversationTarget,
    preference: ModelSelectionPreference | undefined,
  ): void {
    const key = this.key(target);
    this.pendingByConversation.delete(key);
    this.explicitServiceTierByConversation.delete(key);
    this.pendingProviderSwitches.delete(key);
    if (!preference) {
      this.router.setModelPreference?.(target, undefined);
      return;
    }
    const currentProvider = this.normalizeProvider(
      this.router.modelSettings(target)?.modelProvider,
    )
      ?? this.primaryProvider;
    const preferredProvider = this.router.modelSettings(target)?.modelProvider === preference.modelProvider
      ? this.normalizeProvider(preference.modelProvider) ?? preference.modelProvider
      : preference.modelProvider;
    if (this.router.current(target) && currentProvider !== preferredProvider) return;
    this.setPending(target, {
      model: preference.model,
      modelProvider: preferredProvider,
      ...(preference.effort ? { effort: preference.effort } : {}),
      serviceTier: preference.serviceTier,
    }, undefined, preference.serviceTierExplicit === true);
  }

  markApplied(target: ConversationTarget, submittedSettings: ThreadModelSettings | undefined): void {
    const key = this.key(target);
    const pending = this.pending(target);
    const binding = this.router.current(target);
    const current = this.router.modelSettings(target);
    // Notifications and subscription loss replace the snapshot synchronously.
    // A late response must not overwrite newer settings or revive lost evidence.
    if (pending && binding && current && current === submittedSettings) {
      this.router.updateModelSettings(binding.threadId, {
        model: pending.model ?? current.model,
        modelProvider: this.normalizeProvider(pending.modelProvider ?? current.modelProvider)
          ?? this.primaryProvider,
        effort: pending.effort ?? current.effort,
        serviceTier: hasServiceTierOverride(pending)
          ? pending.serviceTier ?? null
          : current.serviceTier,
        serviceTierKnown: hasServiceTierOverride(pending) || current.serviceTierKnown === true,
        // Successful submission proves acceptance, not the feature/model-filtered tier.
        effectiveServiceTier: undefined,
        collaborationMode: current.collaborationMode,
      });
    }
    this.pendingByConversation.delete(key);
    this.explicitServiceTierByConversation.delete(key);
    this.pendingProviderSwitches.delete(key);
  }

  clear(target: ConversationTarget, assertAuthorized?: () => void): void {
    assertAuthorized?.();
    this.router.setModelPreference?.(target, undefined);
    this.pendingByConversation.delete(this.key(target));
    this.explicitServiceTierByConversation.delete(this.key(target));
    this.pendingProviderSwitches.delete(this.key(target));
    this.providerFilterByConversation.delete(this.key(target));
  }

  status(target: ConversationTarget): Omit<ModelSelectionState, "models"> {
    const pending = this.pending(target);
    const current = this.router.modelSettings(target);
    const fallback = !pending?.modelProvider && !current && this.officialUnavailable()
      ? this.defaultThirdPartySelection(false)
      : undefined;
    const serviceTierPending = hasServiceTierOverride(pending);
    const provider = pending?.modelProvider ?? this.normalizeProvider(current?.modelProvider)
      ?? fallback?.provider ?? (this.officialUnavailable() ? undefined : this.primaryProvider);
    return {
      selectionScope: this.selectionScope(target),
      model: pending?.model ?? current?.model ?? fallback?.model
        ?? (this.officialUnavailable() ? "请选择模型" : this.configuredDefaultModel ?? "默认模型"),
      ...(provider === undefined ? {} : { modelProvider: provider }),
      effort: pending?.effort ?? current?.effort ?? null,
      serviceTier: serviceTierPending ? pending?.serviceTier ?? null : current?.serviceTier ?? null,
      serviceTierKnown: serviceTierPending || current?.serviceTierKnown === true,
      ...(current?.effectiveServiceTier === undefined ? {} : { effectiveServiceTier: current.effectiveServiceTier }),
      pending: pending !== undefined,
      modelPending: hasOverride(pending, "model"),
      effortPending: hasOverride(pending, "effort"),
      serviceTierPending,
      providerPending: this.isProviderSwitchPending(target),
    };
  }

  private async resolveState(
    target: ConversationTarget,
    catalog: ModelCatalog,
    filter?: string,
    assertAuthorized?: () => void,
    skipConfiguredDefault = false,
    expected?: SelectionExpectation,
  ): Promise<ModelSelectionState> {
    assertAuthorized?.();
    if (expected?.catalog) {
      // A directed lookup cannot disprove identities or capabilities from a
      // source it did not query. Replace only sources represented by this read.
      const providers = catalog.queriedProviders;
      const previousProviders = new Set(expected.catalog.models.map(model => model.provider ?? "openai"));
      catalog = {
        models: [
          ...expected.catalog.models.filter(model => !providers.has(model.provider ?? "openai")),
          ...catalog.models.filter(model => providers.has(model.provider ?? "openai") || !previousProviders.has(model.provider ?? "openai")),
        ],
        queriedProviders: providers,
        confirmedProviders: new Set([
          ...[...expected.catalog.confirmedProviders].filter(provider => !providers.has(provider)),
          ...catalog.confirmedProviders,
        ]),
      };
    }
    const selectionScope = this.selectionScope(target);
    filter ??= this.providerFilterByConversation.get(this.key(target));
    const { models, confirmedProviders } = catalog;
    if (models.length === 0) {
      throw new Error("App Server 没有返回可用模型");
    }
    const pending = this.pending(target);
    const current = this.router.modelSettings(target);
    const selectedProvider = pending?.modelProvider ?? this.normalizeProvider(current?.modelProvider);
    const useConfiguredDefault = !pending?.model && !current?.model && !skipConfiguredDefault && !this.officialUnavailable()
      && (selectedProvider === undefined || selectedProvider === this.primaryProvider);
    const configuredDefault = useConfiguredDefault && this.configuredDefaultModel
      ? findModel(models, this.configuredDefaultModel, this.primaryProvider)
      : undefined;
    if (useConfiguredDefault && this.configuredDefaultModel && !configuredDefault && confirmedProviders.has(this.primaryProvider)) {
      throw new UserFacingError(
        "model.configured-default.missing",
        `配置的默认模型不属于当前主 Provider ${this.primaryProvider}：${this.configuredDefaultModel}`,
        {
          model: this.configuredDefaultModel,
          provider: this.primaryProvider,
        },
      );
    }
    const thirdPartyDefault = !current && !pending?.modelProvider && this.officialUnavailable()
      ? this.defaultThirdPartySelection(false)
      : undefined;
    if (thirdPartyDefault && thirdPartyDefault.model === undefined
      && confirmedProviders.has(thirdPartyDefault.provider) && !skipConfiguredDefault) {
      this.defaultThirdPartySelection();
    }
    const fallback = this.officialUnavailable()
      ? thirdPartyDefault?.model !== undefined
        ? findModel(models, thirdPartyDefault.model, thirdPartyDefault.provider)
        : undefined
      : configuredDefault
      ?? models.find((model) =>
        model.available !== false && model.isDefault && (model.provider ?? "openai") === this.primaryProvider)
      ?? models.find((model) => model.available !== false && (model.provider ?? "openai") === this.primaryProvider);
    if (thirdPartyDefault?.model !== undefined && !fallback && confirmedProviders.has(thirdPartyDefault.provider) && !skipConfiguredDefault) {
      throw new UserFacingError("model.current.missing", "默认模型不在可用模型列表中", {
        model: thirdPartyDefault.model,
      });
    }
    const model = pending?.model ?? current?.model ?? thirdPartyDefault?.model
      ?? (!this.officialUnavailable() ? this.configuredDefaultModel ?? fallback?.model ?? "默认模型" : "请选择模型");
    const provider = pending?.modelProvider ?? this.normalizeProvider(
      current?.modelProvider ?? thirdPartyDefault?.provider
        ?? (this.officialUnavailable() ? undefined : this.primaryProvider),
    );
    const catalogModel = provider === undefined ? undefined : findModel(models, model, provider);
    const serviceTierPending = hasServiceTierOverride(pending);
    const canReadDefaultServiceTier = !serviceTierPending && !current && provider !== undefined
      && catalogModel !== undefined && catalogModel.available !== false;
    const defaultServiceTier = canReadDefaultServiceTier
      ? await this.codex.readDefaultServiceTier(this.router.workspace(target).cwd, provider, assertAuthorized)
      : null;
    assertAuthorized?.();
    if (this.selectionScope(target) !== selectionScope) {
      throw new UserFacingError("model.selection.expired", "模型设置已变化，请重新打开选择卡片");
    }
    const state: ModelSelectionState = {
      selectionScope,
      models,
      ...(filter === undefined ? {} : { providerFilter: filter }),
      model,
      ...(provider === undefined ? {} : { modelProvider: provider }),
      effort: pending?.effort ?? current?.effort
        ?? (catalogModel?.available !== false ? catalogModel?.defaultReasoningEffort ?? null : null),
      serviceTier: serviceTierPending
        ? pending?.serviceTier ?? null
        : current
          ? current.serviceTier
          : defaultServiceTier,
      serviceTierKnown: serviceTierPending || (current ? current.serviceTierKnown === true : canReadDefaultServiceTier),
      ...(current?.effectiveServiceTier === undefined ? {} : { effectiveServiceTier: current.effectiveServiceTier }),
      pending: pending !== undefined,
      modelPending: hasOverride(pending, "model"),
      effortPending: hasOverride(pending, "effort"),
      serviceTierPending,
      providerPending: this.isProviderSwitchPending(target),
    };
    if (expected?.snapshot
      && JSON.stringify(modelSelectionSnapshot(state)) !== JSON.stringify(expected.snapshot)) {
      throw new UserFacingError("model.selection.expired", "模型设置已变化，请重新打开选择卡片");
    }
    if (expected) expected.catalog = catalog;
    return state;
  }

  private isProviderSwitchPending(target: ConversationTarget): boolean {
    const key = this.key(target);
    const selected = this.pending(target)?.modelProvider;
    if (selected === undefined) return false;
    const current = this.router.modelSettings(target);
    return current
      ? this.normalizeProvider(selected) !== this.normalizeProvider(current.modelProvider ?? this.primaryProvider)
      : this.pendingProviderSwitches.has(key);
  }

  private selectionScope(target: ConversationTarget): string {
    const workspaceId = this.router.selectedWorkspaceId(target);
    const cwd = this.router.listWorkspaces().find(workspace => workspace.id === workspaceId)?.cwd;
    const binding = this.router.current(target);
    const current = this.router.modelSettings(target);
    const pending = this.pending(target);
    return createHash("sha256").update(JSON.stringify([
      conversationTargetKey(target), workspaceId, cwd ?? null,
      binding?.threadId ?? null, binding?.sessionId ?? null,
      current ? [current.model, current.modelProvider, current.effort, current.serviceTier,
        current.serviceTierKnown, current.effectiveServiceTier] : null,
      pending ? [pending.model, pending.modelProvider, pending.effort, pending.serviceTier,
        hasOverride(pending, "model"), hasOverride(pending, "effort"), hasServiceTierOverride(pending)] : null,
      this.pendingProviderSwitches.has(this.key(target)),
      this.providerFilterByConversation.get(this.key(target)) ?? null,
    ])).digest("base64url");
  }

  private acceptSelectionChange(target: ConversationTarget, expected?: SelectionExpectation): void {
    if (expected?.scope !== undefined) expected.scope = this.selectionScope(target);
    if (!expected?.snapshot) return;
    const previous = expected.snapshot;
    const pending = this.pending(target);
    const current = this.router.modelSettings(target);
    const status = this.status(target);
    const filter = this.providerFilterByConversation.get(this.key(target));
    expected.snapshot = modelSelectionSnapshot({
      ...status,
      ...(filter === undefined ? {} : { providerFilter: filter }),
      model: pending?.model ?? current?.model ?? previous.model,
      effort: pending?.effort ?? current?.effort ?? previous.effort,
      serviceTier: hasServiceTierOverride(pending) || current ? status.serviceTier : previous.serviceTier,
    });
    expected.defaults = this.selectionDefaults(target, expected.snapshot);
  }

  private selectionDefaults(target: ConversationTarget, snapshot: ModelSelectionSnapshot): string {
    const pending = this.pending(target);
    const current = this.router.modelSettings(target);
    const fallback = !pending?.modelProvider && !current && this.officialUnavailable()
      ? this.defaultThirdPartySelection(false) : undefined;
    const effort = !pending?.effort && !current?.effort
      ? this.supplementaryModels.find(model => model.model === snapshot.model
        && (model.provider ?? "openai") === snapshot.modelProvider)?.defaultReasoningEffort
      : undefined;
    return JSON.stringify([this.officialUnavailable(), fallback ?? null, effort ?? null]);
  }

  private async validateSelection(target: ConversationTarget, catalog: ModelCatalog, assertAuthorized?: () => void,
    expected?: SelectionExpectation): Promise<void> {
    if (expected?.snapshot) await this.resolveState(target, catalog, undefined, assertAuthorized, false, expected);
  }

  private requireAvailableModel(model: ModelOption): void {
    if (model.available !== false) return;
    throw new UserFacingError("model.unavailable", `${model.displayName} 暂不可用${model.unavailableReason ? `：${model.unavailableReason}` : ""}`, {
      model: model.model,
      ...(model.provider ? {provider: model.provider} : {}),
      ...(model.unavailableReason ? {reason: model.unavailableReason} : {}),
    });
  }

  private requireSubscribedProvider(provider: string): void {
    if (this.providersWithoutSubscription().has(provider)) {
      throw new UserFacingError("model.selection.expired", "账户已无有效订阅，请重新发送 /model 选择");
    }
  }

  private officialUnavailable(): boolean {
    return this.primaryProvider === "openai" && !this.openaiAuthenticated();
  }

  private thirdPartyProviders(): string[] {
    const blocked = this.providersWithoutSubscription();
    return [...new Set([
      ...this.supplementaryModels.filter((model) => model.available !== false)
        .map((model) => model.provider ?? "openai"),
      ...this.officialCatalogProviders.map((provider) => provider.provider),
      ...this.independentCatalogProviders.map((provider) => provider.provider),
    ])].filter((provider) => provider !== "openai" && !blocked.has(provider));
  }

  private defaultThirdPartySelection(requireModel = true): { provider: string; model?: string } | undefined {
    const providers = this.thirdPartyProviders();
    const provider = this.defaultThirdPartyProvider !== undefined
      && providers.includes(this.defaultThirdPartyProvider)
      ? this.defaultThirdPartyProvider
      : providers.length === 1 ? providers[0] : undefined;
    if (provider === undefined) return undefined;
    const model = [...this.officialCatalogProviders, ...this.independentCatalogProviders].find((entry) => entry.provider === provider)?.defaultModel
      ?? this.independentCatalogDefaults.get(provider)
      ?? this.supplementaryModels.find((entry) => entry.provider === provider && entry.isDefault)?.model;
    if (!model && requireModel) {
      throw new UserFacingError("model.provider.default-missing", "提供商默认模型未配置", { provider });
    }
    return { provider, ...(model === undefined ? {} : { model }) };
  }

  private selectableModels(models: ModelOption[]): ModelOption[] {
    const blocked = this.providersWithoutSubscription();
    return models.filter((model) => !blocked.has(model.provider ?? "openai"));
  }

  private async selectionState(target: ConversationTarget, catalog: ModelCatalog, filter?: string, assertAuthorized?: () => void,
    expected?: SelectionExpectation): Promise<ModelSelectionState> {
    const selectable = this.selectableModels(catalog.models);
    const state = await this.resolveState(target, catalog, filter, assertAuthorized, false, expected);
    assertAuthorized?.();
    return {
      ...state,
      models: filter === undefined ? selectable : filterModelsByProvider(selectable, filter),
    };
  }

  private pending(target: ConversationTarget): TurnOverrides | undefined {
    const pending = this.pendingByConversation.get(this.key(target));
    if (pending) return pending;
    const preference = this.router.modelPreference?.(target);
    return preference ? {
      model: preference.model, modelProvider: preference.modelProvider,
      ...(preference.effort === null ? {} : { effort: preference.effort }),
      serviceTier: preference.serviceTier,
    } : undefined;
  }

  private setPending(target: ConversationTarget, pending: TurnOverrides, assertAuthorized?: () => void,
    explicitServiceTier = false): void {
    assertAuthorized?.();
    const previous = this.pending(target);
    if (explicitServiceTier && hasServiceTierOverride(pending)) {
      this.explicitServiceTierByConversation.add(this.key(target));
    } else if (pending.serviceTier !== previous?.serviceTier) {
      this.explicitServiceTierByConversation.delete(this.key(target));
    }
    if (this.router.setModelPreference && !this.router.current(target) && pending.model && pending.modelProvider) {
      this.router.setModelPreference(target, {
        model: pending.model, modelProvider: pending.modelProvider,
        effort: pending.effort ?? null, serviceTier: pending.serviceTier ?? null,
      });
      this.pendingByConversation.delete(this.key(target));
    } else {
      this.pendingByConversation.set(this.key(target), pending);
    }
  }

  /** Recheck saved identities; App Server filters retained speed choices at execution. */
  async validateUnboundPreference(target: ConversationTarget, assertAuthorized?: () => void): Promise<void> {
    assertAuthorized = this.selectionGuard(target, assertAuthorized);
    assertAuthorized?.();
    const preference = this.router.modelPreference?.(target);
    const pending = this.pending(target);
    if (this.explicitServiceTierByConversation.has(this.key(target))
      && pending?.serviceTier && pending.serviceTier !== standardServiceTierRequestValue) {
      const provider = pending.modelProvider ?? this.router.modelSettings(target)?.modelProvider ?? this.primaryProvider;
      const acceleration = await this.codex.readModelAccelerationSettings(this.router.workspace(target).cwd, provider, assertAuthorized);
      assertAuthorized?.();
      if (!(pending.serviceTier === "ultrafast" ? acceleration.ultrafastEnabled : acceleration.fastEnabled)) {
        throw new UserFacingError("model.selection.expired", "待生效的加速档位已关闭或受策略限制，请发送 /fast off 或重新选择档位");
      }
    }
    const explicitTier = this.explicitServiceTierByConversation.has(this.key(target));
    const selection = preference ?? (explicitTier && pending ? {
      model: pending.model ?? this.router.modelSettings(target)?.model,
      modelProvider: pending.modelProvider ?? this.router.modelSettings(target)?.modelProvider ?? this.primaryProvider,
      effort: pending.effort,
      serviceTier: pending.serviceTier,
    } : undefined);
    if (!selection) return;
    const { models } = await this.listModels(selection.modelProvider, assertAuthorized);
    assertAuthorized?.();
    const model = selection.model === undefined ? undefined : findModel(models, selection.model, selection.modelProvider);
    if (!model) {
      throw new UserFacingError("model.selection.expired", "保存的模型已不可用，请重新发送 /model 选择");
    }
    this.requireAvailableModel(model);
    this.requireSubscribedProvider(selection.modelProvider);
    if (selection.effort && !model.supportedReasoningEfforts.some(option => option.effort === selection.effort)) {
      throw new UserFacingError("model.selection.expired", "保存的思考等级已不可用，请重新发送 /model 选择");
    }
    if (explicitTier
      && selection.serviceTier && selection.serviceTier !== standardServiceTierRequestValue
      && selection.serviceTier !== fastServiceTierId(model)
      && selection.serviceTier !== ultrafastServiceTierId(model)) {
      throw new UserFacingError("model.selection.expired", "待提交的服务层级已不可用，请重新发送 /model 选择");
    }
  }

  private key(target: ConversationTarget): string {
    return conversationTargetKey(target);
  }

  private selectionGuard(
    target: ConversationTarget,
    assertAuthorized?: () => void,
    expected: SelectionExpectation = { threadId: this.router.current(target)?.threadId },
  ): () => void {
    return () => {
      this.codex.assertModelCatalogActive?.();
      assertAuthorized?.();
      if (this.router.current(target)?.threadId !== expected.threadId) {
        throw new UserFacingError("command.authorization-changed", "模型选择期间会话已变化");
      }
      if (expected.scope !== undefined && this.selectionScope(target) !== expected.scope) {
        throw new UserFacingError("model.selection.expired", "模型设置已变化，请重新打开选择卡片");
      }
      if (expected.snapshot && expected.defaults !== this.selectionDefaults(target, expected.snapshot)) {
        throw new UserFacingError("model.selection.expired", "模型默认设置已变化，请重新打开选择卡片");
      }
    };
  }

  private normalizeProvider(provider: string | undefined): string | undefined {
    if (provider === undefined) return undefined;
    return provider === "openai" && this.primaryProvider !== "openai"
      ? this.primaryProvider
      : provider;
  }

  private async listModels(targetProvider?: string, assertAuthorized?: () => void): Promise<ModelCatalog> {
    let guardFailure: { error: unknown } | undefined;
    const guard = () => {
      if (guardFailure) throw guardFailure.error;
      try {
        this.codex.assertModelCatalogActive?.();
        assertAuthorized?.();
      } catch (error) {
        guardFailure = { error };
        throw error;
      }
    };
    guard();
    const confirmedProviders = new Set<string>();
    const queriedProviders = new Set<string>();
    const needsPrimary = targetProvider === undefined || targetProvider === this.primaryProvider
      || this.officialCatalogProviders.some(provider => provider.provider === targetProvider);
    let primary: ModelOption[] = [];
    if (needsPrimary) {
      queriedProviders.add(this.primaryProvider);
      try {
        primary = (await this.codex.listModels(guard)).map((model) => {
          if (this.primaryProvider === "openai") return model;
          return { ...withoutProviderUpgrade(model), provider: this.primaryProvider };
        });
        guard();
        if (!primary.some(model => model.available !== false)) throw new Error("Primary catalog empty");
        confirmedProviders.add(this.primaryProvider);
      } catch {
        guard();
        primary = [];
      }
    }
    const combined = new Map<string, ModelOption>();
    if (this.primaryProvider !== "openai" || this.openaiAuthenticated()) {
      for (const model of primary) {
        combined.set(modelKey(model), model);
      }
      if (needsPrimary && !confirmedProviders.has(this.primaryProvider)) {
        const unavailable = unavailableCatalogModel(this.primaryProvider, this.primaryProvider, this.configuredDefaultModel);
        combined.set(modelKey(unavailable), unavailable);
      }
    }
    for (const provider of this.officialCatalogProviders) {
      if (!needsPrimary) continue;
      queriedProviders.add(provider.provider);
      if (!confirmedProviders.has(this.primaryProvider)) {
        const unavailable = unavailableCatalogModel(provider.provider, provider.displayName, provider.defaultModel);
        combined.set(modelKey(unavailable), unavailable);
        continue;
      }
      confirmedProviders.add(provider.provider);
      for (const model of primary) {
        const catalogModel = withoutProviderUpgrade(model);
        const aliased = {
          ...catalogModel,
          provider: provider.provider,
          displayName: `${provider.displayName} · ${model.displayName}`,
          isDefault: model.model === provider.defaultModel,
        };
        combined.set(modelKey(aliased), aliased);
      }
    }
    for (const model of this.supplementaryModels) {
      const provider = model.provider ?? "openai";
      if (provider !== this.primaryProvider
        && !this.officialCatalogProviders.some(entry => entry.provider === provider)
        && !this.independentCatalogProviders.some(entry => entry.provider === provider)) {
        queriedProviders.add(provider);
      }
      combined.set(modelKey(model), model);
    }
    const providers = this.independentCatalogProviders.filter(provider =>
      targetProvider === undefined || provider.provider === targetProvider);
    for (const provider of providers) queriedProviders.add(provider.provider);
    const defaultUpdates = new Map<string, string | undefined>();
    // Limit concurrent instance connections, while isolating each catalog failure.
    for (let offset = 0; offset < providers.length; offset += 4) {
      guard();
      const batch = providers.slice(offset, offset + 4);
      const catalogs = await Promise.allSettled(batch.map(async provider => {
        guard();
        if (!this.codex.listModelsForProvider) throw new Error("Provider catalog port unavailable");
        const models = await this.codex.listModelsForProvider(provider.provider, guard);
        guard();
        if (!models.some(model => model.available !== false)) throw new Error("Provider catalog empty");
        const defaultModel = provider.defaultModel
          ?? models.find(model => model.isDefault && model.available !== false)?.model;
        return {
          defaultModel,
          models: models.map(model => ({
            ...withoutProviderUpgrade(model), provider: provider.provider,
            isDefault: model.model === defaultModel,
          })),
        };
      }));
      guard();
      for (const [index, catalog] of catalogs.entries()) {
        const provider = batch[index]!;
        defaultUpdates.set(provider.provider, catalog.status === "fulfilled" ? catalog.value.defaultModel : undefined);
        const models = catalog.status === "fulfilled"
          ? catalog.value.models
          : [unavailableCatalogModel(provider.provider, provider.displayName, provider.defaultModel)];
        if (catalog.status === "fulfilled") confirmedProviders.add(provider.provider);
        for (const model of models) combined.set(modelKey(model), model);
      }
    }
    if (
      combined.size === 0
      && this.primaryProvider === "openai"
      && !this.openaiAuthenticated()
    ) {
      throw new UserFacingError(
        "model.official.not-logged-in",
        "OpenAI 官方未登录，当前没有可用模型；请先运行 codex login",
        { provider: "openai" },
      );
    }
    guard();
    for (const [provider, defaultModel] of defaultUpdates) {
      if (defaultModel === undefined) this.independentCatalogDefaults.delete(provider);
      else this.independentCatalogDefaults.set(provider, defaultModel);
    }
    return { models: [...combined.values()], confirmedProviders, queriedProviders };
  }
}

/** Preserve only configured identity; failed catalogs provide no capability evidence. */
function unavailableCatalogModel(provider: string, displayName: string, defaultModel?: string): ModelOption {
  return {
    provider, id: defaultModel ?? provider, model: defaultModel ?? provider,
    displayName, isDefault: true, available: false,
    unavailableReason: "模型目录暂不可用，请检查对应 App Server 后重试",
    supportedReasoningEfforts: [], defaultReasoningEffort: "none",
    inputModalities: [], serviceTiers: [], defaultServiceTier: null,
  };
}

function withoutProviderUpgrade(model: ModelOption): ModelOption {
  const providerModel = { ...model };
  delete providerModel.upgrade;
  return providerModel;
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

function filterModelsByProvider(
  models: ModelOption[],
  provider: string,
): ModelOption[] {
  const normalizedProvider = provider === "openai" ? "openai" : provider;
  return models.filter(
    (model) => (model.provider ?? "openai") === normalizedProvider,
  );
}

export function listProviders(models: ModelOption[]): string[] {
  const seen = new Set<string>();
  const providers: string[] = [];
  for (const model of models) {
    const provider = model.provider ?? "openai";
    if (!seen.has(provider)) {
      seen.add(provider);
      providers.push(provider);
    }
  }
  return providers;
}

export function resolveProvider(models: ModelOption[], selector: string): string | undefined {
  const normalized = selector.trim();
  if (!normalized) {
    return undefined;
  }
  const providers = listProviders(models);
  if (/^\d+$/.test(normalized)) {
    return providers[Number(normalized) - 1];
  }
  const matches = providers.filter((provider) => provider === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

function modelKey(model: ModelOption): string {
  return `${model.provider ?? "openai"}\0${model.model}`;
}

export function fastServiceTierId(model: ModelOption): string | undefined {
  return acceleratedServiceTierId(model.serviceTiers, "fast");
}

export function ultrafastServiceTierId(model: ModelOption): string | undefined {
  return acceleratedServiceTierId(model.serviceTiers, "ultrafast");
}

export function isFastServiceTier(serviceTier: string | null, model?: ModelOption): boolean {
  if (!serviceTier) {
    return false;
  }
  const normalized = normalizeServiceTier(serviceTier.toLowerCase());
  return normalized === "fast"
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
