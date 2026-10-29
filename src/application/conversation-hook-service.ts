import { randomBytes } from "node:crypto";
import { trimOldestEntries } from "./bounded-map.js";
import { conversationTargetKey, UserFacingError, type ConversationTarget } from "../conversation-core/index.js";
import type { SessionRouter } from "../session-routing/index.js";
import type { ConversationLockCoordinator } from "./conversation-lock-coordinator.js";
import type { ModelSelectionService } from "./model-selection-service.js";
import type { HookAction, HookCatalog, HookCommandView, HookConfigPort, HookEntry, HookReviewPolicy } from "./hook-port.js";
import { pageCountFor, pageSlice, requirePage } from "./pagination.js";

const lifetimeMs = 5 * 60_000;
const pageSize = 8;
const maximumSnapshots = 128;

interface Context {
  surface: string;
  targetKey: string;
  actorId: string;
  workspaceId: string;
  cwd: string;
  provider: string;
  threadId: string | undefined;
}
interface Snapshot extends Context {
  capturedAt: number;
  view: HookCommandView;
}
interface Confirmation extends Context {
  capturedAt: number;
  hooks: HookEntry[];
  action: HookAction | "trust-all";
  version: string;
  view: HookCommandView;
}

/** Only holds short-lived review snapshots. App Server owns Hook configuration. */
export class ConversationHookService {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly confirmations = new Map<string, Confirmation>();

  constructor(
    private readonly locks: ConversationLockCoordinator,
    private readonly router: SessionRouter,
    private readonly models: ModelSelectionService,
    private readonly port: HookConfigPort,
    private readonly authorize: (target: ConversationTarget, actorId: string) => void,
    private readonly reviewPolicy: HookReviewPolicy = () => false,
  ) {}

  async execute(target: ConversationTarget, input: string, actorId?: string, assertAuthorized?: () => void): Promise<HookCommandView> {
    assertAuthorized?.();
    const context = this.context(target, actorId);
    const beforeSubmit = () => {
      assertAuthorized?.();
      if (!sameContext(this.context(target, actorId), context)) throw expired();
    };
    return this.locks.forConversation(target, async () => {
      beforeSubmit();
      this.prune(this.snapshots);
      this.prune(this.confirmations);
      const view = await this.run(context, input, beforeSubmit);
      beforeSubmit();
      return view;
    });
  }

  private async run(context: Context, input: string, beforeSubmit: () => void): Promise<HookCommandView> {
    const parts = input.trim().split(/\s+/u).filter(Boolean);
    if (parts.length === 0 || (parts.length === 2 && parts[0] === "page" && /^[1-9]\d*$/u.test(parts[1]!))) {
      return this.list(context, parts.length === 0 ? 1 : Number(parts[1]), beforeSubmit);
    }
    if (parts.length === 2 && parts[0] === "confirm") {
      return this.confirm(context, parts[1]!, beforeSubmit);
    }
    const action = parts[0];
    if (parts.length === 2 && action === "trust" && parts[1] === "all") {
      return this.previewAll(context, beforeSubmit);
    }
    if (parts.length === 1) return this.detail(context, parts[0]!, beforeSubmit);
    if (parts.length === 2 && (action === "trust" || action === "enable" || action === "disable")) {
      return this.preview(context, parts[1]!, action, beforeSubmit);
    }
    throw new UserFacingError("hooks.usage", "用法：/hooks [page 页码|选择编号|trust 选择编号|trust all|enable 选择编号|disable 选择编号|confirm 确认码]");
  }

  private context(target: ConversationTarget, actorId?: string): Context {
    if (!actorId) throw new UserFacingError("hooks.actor-required", "无法确认操作者身份，请从已授权渠道重新操作");
    this.authorize(target, actorId);
    const workspace = this.router.workspace(target);
    const binding = this.router.current(target);
    const provider = binding
      ? this.router.modelSettings(target)?.modelProvider
      : this.models.status(target).modelProvider;
    if (!provider) throw new UserFacingError("hooks.provider-required", "请先通过 /model 选择提供商，再执行 /hooks");
    return { surface: target.surface, targetKey: conversationTargetKey(target), actorId, workspaceId: workspace.id,
      cwd: workspace.cwd, provider, threadId: binding?.threadId };
  }

  private async list(context: Context, page: number, beforeSubmit: () => void): Promise<HookCommandView> {
    const catalog = await this.read(context, beforeSubmit);
    const pageCount = pageCountFor(catalog.hooks.length, pageSize);
    requirePage(page, pageCount, () => {
      throw new UserFacingError("hooks.page-invalid", "Hook 页码不存在，请执行 /hooks");
    });
    const id = randomBytes(8).toString("hex");
    const view: HookCommandView = {
      workspaceId: context.workspaceId, provider: context.provider,
      entries: pageSlice(catalog.hooks, page, pageSize, pageCount)
        .map((hook, index) => ({ selector: `${id}.${index + 1}`, hook })),
      warningCount: catalog.warningCount, errorCount: catalog.errorCount, page, pageCount,
    };
    this.prune(this.snapshots, true);
    this.snapshots.set(id, { ...context, capturedAt: performance.now(), view });
    return view;
  }

