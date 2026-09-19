import {
  fastServiceTierId,
  isFastServiceTier,
  listProviders,
  type AccountMetric,
  type AccountThreadUsage,
  type AccountThreadUsageGroup,
  type ConversationCommandResult,
  type ModelOption,
} from "../application/index.js";

import {
  formatPercent,
  formatPlanType,
  formatRateLimitState,
  formatRateLimitWindow,
  formatResetTime,
} from "./account-format.js";
import { formatElapsedSeconds } from "./elapsed-duration.js";
import { formatCodexProviderLabel } from "./provider-format.js";
import { formatRequestCount, formatTokenCount } from "./token-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";

const maximumThreadUsageGroups = 8;

export function formatConversationModels(
  result: Extract<ConversationCommandResult, { kind: "models" }>,
): string {
  const { state } = result;
  const current = state.models.find((model) =>
    model.model === state.model
    && (model.provider ?? "openai") === (state.modelProvider ?? "openai"));
  const fast = isFastServiceTier(state.serviceTier, current) ? "开启" : "关闭";
  const providerSwitchNotice = state.providerPending
    ? ["提供商切换将在下一条消息中创建新 Session；当前 Session 会保留，可通过 /resume 恢复。", ""]
    : [];
  const scopedModels = state.providerFilter === undefined
    ? state.models
    : state.models.filter(
        (model) => (model.provider ?? "openai") === state.providerFilter,
      );
  if (result.view === "fast") {
    return toStructuredMarkdownList([
      formatModelStateLine(state),
      `Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`,
      `模型支持：${current && fastServiceTierId(current) ? "支持 Fast" : "不支持 Fast"}`,
      "",
      "切换：/fast [on|off|status]",
    ].join("\n"));
  }
  if (result.view === "effort") {
    return toStructuredMarkdownList([
      formatModelStateLine(state),
      `当前思考等级：${state.effort ?? current?.defaultReasoningEffort ?? "模型默认"}${state.effortPending ? "（下一次 Turn 生效）" : ""}`,
      ...(current && fastServiceTierId(current)
        ? [`Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`]
        : []),
      "",
      ...providerSwitchNotice,
      ...(result.nextSelection === "effort"
        ? ["模型已选择，请继续选择思考等级。", ""]
        : []),
      ...formatCurrentModelNotices(current),
      "",
      "可用思考等级：",
      ...(current?.supportedReasoningEfforts ?? []).map(
        (option, index) =>
          `${index + 1}. ${option.effort}${option.effort === state.effort ? " ← 当前" : ""} · ${option.description}`,
      ),
      "",
      "切换：/effort <序号或档位>",
    ].join("\n"));
  }
  const providers = listProviders(state.models);
  if (providers.length === 0) {
    return toStructuredMarkdownList([
      formatModelStateLine(state),
      "当前没有可选模型。请检查账户配置与订阅状态；续订后可在 WebUI 或当前账户的 /usage 刷新。",
    ].join("\n"));
  }
  if (state.providerFilter === undefined && providers.length > 1) {
    const currentProvider = state.modelProvider ?? "openai";
    return toStructuredMarkdownList([
      formatModelStateLine(state),
      `思考等级：${state.effort ?? "模型默认"}`,
      ...(current && fastServiceTierId(current)
        ? [`Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`]
        : []),
      "",
      `当前 Provider：${formatCodexProviderLabel(currentProvider)}`,
      "可用提供商：",
      ...providers.map((provider, index) =>
        `${index + 1}. ${formatCodexProviderLabel(provider)}${provider === currentProvider ? " ← 当前" : ""} · ${state.models.filter((model) => (model.provider ?? "openai") === provider).length} 个模型`,
      ),
      "",
      "下一步：/model <提供商序号或 ID>",
    ].join("\n"));
  }
  return toStructuredMarkdownList([
    formatModelStateLine(state),
    `思考等级：${state.effort ?? "模型默认"}`,
    ...(current && fastServiceTierId(current)
      ? [`Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`]
      : []),
    ...formatCurrentModelNotices(current),
    "",
    ...providerSwitchNotice,
    `当前 Provider：${formatCodexProviderLabel(state.providerFilter ?? state.modelProvider ?? providers[0])}`,
    `模型列表（${scopedModels.length}）：`,
    ...scopedModels.map(
      (model, index) =>
        `${index + 1}. ${model.displayName} · ${model.model}${model.available === false ? ` · 暂不可用${model.unavailableReason ? `（${model.unavailableReason}）` : ""}` : ""}${fastServiceTierId(model) ? " · 支持 Fast" : ""}${formatModelUpgradeBadge(model)}${model.model === state.model && (model.provider ?? "openai") === (state.modelProvider ?? "openai") ? " ← 当前" : ""}`,
    ),
    "",
    "切换：/model <模型序号、ID 或名称>",
  ].join("\n"));
}

