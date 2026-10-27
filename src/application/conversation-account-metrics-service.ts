import {
  UserFacingError,
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
  CloudUsageQuery,
  CloudUsageReport,
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

  async providerAccountUsage(target: ConversationTarget, beforeSubmit?: () => void, query?: CloudUsageQuery): Promise<ProviderAccountUsage | CloudUsageReport> {
    beforeSubmit?.();
    const binding = this.router.current(target);
    const guard = this.accountThreadGuard(target, binding?.threadId, beforeSubmit);
    guard?.();
    const model = this.models.status(target);
    const provider = model.modelProvider ?? "openai";
    if (query?.expectedProvider && query.expectedProvider !== provider) {
      throw new UserFacingError("usage.account-changed", "账户已切换，请重新执行 /usage");
    }
    const threadProvider = binding
      ? this.router.modelSettings(target)?.modelProvider ?? provider
      : undefined;
    const threadId = usesOpenAiAccount(provider) && usesOpenAiAccount(threadProvider)
      ? binding?.threadId
      : undefined;
    if (!this.providerAccounts) {
      return { kind: "unsupported", provider };
    }
    const reportGuard = (): void => {
      guard?.();
      if ((this.models.status(target).modelProvider ?? "openai") !== provider) {
        throw new UserFacingError("usage.account-changed", "账户已切换，请重新执行 /usage");
      }
    };
    const report = await this.providerAccounts.cloudUsage?.(provider, query ?? { range: "24h" }, undefined, reportGuard);
    reportGuard();
    if (report) return report;
    if (query) throw new UserFacingError("usage.arguments", "当前账户不支持用量时间切换或刷新，请使用 /usage");
    const usage = await this.providerAccounts.accountUsage(provider, threadId, undefined, guard);
    guard?.();
    return usage;
  }

  async providerAccountLimits(
    target: ConversationTarget,
    beforeSubmit?: () => void,
  ): Promise<ProviderAccountLimits> {
    beforeSubmit?.();
    const guard = this.accountThreadGuard(target, this.router.current(target)?.threadId, beforeSubmit);
    guard?.();
    const provider = this.models.status(target).modelProvider ?? "openai";
    const resolved: ProviderAccountLimits = this.providerAccounts
      ? await this.providerAccounts.accountLimits(provider, undefined, guard)
      : { kind: "unsupported", provider };
    guard?.();
    if (resolved.kind !== "rate-limits" || !this.requestMetricsQuery) {
      return resolved;
    }
    const nowMs = Date.now();
    const weeklyEstimates = (await Promise.all(resolved.limits.limits.map(async (limit) => {
      if (limit.limitId !== "codex") return [];
      const window = [limit.primary, limit.secondary].find(
        (candidate) => candidate?.windowDurationMins === 10_080,
      );
      if (!window || window.resetsAt === null) return [];
      guard?.();
      const observation = await this.requestMetricsQuery?.weeklyQuotaEstimate(
        "openai",
        limit.limitId,
        window.resetsAt,
        nowMs,
      ) ?? null;
      const estimate = estimateWeeklyLimit(limit, observation);
      return estimate === null ? [] : [estimate];
    }))).flat();
    guard?.();
    return weeklyEstimates.length === 0
      ? resolved
      : { ...resolved, weeklyEstimates };
  }

  private accountThreadGuard(target: ConversationTarget, threadId: string | undefined, beforeSubmit?: () => void): (() => void) | undefined {
    if (!beforeSubmit) return undefined;
    return () => {
      beforeSubmit();
      if (this.router.current(target)?.threadId !== threadId) {
        throw new UserFacingError("command.authorization-changed", "命令目标会话已变化，请重新查询账户");
      }
      if (threadId && !this.router.isSubscriptionReady(threadId)) {
        throw new UserFacingError("conversation.busy", "会话订阅尚未恢复，请稍后重新查询账户", { reason: "subscription-restoring" });
      }
    };
  }

  async requestMetrics(
    target: ConversationTarget,
    query: RequestMetricsCommandQuery = { view: "session" },
    assertAuthorized?: () => void,
  ): Promise<RequestMetricsResult | null> {
    assertAuthorized?.();
    if (!this.requestMetricsQuery) return null;
    const threadId = this.router.current(target)?.threadId;
    const result = query.view === "session"
      ? threadId ? await this.requestMetricsQuery.forThread(threadId) : null
      : query.view === "errors"
        ? await this.requestMetricsQuery.errors(query.range ?? "24h")
        : await this.requestMetricsQuery.aggregate(query.view, query.range ?? "24h");
    assertAuthorized?.();
    if (query.view === "session" && this.router.current(target)?.threadId !== threadId) {
      throw new UserFacingError("command.authorization-changed", "命令目标会话已变化，请重新查询统计");
    }
    return result;
  }
}
