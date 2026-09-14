import {
  usesOpenAiAccount,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { SessionRouter } from "../session-routing/index.js";

import type {
  AccountQueryPort,
  AccountRateLimits,
  AccountUsage,
  ProviderAccountLimits,
  ProviderAccountQueryPort,
  ProviderAccountUsage,
} from "./account-port.js";
import type { ModelSelectionService } from "./model-selection-service.js";
import {
  estimateWeeklyLimit,
  type RequestMetricsCommandQuery,
  type RequestMetricsQueryPort,
  type RequestMetricsResult,
} from "./request-metrics-port.js";

export class ConversationAccountMetricsService {
  constructor(
    private readonly accounts: AccountQueryPort,
    private readonly router: SessionRouter,
    private readonly models: ModelSelectionService,
    private readonly providerAccounts?: ProviderAccountQueryPort,
    private readonly requestMetricsQuery?: RequestMetricsQueryPort,
  ) {}

  accountUsage(): Promise<AccountUsage> {
    return this.accounts.accountUsage();
  }

  accountRateLimits(): Promise<AccountRateLimits> {
    return this.accounts.accountRateLimits();
  }

  providerAccountUsage(target: ConversationTarget): Promise<ProviderAccountUsage> {
    const binding = this.router.current(target);
    const model = this.models.status(target);
    const provider = model.modelProvider ?? "openai";
    const threadProvider = binding
      ? this.router.modelSettings(target)?.modelProvider ?? provider
      : undefined;
    const threadId = usesOpenAiAccount(provider) && usesOpenAiAccount(threadProvider)
      ? binding?.threadId
      : undefined;
    if (!this.providerAccounts) {
      return Promise.resolve({ kind: "unsupported", provider });
    }
    return threadId === undefined
      ? this.providerAccounts.accountUsage(provider)
      : this.providerAccounts.accountUsage(provider, threadId);
  }

  async providerAccountLimits(
    target: ConversationTarget,
  ): Promise<ProviderAccountLimits> {
    const provider = this.models.status(target).modelProvider ?? "openai";
    const resolved: ProviderAccountLimits = this.providerAccounts
      ? await this.providerAccounts.accountLimits(provider)
      : { kind: "unsupported", provider };
    if (resolved.kind !== "rate-limits" || !this.requestMetricsQuery) {
      return resolved;
    }
    const nowMs = Date.now();
    const weeklyEstimates = resolved.limits.limits.flatMap((limit) => {
      if (limit.limitId !== "codex") return [];
      const window = [limit.primary, limit.secondary].find(
        (candidate) => candidate?.windowDurationMins === 10_080,
      );
      if (!window || window.resetsAt === null) return [];
      const observation = this.requestMetricsQuery?.weeklyQuotaEstimate(
        "openai",
        limit.limitId,
        window.resetsAt,
        nowMs,
      ) ?? null;
      const estimate = estimateWeeklyLimit(limit, observation);
      return estimate === null ? [] : [estimate];
    });
    return weeklyEstimates.length === 0
      ? resolved
      : { ...resolved, weeklyEstimates };
  }

  requestMetrics(
    target: ConversationTarget,
    query: RequestMetricsCommandQuery = { view: "session" },
  ): RequestMetricsResult | null {
    if (!this.requestMetricsQuery) return null;
    if (query.view === "errors") {
      return this.requestMetricsQuery.errors(query.range ?? "24h");
    }
    if (query.view !== "session") {
      return this.requestMetricsQuery.aggregate(
        query.view,
        query.range ?? "24h",
      );
    }
    const threadId = this.router.current(target)?.threadId;
    return threadId ? this.requestMetricsQuery.forThread(threadId) : null;
  }
}