function formatCurrentModelNotices(model: ModelOption | undefined): string[] {
  if (!model) return [];
  const notices: string[] = [];
  if (model.multiAgentVersion) {
    const runtime = model.multiAgentVersion === "disabled"
      ? "不支持"
      : model.multiAgentVersion === "v1"
        ? "v1（旧版）"
        : "v2";
    notices.push(`Codex 多代理运行时：${runtime}`);
  }
  if (model.upgrade) {
    notices.push([
      `官方模型提示：建议切换到 ${model.upgrade.model}`,
      ...(model.upgrade.retirementAtSeconds === null
        ? []
        : [`退役时间：${formatUtcDate(model.upgrade.retirementAtSeconds)}（UTC）`]),
    ].join(" · "));
  }
  return notices;
}

function formatModelUpgradeBadge(model: ModelOption): string {
  if (!model.upgrade) return "";
  const retirement = model.upgrade.retirementAtSeconds === null
    ? ""
    : ` · 退役 ${formatUtcDate(model.upgrade.retirementAtSeconds)} UTC`;
  return ` · 官方建议替代 ${model.upgrade.model}${retirement}`;
}

function formatUtcDate(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1_000).toISOString().slice(0, 10);
}

export function formatNextMessageModel(value: { model: string; modelProvider?: string }): string {
  return formatConversationModel("下一条消息模型", value);
}

export function formatConversationModel(
  label: string,
  value: { model: string; modelProvider?: string },
): string {
  return `${label}：${value.model}${value.modelProvider ? ` · Provider：${formatDisplayedProvider(value.modelProvider)}` : ""}`;
}

export function formatDisplayedProvider(provider: string): string {
  return provider.startsWith("ocg-") ? formatCodexProviderLabel(provider) : provider;
}

function formatModelStateLine(
  state: Extract<ConversationCommandResult, { kind: "models" }>["state"],
): string {
  return state.modelPending
    ? formatNextMessageModel(state)
    : `当前模型：${state.model}`;
}

export function formatConversationUsage(
  result: Extract<ConversationCommandResult, { kind: "usage" }>,
): string {
  if (result.result.kind === "subscription-required") {
    return `${formatCodexProviderLabel(result.result.provider)} 无有效订阅，可能已到期或尚未开通。请检查订阅状态；续订后可重新执行 /usage 查询。`;
  }
  if (result.result.kind === "unsupported") {
    return `${formatCodexProviderLabel(result.result.provider)} 仅提供模型请求，不提供账户余额/额度查询。请求次数与 Token 可通过 /metrics 查看。`;
  }
  if (result.result.kind === "balance") {
    return toStructuredMarkdownList([
      `${formatCodexProviderLabel(result.result.provider)} 账户余额：`,
      `API 可用：${result.result.available ? "是" : "否"}`,
      ...(result.result.balances.length === 0
        ? ["暂无余额信息"]
        : result.result.balances.flatMap((balance) => [
            "",
            `${balance.currency}：`,
            `总余额：${balance.totalBalance}`,
            `赠金余额：${balance.grantedBalance}`,
            `充值余额：${balance.toppedUpBalance}`,
        ])),
    ].join("\n"));
  }
  if (result.result.kind === "quota-windows") {
    return toStructuredMarkdownList([
      `${formatCodexProviderLabel(result.result.provider)} 账户用量：`,
      `API 可用：${result.result.available ? "是" : "否"}`,
      ...(result.result.windows.length === 0
        ? ["暂无用量数据"]
        : result.result.windows.map((window) => {
            const reset = window.resetsAt === null
              ? "未知"
              : formatResetTime(window.resetsAt);
            const localTokens = window.localTokens === undefined
              || window.localTokens === null
              ? ""
              : ` · 本地 Token 约 ${formatTokenCount(window.localTokens)}`;
            return `- ${window.label}：已用 ${formatPercent(window.usedPercent)}${localTokens} · 重置 ${reset}`;
          })),
    ].join("\n"));
  }
  const daily = [...result.result.usage.daily]
    .sort((left, right) => right.startDate.localeCompare(left.startDate))
    .slice(0, 7);
  const lines = [
    "OpenAI Codex 账户用量摘要：",
    `累计 Tokens：${formatUsageTokens(result.result.usage.summary.lifetimeTokens)}`,
    `单日峰值：${formatUsageTokens(result.result.usage.summary.peakDailyTokens)}`,
    `最长 Turn：${formatAccountDuration(result.result.usage.summary.longestRunningTurnSec)}`,
    `当前连续天数：${formatMetric(result.result.usage.summary.currentStreakDays)}`,
    `最长连续天数：${formatMetric(result.result.usage.summary.longestStreakDays)}`,
    "",
    "最近每日用量：",
    ...(daily.length === 0
      ? ["暂无每日数据"]
      : daily.map(
          (entry) => `- ${entry.startDate}：${formatUsageTokens(entry.tokens)}`,
        )),
  ];
  appendThreadUsage(lines, result.result.threadUsage);
  return toStructuredMarkdownList(lines.join("\n"));
}

