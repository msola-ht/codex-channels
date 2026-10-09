import { randomBytes } from "node:crypto";
import { conversationTargetKey, UserFacingError, type ConversationTarget } from "../conversation-core/index.js";
import type { SessionRouter } from "../session-routing/index.js";
import type { ConversationLockCoordinator } from "./conversation-lock-coordinator.js";
import type { ModelSelectionService } from "./model-selection-service.js";
import type { HookAction, HookCatalog, HookCommandView, HookConfigPort, HookEntry, HookReviewPolicy } from "./hook-port.js";

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
  hook: HookEntry;
  action: HookAction;
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

  execute(target: ConversationTarget, input: string, actorId?: string): Promise<HookCommandView> {
    return this.locks.forConversation(target, async () => {
      this.prune(this.snapshots);
      this.prune(this.confirmations);
      const context = this.context(target, actorId);
      const view = await this.run(target, context, input);
      if (!sameContext(this.context(target, actorId), context)) throw expired();
      return view;
    });
  }

  private async run(target: ConversationTarget, context: Context, input: string): Promise<HookCommandView> {
    const parts = input.trim().split(/\s+/u).filter(Boolean);
    if (parts.length === 0 || (parts.length === 2 && parts[0] === "page" && /^[1-9]\d*$/u.test(parts[1]!))) {
      return this.list(context, parts.length === 0 ? 1 : Number(parts[1]));
    }
    if (parts.length === 2 && parts[0] === "confirm") {
      return this.confirm(target, context, parts[1]!);
    }
    const action = parts[0];
    if (parts.length === 1) return this.detail(context, parts[0]!);
    if (parts.length === 2 && (action === "trust" || action === "enable" || action === "disable")) {
      return this.preview(context, parts[1]!, action);
    }
    throw new UserFacingError("hooks.usage", "用法：/hooks [page 页码|选择编号|trust 选择编号|enable 选择编号|disable 选择编号|confirm 确认码]");
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

  private async list(context: Context, page: number): Promise<HookCommandView> {
    const catalog = await this.read(context);
    const pageCount = Math.max(1, Math.ceil(catalog.hooks.length / pageSize));
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
      throw new UserFacingError("hooks.page-invalid", "Hook 页码不存在，请执行 /hooks");
    }
    const id = randomBytes(8).toString("hex");
    const view: HookCommandView = {
      workspaceId: context.workspaceId, provider: context.provider,
      entries: catalog.hooks.slice((page - 1) * pageSize, page * pageSize)
        .map((hook, index) => ({ selector: `${id}.${index + 1}`, hook })),
      warningCount: catalog.warningCount, errorCount: catalog.errorCount, page, pageCount,
    };
    this.prune(this.snapshots, true);
    this.snapshots.set(id, { ...context, capturedAt: Date.now(), view });
    return view;
  }

  private selection(context: Context, selector: string): { view: HookCommandView; hook: HookEntry } {
    const id = selector.split(".")[0]!;
    const snapshot = this.snapshots.get(id);
    if (!snapshot || !sameContext(snapshot, context) || Date.now() - snapshot.capturedAt > lifetimeMs) throw expired();
    const entry = snapshot.view.entries.find(entry => entry.selector === selector);
    if (!entry) throw expired();
    return { view: snapshot.view, hook: entry.hook };
  }

  private async detail(context: Context, selector: string): Promise<HookCommandView> {
    const selection = this.selection(context, selector);
    const hook = await this.recheck(context, selection.hook);
    return { ...selection.view, detail: { selector, hook } };
  }

  private async preview(context: Context, selector: string, action: HookAction): Promise<HookCommandView> {
    const selection = this.selection(context, selector);
    const version = await this.version(context);
    const hook = await this.recheck(context, selection.hook);
    requireAction(hook, action);
    const token = randomBytes(16).toString("hex");
    const view = { ...selection.view, detail: { selector, hook } };
    this.prune(this.confirmations, true);
    this.confirmations.set(token, { ...context, capturedAt: Date.now(), hook, action, version, view });
    return { ...view, confirmation: { token, action } };
  }

  private async confirm(target: ConversationTarget, context: Context, token: string): Promise<HookCommandView> {
    const pending = this.confirmations.get(token);
    if (!pending || !sameContext(pending, context)) throw expired();
    this.confirmations.delete(token);
    if (Date.now() - pending.capturedAt > lifetimeMs) throw expired();
    if (await this.version(context) !== pending.version) throw expired();
    const hook = await this.recheck(context, pending.hook);
    requireAction(hook, pending.action);
    if (Date.now() - pending.capturedAt > lifetimeMs
      || !sameContext(this.context(target, context.actorId), context)) throw expired();
    let refreshFailedProviders: string[];
    try {
      ({ refreshFailedProviders } = await this.port.writeHookState(context.provider, {
        key: hook.key, currentHash: hook.currentHash, action: pending.action, expectedVersion: pending.version,
      }));
    } catch {
      throw new UserFacingError("hooks.write-unconfirmed", "Hook 设置未确认保存，可能发生配置冲突或连接中断。请重新执行 /hooks 核对；不会自动重试");
    } finally {
      // Provider instances share CODEX_HOME. Even an unknown write outcome invalidates every review.
      this.snapshots.clear();
      this.confirmations.clear();
    }
    // A successful write does not prove that every loaded Thread refreshed or ran the Hook.
    let catalog: HookCatalog;
    try { catalog = await this.read(context); } catch {
      throw new UserFacingError("hooks.readback-failed", "Hook 配置写入已返回成功，但回读失败。请执行 /hooks 核对状态；不会重复写入");
    }
    const actual = catalog.hooks.find(entry => entry.key === hook.key && entry.currentHash === hook.currentHash);
    if (catalog.errorCount || !actual || (pending.action === "trust"
      ? actual.trustStatus !== "trusted" : actual.enabled !== (pending.action === "enable"))) {
      throw new UserFacingError("hooks.state-unconfirmed", "Hook 配置已提交，但未读到预期状态。请重新执行 /hooks 核对当前配置与策略");
    }
    return { ...pending.view, entries: [], detail: { selector: "", hook: actual },
      warningCount: catalog.warningCount, errorCount: catalog.errorCount, updated: pending.action,
      refreshFailedProviders };
  }

  private async recheck(context: Context, expected: HookEntry): Promise<HookEntry> {
    const catalog = await this.read(context);
    const hook = catalog.hooks.find(entry => entry.key === expected.key);
    if (catalog.errorCount || !hook || hook.currentHash !== expected.currentHash
      || hook.isManaged !== expected.isManaged || hook.enabled !== expected.enabled
      || hook.trustStatus !== expected.trustStatus || hook.reviewable !== expected.reviewable) throw expired();
    return hook;
  }

  private async read(context: Context): Promise<HookCatalog> {
    try {
      const catalog = await this.port.listHooks(context.cwd, context.provider);
      return { ...catalog, hooks: catalog.hooks.map(hook => ({
        ...hook, reviewable: hook.reviewable && this.reviewPolicy(context.surface, hook),
      })) };
    } catch {
      throw new UserFacingError("hooks.read-failed", "无法读取目标实例的 Hook 列表，请检查该实例连接和配置");
    }
  }

  private async version(context: Context): Promise<string> {
    try { return await this.port.readHookConfigVersion(context.provider); } catch {
      throw new UserFacingError("hooks.version-unavailable", "无法读取目标实例的用户配置版本，本次不能修改 Hook");
    }
  }

  private prune<T extends { capturedAt: number }>(map: Map<string, T>, reserve = false): void {
    for (const [key, value] of map) if (Date.now() - value.capturedAt > lifetimeMs) map.delete(key);
    while (reserve && map.size >= maximumSnapshots) map.delete(map.keys().next().value!);
  }
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
