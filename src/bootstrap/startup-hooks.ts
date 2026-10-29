import type { ConversationStatus, HookConfigPort, HookStartupSummary } from "../application/index.js";
import type { ConversationTarget } from "../conversation-core/index.js";
import type { Logger } from "pino";

export type StartupHookScope = Pick<ConversationStatus, "workspaceId" | "cwd" | "threadId" | "modelProvider" | "sessionRestoring">;
export type StartupHooksReader = (target: ConversationTarget, status: StartupHookScope, signal: AbortSignal) => Promise<HookStartupSummary>;

/** Read only the authorized startup target; a failed check never implies trusted hooks. */
export function createStartupHooksReader(options: {
  port: Pick<HookConfigPort, "listHooks">;
  scope(target: ConversationTarget): StartupHookScope;
  allowed(target: ConversationTarget): boolean;
  logger: Logger;
}): StartupHooksReader {
  return async (target, original, signal) => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 3_000);
    timer.unref();
    const active = AbortSignal.any([signal, deadline.signal]);
    const assertScope = (): void => {
      signal.throwIfAborted();
      if (!options.allowed(target)) throw new Error("启动 Hook 查询授权已失效");
      const current = options.scope(target);
      if (current.workspaceId !== original.workspaceId || current.cwd !== original.cwd
        || current.threadId !== original.threadId || current.modelProvider !== original.modelProvider
        || current.sessionRestoring !== original.sessionRestoring) {
        throw new Error("启动 Hook 查询会话已变化");
      }
    };
    const beforeSubmit = (): void => { active.throwIfAborted(); assertScope(); };
    let onAbort: (() => void) | undefined;
    try {
      beforeSubmit();
      // Until a binding is restored, status may contain a display-only default
      // Provider rather than the Provider that owns the bound Thread.
      if (original.sessionRestoring || !original.modelProvider || !original.cwd) return { kind: "unavailable" };
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("启动 Hook 查询已取消或超时"));
        active.addEventListener("abort", onAbort, { once: true });
      });
      const catalog = await Promise.race([
        options.port.listHooks(original.cwd, original.modelProvider, beforeSubmit, active), cancelled,
      ]);
      beforeSubmit();
      return { kind: "available", untrusted: catalog.hooks.filter(hook => hook.trustStatus === "untrusted").length,
        modified: catalog.hooks.filter(hook => hook.trustStatus === "modified").length,
        warningCount: catalog.warningCount, errorCount: catalog.errorCount };
    } catch {
      assertScope();
      options.logger.warn({ surface: target.surface, accountId: target.accountId, reason: deadline.signal.aborted ? "timeout" : "query-failed" },
        "启动 Hook 信任状态未确认");
      return { kind: "unavailable" };
    } finally {
      clearTimeout(timer);
      if (onAbort) active.removeEventListener("abort", onAbort);
    }
  };
}