function appendThreadUsage(
  lines: string[],
  threadUsage: AccountThreadUsage | undefined,
): void {
  if (!threadUsage) {
    return;
  }
  lines.push("", "当前 Session 官方估算：");
  if (threadUsage.kind === "unavailable") {
    lines.push(
      "当前 Session 的官方计费估算不可用；该能力目前仅向部分 Business/Enterprise 工作区开放。",
    );
    return;
  }
  if (threadUsage.kind === "failed") {
    lines.push("当前 Session 官方估算暂时无法查询，请稍后重试 /usage。");
    return;
  }
  lines.push(`Credits：${formatMicros(threadUsage.estimatedUsageCreditsMicros)}`);
  if (threadUsage.estimatedUsageUsdMicros !== null) {
    lines.push(`估算费用：$${formatMicros(threadUsage.estimatedUsageUsdMicros)}`);
  }
  const tokenSummary = formatThreadTokenSummary(threadUsage.groups);
  if (tokenSummary) {
    lines.push(`计费 Token：${tokenSummary}`);
  }
  const visibleGroups = threadUsage.groups.slice(0, maximumThreadUsageGroups);
  lines.push(
    ...visibleGroups.map((group) =>
      `${group.model ?? "其他"} · ${group.reasoningEffort ?? "其他"} · ${group.speed ?? "其他"}`
      + `：${formatMicros(group.estimatedUsageCreditsMicros)} Credits`),
  );
  if (threadUsage.groups.length > visibleGroups.length) {
    lines.push(`尚未展示 ${threadUsage.groups.length - visibleGroups.length} 组`);
  }
  lines.push(
    "",
    "官方估算可能延迟更新；本地请求明细与子代理累计请查看 /metrics。",
  );
}

function formatThreadTokenSummary(
  groups: readonly AccountThreadUsageGroup[],
): string | null {
  if (groups.length === 0) {
    return null;
  }
  const entries: Array<[
    string,
    "inputTokens" | "cachedInputTokens" | "outputTokens",
  ]> = [
    ["输入", "inputTokens"],
    ["缓存", "cachedInputTokens"],
    ["输出", "outputTokens"],
  ];
  const parts = entries.flatMap(([label, field]) => {
    const total = sumThreadMetric(groups, field);
    return total === null ? [] : [`${label} ${formatMetric(total)}`];
  });
  return parts.length === 0 ? null : parts.join(" · ");
}

function sumThreadMetric(
  groups: readonly AccountThreadUsageGroup[],
  field: "inputTokens" | "cachedInputTokens" | "outputTokens",
): AccountMetric | null {
  let total = 0n;
  for (const group of groups) {
    const value = group[field];
    if (value === null) {
      return null;
    }
    total += typeof value === "bigint" ? value : BigInt(value);
  }
  return total;
}