  private selection(context: Context, selector: string): { view: HookCommandView; hook: HookEntry } {
    const id = selector.split(".")[0]!;
    const snapshot = this.snapshots.get(id);
    if (!snapshot || !sameContext(snapshot, context) || performance.now() - snapshot.capturedAt >= lifetimeMs) throw expired();
    const entry = snapshot.view.entries.find(entry => entry.selector === selector);
    if (!entry) throw expired();
    return { view: snapshot.view, hook: entry.hook };
  }

  private async detail(context: Context, selector: string, beforeSubmit: () => void): Promise<HookCommandView> {
    const selection = this.selection(context, selector);
    const hook = await this.recheck(context, selection.hook, beforeSubmit);
    return { ...selection.view, detail: { selector, hook } };
  }

  private async preview(context: Context, selector: string, action: HookAction, beforeSubmit: () => void): Promise<HookCommandView> {
    const selection = this.selection(context, selector);
    const version = await this.version(context, beforeSubmit);
    const hook = await this.recheck(context, selection.hook, beforeSubmit);
    requireAction(hook, action);
    const token = randomBytes(16).toString("hex");
    const view = { ...selection.view, detail: { selector, hook } };
    this.prune(this.confirmations, true);
    this.confirmations.set(token, { ...context, capturedAt: performance.now(), hooks: [hook], action, version, view });
    return { ...view, confirmation: { token, action } };
  }

  private async previewAll(context: Context, beforeSubmit: () => void): Promise<HookCommandView> {
    const version = await this.version(context, beforeSubmit);
    const catalog = await this.read(context, beforeSubmit);
    if (catalog.errorCount) throw expired();
    const hooks = catalog.hooks.filter(needsTrust);
    if (!hooks.length) throw new UserFacingError("hooks.nothing-to-trust", "当前 Workspace 没有待信任的非受管 Hook，无需写入");
    const view: HookCommandView = {
      workspaceId: context.workspaceId, provider: context.provider, entries: [],
      warningCount: catalog.warningCount, errorCount: catalog.errorCount,
      page: 1, pageCount: 1, bulkCount: hooks.length,
    };
    const token = randomBytes(16).toString("hex");
    this.prune(this.confirmations, true);
    this.confirmations.set(token, { ...context, capturedAt: performance.now(), hooks, action: "trust-all", version, view });
    return { ...view, confirmation: { token, action: "trust-all" } };
  }

  private async confirm(context: Context, token: string, beforeSubmit: () => void): Promise<HookCommandView> {
    const pending = this.confirmations.get(token);
    if (!pending || !sameContext(pending, context)) throw expired();
    this.confirmations.delete(token);
    if (performance.now() - pending.capturedAt >= lifetimeMs) throw expired();
    if (await this.version(context, beforeSubmit) !== pending.version) throw expired();
    const catalogBefore = await this.read(context, beforeSubmit);
    const hooks = pending.hooks.map(expected => {
      const actual = catalogBefore.hooks.find(hook => hook.key === expected.key);
      if (catalogBefore.errorCount || !actual || !sameHookState(actual, expected)) throw expired();
      if (pending.action !== "trust-all") requireAction(actual, pending.action);
      else if (!needsTrust(actual)) throw expired();
      return actual;
    });
    if (pending.action === "trust-all" && catalogBefore.hooks.filter(needsTrust).length !== hooks.length) throw expired();
    beforeSubmit();
    if (performance.now() - pending.capturedAt >= lifetimeMs) throw expired();
    let refreshFailedProviders: string[];
    let submissionDenied = false;
    const beforeWrite = () => {
      try {
        beforeSubmit();
        if (performance.now() - pending.capturedAt >= lifetimeMs) throw expired();
        if (pending.action !== "trust-all") for (const hook of hooks) {
          requireAction({ ...hook, reviewable: hook.reviewable && this.reviewPolicy(context.surface, hook) }, pending.action);
        }
      } catch (error) {
        submissionDenied = true;
        throw error;
      }
    };
    try {
      ({ refreshFailedProviders } = await this.port.writeHookState(context.provider, pending.action === "trust-all"
        ? { hooks: hooks.map(({ key, currentHash }) => ({ key, currentHash })), action: "trust-all", expectedVersion: pending.version }
        : { key: hooks[0]!.key, currentHash: hooks[0]!.currentHash, action: pending.action, expectedVersion: pending.version }, beforeWrite));
    } catch (error) {
      if (submissionDenied) throw error;
      throw new UserFacingError("hooks.write-unconfirmed", "Hook 设置未确认保存，可能发生配置冲突或连接中断。请重新执行 /hooks 核对；不会自动重试");
    } finally {
      // Provider instances share CODEX_HOME. Even an unknown write outcome invalidates every review.
      if (!submissionDenied) {
        this.snapshots.clear();
        this.confirmations.clear();
      }
    }
    // A successful write does not prove that every loaded Thread refreshed or ran the Hook.
    let catalog: HookCatalog;
    try { catalog = await this.read(context); } catch {
      throw new UserFacingError("hooks.readback-failed", "Hook 配置写入已返回成功，但回读失败。请执行 /hooks 核对状态；不会重复写入");
    }
    const actuals = hooks.map(hook => catalog.hooks.find(entry => entry.key === hook.key && entry.currentHash === hook.currentHash));
    if (catalog.errorCount || actuals.some((actual, index) => !actual || (pending.action === "trust" || pending.action === "trust-all"
      ? actual.trustStatus !== "trusted" || actual.enabled !== hooks[index]!.enabled
      : actual.enabled !== (pending.action === "enable")))) {
      throw new UserFacingError("hooks.state-unconfirmed", "Hook 配置已提交，但未读到预期状态。请重新执行 /hooks 核对当前配置与策略");
    }
    return { ...pending.view, entries: [], ...(pending.action === "trust-all" ? {} : { detail: { selector: "", hook: actuals[0]! } }),
      warningCount: catalog.warningCount, errorCount: catalog.errorCount, updated: pending.action,
      refreshFailedProviders };
  }

