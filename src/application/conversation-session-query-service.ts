import type { ConversationTarget, SessionDisplayCachePort } from "../conversation-core/index.js";
import type { SessionRouter } from "../session-routing/index.js";
import type { ThreadHistoryPort } from "./thread-history-port.js";
import type { RequestMetricsQueryPort } from "./request-metrics-port.js";

const sessionListPageSize = 20;
const sessionTurnCountCacheTtlMs = 5 * 60_000;
const sessionScanConcurrency = 3;

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
  private readonly sessionDisplayCacheRefreshes = new Map<string, {
    promise: Promise<void>;
    rerun: boolean;
    generation: number;
  }>();
  private readonly sessionDisplayCacheGenerations = new Map<string, number>();

  constructor(
    private readonly router: Pick<SessionRouter, "list" | "modelSettingsForThread" | "workspace" | "readThread">,
    private readonly threadHistory?: ThreadHistoryPort,
    private readonly requestMetricsQuery?: RequestMetricsQueryPort,
    private readonly sessionDisplayCache?: SessionDisplayCachePort,
  ) {}

  async listSessions(
    target: ConversationTarget,
    options: ConversationSessionQuery = {},
  ): Promise<ConversationSession[]> {
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
    const ordered = options.searchTerm
        ? await this.router.list(target, {
            ...archiveOptions,
            fullScan: true,
            searchTerm: options.searchTerm,
          })
        : all;
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
    if (this.sessionDisplayCache) {
      const workspaceId = this.router.workspace(target).id;
      const archived = options.archived === true;
      // Only the page that will be rendered needs a display-cache row. Writing
      // the complete catalog on every list command was the dominant local I/O cost.
      for (const session of visible) {
        const thread = ordered.find((item) => item.id === session.id);
        if (!thread) continue;
        const previous = this.sessionDisplayCache.get(thread.id);
        this.sessionDisplayCache.put({
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
        });
      }
    }
    if (options.turnCountMode === "cached") {
      const countByThread = new Map<string, number>();
      for (const session of visible) {
        // Prefer the direct local metric count. It is a single indexed query
        // and, unlike the full summary, never traverses subagent Threads.
        const metricsCount = this.requestMetricsQuery?.threadTurnCount !== undefined
          ? this.requestMetricsQuery.threadTurnCount(session.id)
          : this.requestMetricsQuery?.forThread(session.id)?.threadAggregate?.turnCount;
        if (metricsCount !== undefined && metricsCount !== null) {
          countByThread.set(session.id, metricsCount);
          continue;
        }
        const cached = this.sessionDisplayCache?.get(session.id);
        if (cached?.turnCount !== null && cached?.turnCount !== undefined) {
          countByThread.set(session.id, cached.turnCount);
        }
      }
      return sessions.map((session) => {
        const turnCount = countByThread.get(session.id);
        return turnCount === undefined ? session : { ...session, turnCount };
      });
    }
    if (!this.threadHistory) return sessions;
    const counts = await mapWithConcurrency(visible, sessionScanConcurrency, async (session) => [
      session.id,
      await this.cachedOrCountThreadTurns(session.id),
    ] as const);
    const countByThread = new Map(
      counts.filter((entry): entry is readonly [string, number] => entry[1] !== undefined),
    );
    return sessions.map((session) => {
      const turnCount = countByThread.get(session.id);
      return turnCount === undefined ? session : { ...session, turnCount };
    });
  }

  /** Reconcile one invalidated session without rescanning the Thread catalog. */
  refreshSessionDisplayCache(threadId: string): Promise<void> {
    const existing = this.sessionDisplayCacheRefreshes.get(threadId);
    if (existing) {
      if ((this.sessionDisplayCacheGenerations.get(threadId) ?? 0) !== existing.generation) {
        existing.rerun = true;
      }
      return existing.promise;
    }
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
      } while (state.rerun);
    })().finally(() => {
      if (this.sessionDisplayCacheRefreshes.get(threadId) === state) {
        this.sessionDisplayCacheRefreshes.delete(threadId);
      }
    });
    this.sessionDisplayCacheRefreshes.set(threadId, state);
    return state.promise;
  }

  private async refreshSessionDisplayCacheNow(threadId: string): Promise<void> {
    const cache = this.sessionDisplayCache;
    const history = this.threadHistory;
    const entry = cache?.get(threadId);
    if (!cache || !history || !entry) return;
    const generation = this.sessionDisplayCacheGenerations.get(threadId) ?? 0;
    const count = await countThreadTurns(history, threadId);
    let snapshot: Awaited<ReturnType<SessionRouter["readThread"]>> | undefined;
    try {
      snapshot = await this.router.readThread(threadId);
    } catch {
      snapshot = undefined;
    }
    // A newer Turn may have started while the history request was in flight.
    if ((this.sessionDisplayCacheGenerations.get(threadId) ?? 0) !== generation) return;
    const latest = cache.get(threadId);
    if (!latest || count === undefined) return;
    cache.put({
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
    });
  }

  invalidateSessionDisplayCache(threadId: string): void {
    this.sessionDisplayCacheGenerations.set(
      threadId,
      (this.sessionDisplayCacheGenerations.get(threadId) ?? 0) + 1,
    );
    this.sessionDisplayCache?.invalidateTurnCount(threadId);
  }

  removeSessionDisplayCache(threadId: string): void {
    this.sessionDisplayCacheGenerations.delete(threadId);
    this.sessionDisplayCache?.remove(threadId);
  }

  private async cachedOrCountThreadTurns(threadId: string): Promise<number | undefined> {
    const cached = this.sessionDisplayCache?.get(threadId);
    if (
      cached?.turnCount !== null
      && cached?.turnCount !== undefined
      && cached.measuredAt !== null
      && Date.now() - cached.measuredAt <= sessionTurnCountCacheTtlMs
    ) {
      return cached.turnCount;
    }
    const count = await countThreadTurns(this.threadHistory!, threadId);
    if (count !== undefined && cached && this.sessionDisplayCache) {
      this.sessionDisplayCache.put({ ...cached, turnCount: count, measuredAt: Date.now() });
    }
    return count;
  }

}

async function countThreadTurns(
  history: ThreadHistoryPort,
  threadId: string,
): Promise<number | undefined> {
  let count = 0;
  let cursor: string | null = null;
  const cursors = new Set<string>();
  try {
    do {
      const page = await history.listThreadTurns(threadId, {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
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
