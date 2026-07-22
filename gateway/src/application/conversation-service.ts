import { randomUUID } from "node:crypto";

import type { CodexAppServerClient } from "../codex-client/client.js";
import type {
  GetAccountRateLimitsResponse,
  GetAccountTokenUsageResponse,
  ListMcpServerStatusResponse,
  ModelListResponse,
  PermissionProfileListResponse,
  PluginListResponse,
  ReviewTarget,
  SkillsListResponse,
  Thread,
  ThreadGoal,
  ThreadTokenUsage,
} from "../codex-protocol/index.js";
import type { SessionRouter } from "../session-routing/router.js";
import type { Workspace } from "../policy/workspace-registry.js";
import { ConversationCore } from "../conversation-core/core.js";
import {
  gatewayUserMessageClientIdPrefix,
  type ConversationTarget,
} from "../conversation-core/events.js";

export interface Submission {
  threadId: string;
  turnId: string;
  steered: boolean;
}

export interface ConversationStatus {
  threadId?: string;
  turnId?: string;
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  tokenUsage?: ThreadTokenUsage;
}

export class ConversationService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly codex: CodexAppServerClient,
    private readonly router: SessionRouter,
    private readonly core: ConversationCore,
  ) {}

  submit(target: ConversationTarget, text: string): Promise<Submission> {
    const input = text.trim();
    if (!input) {
      return Promise.reject(new Error("消息不能为空"));
    }
    return this.locked(target, async () => {
      const active = this.core.activeTurn(target);
      const clientUserMessageId = `${gatewayUserMessageClientIdPrefix}${randomUUID()}`;
      if (active) {
        await this.codex.steerTurn(active.threadId, active.turnId, input, clientUserMessageId);
        return { threadId: active.threadId, turnId: active.turnId, steered: true };
      }
      const binding = await this.router.ensure(target);
      const workspace = this.router.workspace(target);
      const result = await this.codex.startTurn(binding.threadId, input, clientUserMessageId, workspace.cwd);
      this.core.markTurnStarted(target, binding.threadId, result.turn.id);
      return { threadId: binding.threadId, turnId: result.turn.id, steered: false };
    });
  }

  listSessions(target: ConversationTarget): Promise<Thread[]> {
    return this.router.list(target);
  }

  resume(target: ConversationTarget, selector: string): Promise<string> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const sessions = await this.router.list(target);
      const selected = resolveThread(sessions, selector.trim());
      const binding = await this.router.resume(target, selected.id);
      return binding.threadId;
    });
  }

  newSession(target: ConversationTarget): Promise<void> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      await this.router.newSession(target);
    });
  }

  listWorkspaces(): Workspace[] {
    return this.router.listWorkspaces();
  }

  selectWorkspace(target: ConversationTarget, selector: string): Promise<Workspace> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const selected = this.router.resolveWorkspace(selector);
      return this.router.selectWorkspace(target, selected.id);
    });
  }

  stop(target: ConversationTarget): Promise<boolean> {
    return this.locked(target, async () => {
      const active = this.core.activeTurn(target);
      if (!active) {
        return false;
      }
      await this.codex.interruptTurn(active.threadId, active.turnId);
      return true;
    });
  }

  rename(target: ConversationTarget, name: string): Promise<void> {
    const normalized = name.trim();
    if (!normalized || normalized.length > 64) {
      return Promise.reject(new Error("会话名称必须为 1–64 个字符"));
    }
    return this.locked(target, async () => {
      this.requireIdle(target);
      const binding = this.router.current(target);
      if (!binding) {
        throw new Error("当前还没有 Codex Thread");
      }
      await this.codex.setThreadName(binding.threadId, normalized);
    });
  }

  compact(target: ConversationTarget): Promise<void> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const binding = await this.router.ensure(target);
      await this.codex.compactThread(binding.threadId);
    });
  }

  fork(target: ConversationTarget): Promise<string> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      await this.router.ensure(target);
      const binding = await this.router.fork(target);
      return binding.threadId;
    });
  }

  review(target: ConversationTarget, reviewTarget: ReviewTarget): Promise<Submission> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const binding = await this.router.ensure(target);
      const result = await this.codex.startReview(binding.threadId, reviewTarget);
      this.core.markTurnStarted(target, result.reviewThreadId, result.turn.id);
      return { threadId: result.reviewThreadId, turnId: result.turn.id, steered: false };
    });
  }

  listModels(): Promise<ModelListResponse["data"]> {
    return this.codex.listModels();
  }

  listSkills(target: ConversationTarget): Promise<SkillsListResponse["data"]> {
    return this.codex.listSkills(this.router.workspace(target).cwd);
  }

  listMcpServers(target: ConversationTarget): Promise<ListMcpServerStatusResponse["data"]> {
    return this.codex.listMcpServers(this.router.current(target)?.threadId);
  }

  listPlugins(target: ConversationTarget): Promise<PluginListResponse> {
    return this.codex.listPlugins(this.router.workspace(target).cwd);
  }

  accountUsage(): Promise<GetAccountTokenUsageResponse> {
    return this.codex.accountUsage();
  }

  accountRateLimits(): Promise<GetAccountRateLimitsResponse> {
    return this.codex.accountRateLimits();
  }

  listPermissionProfiles(target: ConversationTarget): Promise<PermissionProfileListResponse["data"]> {
    return this.codex.listPermissionProfiles(this.router.workspace(target).cwd);
  }

  getGoal(target: ConversationTarget): Promise<ThreadGoal | null> {
    return this.locked(target, async () => {
      const binding = await this.router.ensure(target);
      return this.codex.getGoal(binding.threadId);
    });
  }

  setGoal(target: ConversationTarget, objective: string): Promise<ThreadGoal> {
    const normalized = objective.trim();
    if (!normalized) {
      return Promise.reject(new Error("目标不能为空"));
    }
    return this.locked(target, async () => {
      const binding = await this.router.ensure(target);
      return this.codex.setGoal(binding.threadId, normalized);
    });
  }

  clearGoal(target: ConversationTarget): Promise<void> {
    return this.locked(target, async () => {
      const binding = await this.router.ensure(target);
      await this.codex.clearGoal(binding.threadId);
    });
  }

  status(target: ConversationTarget): ConversationStatus {
    const binding = this.router.current(target);
    const active = this.core.activeTurn(target);
    const workspace = this.router.workspace(target);
    const tokenUsage = binding ? this.core.tokenUsage(binding.threadId) : undefined;
    return {
      ...(binding ? { threadId: binding.threadId } : {}),
      ...(active ? { turnId: active.turnId } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cwd: workspace.cwd,
    };
  }

  private requireIdle(target: ConversationTarget): void {
    if (this.core.activeTurn(target)) {
      throw new Error("当前任务运行中，请先 /stop");
    }
  }

  private async locked<T>(target: ConversationTarget, action: () => Promise<T>): Promise<T> {
    const key = `${target.surface}:${target.conversationId}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    this.locks.set(key, chain);
    await previous;
    try {
      return await action();
    } finally {
      release?.();
      if (this.locks.get(key) === chain) {
        this.locks.delete(key);
      }
    }
  }
}

export function resolveThread(threads: Thread[], selector: string): Thread {
  if (!selector) {
    throw new Error("用法：/resume <序号、名称或 Thread ID>");
  }
  if (/^\d+$/.test(selector)) {
    const index = Number(selector) - 1;
    const thread = threads[index];
    if (thread) {
      return thread;
    }
  }
  const exact = threads.filter((thread) => thread.id === selector || thread.name === selector);
  if (exact.length === 1) {
    return exact[0]!;
  }
  const prefix = threads.filter((thread) => thread.id.startsWith(selector));
  if (prefix.length === 1) {
    return prefix[0]!;
  }
  throw new Error(prefix.length > 1 || exact.length > 1 ? "会话选择不唯一" : "找不到指定会话");
}
