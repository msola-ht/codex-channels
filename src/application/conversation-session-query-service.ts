import { UserFacingError, type ConversationTarget, type SessionDisplayCachePort } from "../conversation-core/index.js";
import type { SessionRouter } from "../session-routing/index.js";
import type { ThreadHistoryPort } from "./thread-history-port.js";
import type { RequestMetricsQueryPort } from "./request-metrics-port.js";

const sessionListPageSize = 20;
const sessionTurnCountCacheTtlMs = 5 * 60_000;
const sessionScanConcurrency = 3;
const sessionScanTimeoutMs = 10_000;
const sessionScanMaximumPages = 100;

export type SessionDisplayCacheOperation = "get" | "put" | "invalidateTurnCount" | "remove";

export interface ConversationSession {
  selector?: string;
  id: string;
  preview: string;
  name: string | null;
  isPinned: boolean;
  modelProvider?: string;
  status: { type: "notLoaded" | "idle" | "systemError" | "active" };
  model?: string;
  reasoningEffort?: string;
  turnCount?: number;
}

export interface ConversationSessionQuery {
  archived?: boolean;
  searchTerm?: string;
  filter?: "all" | "running" | "pinned";
  provider?: string;
  page?: number;
  /** Use local counts without waiting on history RPCs. */
  turnCountMode?: "scan" | "cached";
}

/** Owns session list projections and their derived cache; never changes bindings. */
export class ConversationSessionQueryService {
  private readonly cancellation = new AbortController();
  private readonly sessionDisplayCacheRefreshes = new Map<string, {
    promise: Promise<void>;
    rerun: boolean;
    generation: number;
  }>();
  private readonly sessionDisplayCacheGenerations = new Map<string, number>();
  private sessionDisplayCacheDisabled = false;

  constructor(
    private readonly router: Pick<SessionRouter, "list" | "modelSettingsForThread" | "workspace" | "readThread">,
    private readonly threadHistory?: ThreadHistoryPort,
    private readonly requestMetricsQuery?: RequestMetricsQueryPort,
    private readonly sessionDisplayCache?: SessionDisplayCachePort,
    private readonly onSessionDisplayCacheError?: (operation: SessionDisplayCacheOperation) => void,
  ) {}

  close(): void {
    this.cancellation.abort();
  }