  private async recheck(context: Context, expected: HookEntry, beforeSubmit: () => void): Promise<HookEntry> {
    const catalog = await this.read(context, beforeSubmit);
    const hook = catalog.hooks.find(entry => entry.key === expected.key);
    if (catalog.errorCount || !hook || !sameHookState(hook, expected)) throw expired();
    return hook;
  }

  private async read(context: Context, beforeSubmit?: () => void): Promise<HookCatalog> {
    let submissionDenied = false;
    const guard = beforeSubmit && (() => {
      try { beforeSubmit(); } catch (error) { submissionDenied = true; throw error; }
    });
    try {
      guard?.();
      const catalog = await this.port.listHooks(context.cwd, context.provider, guard);
      guard?.();
      return { ...catalog, hooks: catalog.hooks.map(hook => ({
        ...hook, reviewable: hook.reviewable && this.reviewPolicy(context.surface, hook),
      })) };
    } catch (error) {
      if (submissionDenied) throw error;
      throw new UserFacingError("hooks.read-failed", "无法读取目标实例的 Hook 列表，请检查该实例连接和配置");
    }
  }

  private async version(context: Context, beforeSubmit: () => void): Promise<string> {
    let submissionDenied = false;
    const guard = () => {
      try { beforeSubmit(); } catch (error) { submissionDenied = true; throw error; }
    };
    try {
      guard();
      const version = await this.port.readHookConfigVersion(context.provider, guard);
      guard();
      return version;
    } catch (error) {
      if (submissionDenied) throw error;
      throw new UserFacingError("hooks.version-unavailable", "无法读取目标实例的用户配置版本，本次不能修改 Hook");
    }
  }

  private prune<T extends { capturedAt: number }>(map: Map<string, T>, reserve = false): void {
    for (const [key, value] of map) if (performance.now() - value.capturedAt >= lifetimeMs) map.delete(key);
    if (reserve) trimOldestEntries(map, maximumSnapshots - 1);
  }
}

function needsTrust(hook: HookEntry): boolean {
  return !hook.isManaged && (hook.trustStatus === "untrusted" || hook.trustStatus === "modified");
}

function sameHookState(hook: HookEntry, expected: HookEntry): boolean {
  return hook.currentHash === expected.currentHash && hook.isManaged === expected.isManaged
    && hook.enabled === expected.enabled && hook.trustStatus === expected.trustStatus
    && hook.reviewable === expected.reviewable;
}

function sameContext(left: Context, right: Context): boolean {
  return left.targetKey === right.targetKey && left.actorId === right.actorId
    && left.workspaceId === right.workspaceId && left.cwd === right.cwd
    && left.provider === right.provider && left.threadId === right.threadId;
}

function requireAction(hook: HookEntry, action: HookAction): void {
  if (hook.isManaged || hook.trustStatus === "managed") {
    throw new UserFacingError("hooks.managed", "受管 Hook 由上游策略控制，不能在渠道修改");
  }
  if (action === "trust") {
    if (!hook.reviewable) throw new UserFacingError("hooks.local-review-required", "渠道无法完整展示此 Hook 的审查信息，请在本地 /hooks 审查并信任");
    if (hook.trustStatus !== "untrusted" && hook.trustStatus !== "modified") throw expired();
  } else if (hook.trustStatus !== "trusted" || hook.enabled === (action === "enable")) {
    throw expired();
  }
}

function expired(): UserFacingError {
  return new UserFacingError("hooks.review-expired", "Hook 选择或确认已失效，或配置、会话发生变化，请重新执行 /hooks 审查");
}
