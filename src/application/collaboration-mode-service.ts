import {
  UserFacingError,
  conversationTargetKey,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { SessionRouter } from "../session-routing/index.js";
import type {
  CollaborationModeKind,
  CollaborationModePreset,
  CollaborationModeQueryPort,
} from "./collaboration-mode-port.js";
import type { ModelSelectionService } from "./model-selection-service.js";
import type { TurnCollaborationMode } from "./turn-port.js";

export interface CollaborationModeState {
  mode: CollaborationModeKind;
  pending: boolean;
}

export class CollaborationModeSelectionService {
  private readonly pendingByConversation = new Map<string, TurnCollaborationMode>();
  private presets: CollaborationModePreset[] | undefined;

  constructor(
    private readonly codex: CollaborationModeQueryPort,
    private readonly router: SessionRouter,
    private readonly models: ModelSelectionService,
  ) {}

  async toggle(target: ConversationTarget, assertAuthorized?: () => void): Promise<CollaborationModeState> {
    const current = this.status(target).mode;
    return this.select(target, current === "plan" ? "default" : "plan", assertAuthorized);
  }

  async select(
    target: ConversationTarget,
    mode: CollaborationModeKind,
    assertAuthorized?: () => void,
  ): Promise<CollaborationModeState> {
    assertAuthorized?.();
    const threadId = this.router.current(target)?.threadId;
    const beforeSubmit = () => {
      assertAuthorized?.();
      if (this.router.current(target)?.threadId !== threadId) {
        throw new UserFacingError("command.authorization-changed", "模式选择期间会话已变化");
      }
    };
    const preset = await this.resolvePreset(mode, beforeSubmit);
    const model = await this.models.state(target, true, beforeSubmit);
    beforeSubmit();
    this.pendingByConversation.set(this.key(target), {
      mode,
      settings: {
        model: preset.model ?? model.model,
        effort: preset.effort ?? model.effort,
        developerInstructions: null,
      },
    });
    return this.status(target);
  }

  turnOverride(target: ConversationTarget): TurnCollaborationMode | undefined {
    return this.pendingByConversation.get(this.key(target));
  }

  hasPending(target: ConversationTarget): boolean {
    return this.pendingByConversation.has(this.key(target));
  }

  markApplied(target: ConversationTarget): void {
    const key = this.key(target);
    const pending = this.pendingByConversation.get(key);
    const binding = this.router.current(target);
    if (pending && binding) {
      this.router.updateCollaborationMode(binding.threadId, pending.mode);
    }
    this.pendingByConversation.delete(key);
  }

  clear(target: ConversationTarget): void {
    this.pendingByConversation.delete(this.key(target));
  }

  status(target: ConversationTarget): CollaborationModeState {
    const pending = this.pendingByConversation.get(this.key(target));
    return {
      mode: pending?.mode
        ?? this.router.modelSettings(target)?.collaborationMode
        ?? "default",
      pending: pending !== undefined,
    };
  }

  private async resolvePreset(mode: CollaborationModeKind, beforeSubmit?: () => void): Promise<CollaborationModePreset> {
    beforeSubmit?.();
    if (!this.presets) {
      const presets = await this.codex.listCollaborationModes(beforeSubmit);
      beforeSubmit?.();
      this.presets = presets;
    }
    const preset = this.presets.find((candidate) => candidate.mode === mode);
    if (!preset) {
      throw new UserFacingError(
        "collaboration-mode.unsupported",
        `当前 Codex App Server 不支持 ${mode === "plan" ? "Plan" : "Default"} 模式`,
      );
    }
    return preset;
  }

  private key(target: ConversationTarget): string {
    return conversationTargetKey(target);
  }
}