  async listSessions(
    target: ConversationTarget,
    options: ConversationSessionQuery = {},
  ): Promise<ConversationSession[]> {
    this.cancellation.signal.throwIfAborted();
    const archiveOptions = options.archived === undefined ? {} : { archived: options.archived };
    const needsCompleteCatalog = Boolean(
      options.searchTerm
      || options.provider
      || (options.filter && options.filter !== "all"),
    );
    const all = pinnedFirst(await this.router.list(target, {
      ...archiveOptions,
      ...(needsCompleteCatalog ? { fullScan: true } : {}),
    }));
    this.cancellation.signal.throwIfAborted();
    const ordered = options.searchTerm
        ? await this.router.list(target, {
            ...archiveOptions,
            fullScan: true,
            searchTerm: options.searchTerm,
          })
        : all;
    this.cancellation.signal.throwIfAborted();
    const selectors = new Map(all.map((thread, index) => [thread.id, String(index + 1)]));
    const normalizedProvider = options.provider?.trim().toLowerCase() || null;
    const sessions = ordered.map((thread) => ({ thread, selector: selectors.get(thread.id) }))
      .filter(({ thread }) => {
        if (normalizedProvider && thread.modelProvider.toLowerCase() !== normalizedProvider) {
          return false;
        }
        if (options.filter === "running" && thread.status.type !== "active") return false;
        if (options.filter === "pinned" && !thread.isPinned) return false;
        return true;
      })
      .map(({ thread: { id, preview, name, isPinned, modelProvider, status }, selector }) => {
        const routed = this.router.modelSettingsForThread(id);
        return {
          ...(selector ? { selector } : {}),
          id,
          preview,
          name,
          isPinned,
          modelProvider,
          status,
          ...(routed?.model ? { model: routed.model } : {}),
          ...(routed?.effort ? { reasoningEffort: routed.effort } : {}),
        };
      });
    const page = options.page;
    if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1) {
      return sessions;
    }
    const start = (page - 1) * sessionListPageSize;
    const visible = sessions.slice(start, start + sessionListPageSize);
    if (this.sessionDisplayCache && !this.sessionDisplayCacheDisabled) {
      const workspaceId = this.router.workspace(target).id;
      const archived = options.archived === true;
      // Only the page that will be rendered needs a display-cache row. Writing
      // the complete catalog on every list command was the dominant local I/O cost.
      for (const session of visible) {
        const thread = ordered.find((item) => item.id === session.id);
        if (!thread) continue;
        const previous = this.useSessionDisplayCache("get", (cache) => cache.get(thread.id));
        this.useSessionDisplayCache("put", (cache) => cache.put({
          threadId: thread.id,
          workspaceId,
          archived,
          preview: thread.preview,
          name: thread.name,
          modelProvider: thread.modelProvider,
          status: thread.status,
          activeTurnId: thread.activeTurnId,
          isPinned: thread.isPinned,
          turnCount: previous?.turnCount ?? null,
          measuredAt: previous?.measuredAt ?? null,
        }));
      }
    }
    if (options.turnCountMode === "cached") {
      const countByThread = new Map<string, number>();
      const cachedCountGenerations = new Map<string, number>();
      for (const session of visible) {
        // Prefer the direct local metric count. It is a single indexed query
        // and, unlike the full summary, never traverses subagent Threads.
        const metricsCount = this.requestMetricsQuery?.threadTurnCount !== undefined
          ? await this.requestMetricsQuery.threadTurnCount(session.id)
          : (await this.requestMetricsQuery?.forThread(session.id))?.threadAggregate?.turnCount;
        if (metricsCount !== undefined && metricsCount !== null) {
          countByThread.set(session.id, metricsCount);
          continue;
        }
        const cached = this.useSessionDisplayCache("get", (cache) => cache.get(session.id));
        if (cached?.turnCount !== null && cached?.turnCount !== undefined) {
          countByThread.set(session.id, cached.turnCount);
          cachedCountGenerations.set(session.id, this.sessionDisplayCacheGenerations.get(session.id) ?? 0);
        }
      }
      return sessions.map((session) => {
        const generation = cachedCountGenerations.get(session.id);
        if (generation !== undefined && (this.sessionDisplayCacheDisabled
          || (this.sessionDisplayCacheGenerations.get(session.id) ?? 0) !== generation)) return session;
        const turnCount = countByThread.get(session.id);
        return turnCount === undefined ? session : { ...session, turnCount };
      });
    }
    if (!this.threadHistory) return sessions;
    const cacheWasDisabled = this.sessionDisplayCacheDisabled;
    const generations = new Map(visible.map((session) => [
      session.id, this.sessionDisplayCacheGenerations.get(session.id) ?? 0,
    ]));
    const counts = await mapWithConcurrency(visible, sessionScanConcurrency, async (session) => [
      session.id,
      await this.cachedOrCountThreadTurns(session.id),
    ] as const);
    const countByThread = new Map(
      counts.filter((entry): entry is readonly [string, number] => entry[1] !== undefined),
    );
    return sessions.map((session) => {
      if ((!cacheWasDisabled && this.sessionDisplayCacheDisabled)
        || (this.sessionDisplayCacheGenerations.get(session.id) ?? 0) !== generations.get(session.id)) return session;
      const turnCount = countByThread.get(session.id);
      return turnCount === undefined ? session : { ...session, turnCount };
    });
  }

  /** Reconcile one invalidated session without rescanning the Thread catalog. */
  refreshSessionDisplayCache(threadId: string): Promise<void> {
    if (this.cancellation.signal.aborted || this.sessionDisplayCacheDisabled) return Promise.resolve();
    const existing = this.sessionDisplayCacheRefreshes.get(threadId);
    if (existing) {
      if ((this.sessionDisplayCacheGenerations.get(threadId) ?? 0) !== existing.generation) {
        existing.rerun = true;
      }
      return existing.promise;
    }
    // Counts are optional derived data. Leave the invalidated count unknown
    // rather than build another unbounded queue behind busy history scans.
    if (this.sessionDisplayCacheRefreshes.size >= sessionScanConcurrency) return Promise.resolve();
    const state = {
      promise: Promise.resolve(),
      rerun: false,
      generation: this.sessionDisplayCacheGenerations.get(threadId) ?? 0,
    };
    state.promise = (async () => {
      do {
        state.rerun = false;
        state.generation = this.sessionDisplayCacheGenerations.get(threadId) ?? 0;
        await this.refreshSessionDisplayCacheNow(threadId);
      } while (state.rerun && !this.cancellation.signal.aborted);
    })().finally(() => {
      if (this.sessionDisplayCacheRefreshes.get(threadId) === state) {
        this.sessionDisplayCacheRefreshes.delete(threadId);
      }
    });
    this.sessionDisplayCacheRefreshes.set(threadId, state);
    return state.promise;
  }

  private async refreshSessionDisplayCacheNow(threadId: string): Promise<void> {
    const history = this.threadHistory;
    const entry = this.useSessionDisplayCache("get", (cache) => cache.get(threadId));
    if (!history || !entry) return;
    const generation = this.sessionDisplayCacheGenerations.get(threadId) ?? 0;
    const signal = AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(sessionScanTimeoutMs)]);
    const count = await countThreadTurns(history, threadId, signal);
    if (signal.aborted) return;
    let snapshot: Awaited<ReturnType<SessionRouter["readThread"]>> | undefined;
    try {
      snapshot = await this.router.readThread(threadId, signal);
    } catch {
      snapshot = undefined;
    }
    // A newer Turn may have started while the history request was in flight.
    if (signal.aborted || (this.sessionDisplayCacheGenerations.get(threadId) ?? 0) !== generation) return;
    const latest = this.useSessionDisplayCache("get", (cache) => cache.get(threadId));
    if (!latest || count === undefined) return;
    this.useSessionDisplayCache("put", (cache) => cache.put({
      ...latest,
      ...(snapshot
        ? {
            preview: snapshot.preview,
            name: snapshot.name,
            modelProvider: snapshot.modelProvider,
            status: snapshot.status,
            activeTurnId: snapshot.activeTurnId,
            isPinned: snapshot.isPinned,
          }
        : {
            status: { type: "idle" as const },
            activeTurnId: null,
          }),
      turnCount: count,
      measuredAt: Date.now(),
    }));
  }

  invalidateSessionDisplayCache(threadId: string): void {
    this.sessionDisplayCacheGenerations.set(
      threadId,
      (this.sessionDisplayCacheGenerations.get(threadId) ?? 0) + 1,
    );
    this.useSessionDisplayCache("invalidateTurnCount", (cache) => cache.invalidateTurnCount(threadId));
  }

  removeSessionDisplayCache(threadId: string): void {
    // Keep a new generation until shutdown so an in-flight scan cannot restore
    // a removed row, even if this Thread is listed again before the scan ends.
    this.sessionDisplayCacheGenerations.set(
      threadId,
      (this.sessionDisplayCacheGenerations.get(threadId) ?? 0) + 1,
    );
    this.useSessionDisplayCache("remove", (cache) => cache.remove(threadId));
  }

  private async cachedOrCountThreadTurns(threadId: string): Promise<number | undefined> {
    const cached = this.useSessionDisplayCache("get", (cache) => cache.get(threadId));
    if (
      cached?.turnCount !== null
      && cached?.turnCount !== undefined
      && cached.measuredAt !== null
      && Date.now() - cached.measuredAt <= sessionTurnCountCacheTtlMs
    ) {
      return cached.turnCount;
    }
    const signal = AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(sessionScanTimeoutMs)]);
    const generation = this.sessionDisplayCacheGenerations.get(threadId) ?? 0;
    const count = await countThreadTurns(this.threadHistory!, threadId, signal);
    if (signal.aborted || (this.sessionDisplayCacheGenerations.get(threadId) ?? 0) !== generation) {
      return undefined;
    }
    if (count !== undefined && cached) {
      this.useSessionDisplayCache("put", (cache) => cache.put({ ...cached, turnCount: count, measuredAt: Date.now() }));
    }
    return count;
  }

  private useSessionDisplayCache<T>(
    operation: SessionDisplayCacheOperation,
    use: (cache: SessionDisplayCachePort) => T,
  ): T | undefined {
    if (!this.sessionDisplayCache || this.sessionDisplayCacheDisabled || this.cancellation.signal.aborted) {
      return undefined;
    }
    try {
      return use(this.sessionDisplayCache);
    } catch {
      // A failed invalidation/removal may leave persistent stale rows behind.
      // Disable every cache operation for this instance before reporting it;
      // neither later reads nor in-flight scans may reuse those rows.
      this.sessionDisplayCacheDisabled = true;
      try {
        this.onSessionDisplayCacheError?.(operation);
      } catch {
        // Diagnostics cannot interrupt authoritative events or Turn submission.
      }
      return undefined;
    }
  }

}