function formatMicros(value: AccountMetric): string {
  const micros = typeof value === "bigint" ? value : BigInt(value);
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

export function formatConversationLimits(
  result: Extract<ConversationCommandResult, { kind: "limits" }>,
): string {
  if (result.result.kind === "unsupported") {
    return `${formatCodexProviderLabel(result.result.provider)} 仅提供模型请求，不提供账户限额查询。请求统计可通过 /metrics 查看。`;
  }
  const planType = result.result.limits.limits.find(
    (limit) => limit.planType,
  )?.planType;
  const weeklyEstimates = result.result.weeklyEstimates ?? [];
  const hasWeeklyWindow = result.result.limits.limits.some((limit) =>
    [limit.primary, limit.secondary].some(
      (window) => window?.windowDurationMins === 10_080,
    ));
  return toStructuredMarkdownList([
    "OpenAI Codex 额度：",
    `套餐：${planType ? formatPlanType(planType) : "未知"}`,
    ...result.result.limits.limits.flatMap((limit) => [
      "",
      `${limit.limitName ?? limit.limitId}：`,
      `主窗口：${formatAccountLimitWindow(limit.primary)}`,
      ...(limit.secondary
        ? [`次窗口：${formatAccountLimitWindow(limit.secondary)}`]
        : []),
      ...(limit.credits
        ? [`Credits：${limit.credits.unlimited
          ? "无限"
          : limit.credits.hasCredits
            ? `余额 ${limit.credits.balance ?? "未知"}`
            : "无可用 Credits"}`]
        : []),
      ...(limit.individualLimit
        ? [
            `个人限额：已用 ${limit.individualLimit.used} / ${limit.individualLimit.limit}`,
            `个人限额剩余：${formatPercent(limit.individualLimit.remainingPercent)}`,
            `个人限额重置：${formatResetTime(limit.individualLimit.resetsAt)}`,
          ]
        : []),
      ...(limit.spendControlReached === null
        ? []
        : [`消费控制：${limit.spendControlReached ? "已达到上限" : "正常"}`]),
      `限流状态：${formatRateLimitState(limit.rateLimitReachedType)}`,
    ]),
    ...formatResetCreditLines(
      result.result.limits.resetCreditsAvailable,
      result.result.limits.resetCreditExpiresAt,
    ),
    ...(hasWeeklyWindow
      ? [
          "",
          "周限估算（本机代理样本）：",
          ...(weeklyEstimates.length === 0
            ? ["正在采样；需要同一周窗口内至少出现一次可观测的额度增长。"]
            : weeklyEstimates.flatMap((estimate) => {
                return [
                "本周期本机实际：",
                `  - 请求：${formatRequestCount(estimate.periodRequestCount ?? estimate.requestCount)} 次`,
                `  - Token：${formatTokenCount(estimate.periodTotalTokens ?? estimate.totalTokensPerPercent)}`,
                `观测变化 ${formatPercent(estimate.observedDeltaPercent)}（${estimate.intervalCount} 个区间）`,
                `每 1%：约 ${formatTokenCount(estimate.totalTokensPerPercent)} Token`,
                `  - 输入：约 ${formatTokenCount(estimate.inputTokensPerPercent)}`,
                `  - 输出：约 ${formatTokenCount(estimate.outputTokensPerPercent)}`,
                "推算 100% 总额度：",
                `  - Token：约 ${formatTokenCount(estimate.totalTokensPerPercent * 100)}`,
                `剩余 ${formatPercent(estimate.remainingPercent)}：约 ${formatTokenCount(estimate.remainingTokens)} Token`,
                ...(estimate.observedDeltaPercent < 1
                  ? ["提示：观测到的额度变化不足 1%，估算波动可能较大。"]
                  : []),
                ];
              })),
          "口径：按统计代理相邻额度快照的增量折算；其他客户端在快照间的用量可能造成偏差。",
        ]
      : []),
  ].join("\n"));
}

function formatResetCreditLines(
  available: AccountMetric | null,
  expiresAt: Array<number | null> | null | undefined,
): string[] {
  if (available === null) {
    return [];
  }
  const lines = ["", `可用额度重置券：${available}`];
  if (available === 0 || available === 0n) {
    return lines;
  }
  if (!expiresAt || expiresAt.length === 0) {
    return [...lines, "重置券到期时间：服务端未提供明细"];
  }

  const counts = new Map<number | null, number>();
  for (const timestamp of expiresAt) {
    counts.set(timestamp, (counts.get(timestamp) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort(([left], [right]) => {
    if (left === null) return 1;
    if (right === null) return -1;
    return left - right;
  });
  const detailLines = entries.map(([timestamp, count]) =>
    `  - ${timestamp === null ? "无到期时间" : formatResetTime(timestamp)}：${count} 张`);
  const availableCount = accountMetricToBigInt(available);
  const undisclosedCount = availableCount === null
    ? 0n
    : availableCount - BigInt(expiresAt.length);
  if (undisclosedCount > 0n) {
    detailLines.push(`  - 其余 ${undisclosedCount} 张：服务端未提供明细`);
  }
  return [...lines, "重置券到期时间：", ...detailLines];
}

function accountMetricToBigInt(value: AccountMetric): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

function formatAccountLimitWindow(
  window: Parameters<typeof formatRateLimitWindow>[0],
): string {
  return formatRateLimitWindow(window);
}

function formatMetric(value: bigint | number | null): string {
  return value === null ? "未知" : String(value);
}

function formatAccountDuration(value: bigint | number | null): string {
  return value === null ? "未知" : formatElapsedSeconds(value);
}

function formatUsageTokens(value: bigint | number | null): string {
  return value === null ? "未知" : formatTokenCount(Number(value));
}
