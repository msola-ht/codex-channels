import type { CodexAppServerClient } from "../codex-client/client.js";
import type { Thread, ThreadTokenUsage } from "../codex-protocol/index.js";
import type { ReviewTarget } from "../codex-protocol/index.js";
import type { SessionRouter } from "../session-routing/router.js";
import { ConversationCore } from "./core.js";
import type { ConversationTarget } from "./events.js";

export interface Submission {
  threadId: string;
  turnId: string;
  steered: boolean;
}

export interface ConversationStatus {
  threadId?: string;
  turnId?: string;
  cwd: string;
  tokenUsage?: ThreadTokenUsage;
}

export class ConversationService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly codex: CodexAppServerClient,
    private readonly router: SessionRouter,
    private readonly core: ConversationCore,
    private readonly cwd: string,
  ) {}

  submit(target: ConversationTarget, text: string): Promise<Submission> {
    const input = text.trim();
    if (!input) {
      return Promise.reject(new Error("消息不能为空"));
    }
    return this.locked(target, async () => {
      const active = this.core.activeTurn(target);
      if (active) {
        await this.codex.steerTurn(active.threadId, active.turnId, input);
        return { threadId: active.threadId, turnId: active.turnId, steered: true };
      }
      const binding = await this.router.ensure(target);
      const result = await this.codex.startTurn(binding.threadId, input);
      this.core.markTurnStarted(target, binding.threadId, result.turn.id);
      return { threadId: binding.threadId, turnId: result.turn.id, steered: false };
    });
  }

  listSessions(): Promise<Thread[]> {
    return this.router.list();
  }

  resume(target: ConversationTarget, selector: string): Promise<string> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const sessions = await this.router.list();
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

  listModels(): ReturnType<CodexAppServerClient["listModels"]> {
    return this.codex.listModels();
  }

  listSkills(): ReturnType<CodexAppServerClient["listSkills"]> {
    return this.codex.listSkills();
  }

  listMcpServers(target: ConversationTarget): ReturnType<CodexAppServerClient["listMcpServers"]> {
    return this.codex.listMcpServers(this.router.current(target)?.threadId);
  }

  listPlugins(): ReturnType<CodexAppServerClient["listPlugins"]> {
    return this.codex.listPlugins();
  }

  accountUsage(): ReturnType<CodexAppServerClient["accountUsage"]> {
    return this.codex.accountUsage();
  }

  accountRateLimits(): ReturnType<CodexAppServerClient["accountRateLimits"]> {
    return this.codex.accountRateLimits();
  }

  listPermissionProfiles(): ReturnType<CodexAppServerClient["listPermissionProfiles"]> {
    return this.codex.listPermissionProfiles();
  }

  getGoal(target: ConversationTarget): Promise<Awaited<ReturnType<CodexAppServerClient["getGoal"]>>> {
    return this.locked(target, async () => {
      const binding = await this.router.ensure(target);
      return this.codex.getGoal(binding.threadId);
    });
  }

  setGoal(target: ConversationTarget, objective: string): Promise<Awaited<ReturnType<CodexAppServerClient["setGoal"]>>> {
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
    const tokenUsage = binding ? this.core.tokenUsage(binding.threadId) : undefined;
    return {
      ...(binding ? { threadId: binding.threadId } : {}),
      ...(active ? { turnId: active.turnId } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      cwd: this.cwd,
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