async function countThreadTurns(
  history: ThreadHistoryPort,
  threadId: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  let count = 0;
  let cursor: string | null = null;
  const cursors = new Set<string>();
  let pages = 0;
  try {
    do {
      signal.throwIfAborted();
      if (++pages > sessionScanMaximumPages) return undefined;
      const page = await history.listThreadTurns(threadId, {
        limit: 100,
        signal,
        ...(cursor ? { cursor } : {}),
      });
      signal.throwIfAborted();
      count += page.turns.length;
      cursor = page.nextCursor;
      if (cursor) {
        if (cursors.has(cursor)) return undefined;
        cursors.add(cursor);
      }
    } while (cursor);
    return count;
  } catch {
    return undefined;
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker),
  );
  return results;
}

export function pinnedFirst<T extends { isPinned: boolean }>(
  sessions: readonly T[],
): T[] {
  return sessions.toSorted((left, right) =>
    Number(right.isPinned) - Number(left.isPinned));
}

/** 会话选择器：序号、精确 ID/名称或唯一 ID 前缀；歧义与缺失明确失败。 */
export function resolveThread<T extends Pick<ConversationSession, "id" | "name">>(
  threads: T[],
  selector: string,
  command: "resume" | "unarchive" = "resume",
): T {
  if (!selector) {
    throw new UserFacingError(
      "session.selector.required",
      "需要提供会话序号、名称或 Session ID",
      { command },
    );
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
  const ambiguous = prefix.length > 1 || exact.length > 1;
  throw new UserFacingError(
    ambiguous ? "session.selector.ambiguous" : "session.selector.not-found",
    ambiguous ? "会话选择不唯一" : "找不到指定会话",
  );
}
