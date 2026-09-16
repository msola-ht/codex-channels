import { managedModelProviderDefinitions } from "../runtime/model-provider-definitions.mjs";
import { isOpencodeGoProvider } from "../runtime/opencode-go-accounts.mjs";
import {
  isRequestMetricsRangeName,
  requestMetricsAggregationDimension,
  requestMetricsRangeNames,
  resolveRequestMetricsRange,
  resolveRequestMetricsDates,
  parseRequestMetricsDate,
  parseRequestMetricsFilters,
} from "../dist/observability/index.js";
import {
  loadConfiguredCustomPrimaryModelProvider,
  readPrimaryProviderBackup,
} from "../runtime/model-provider-runtime.mjs";

export const metricsProviderIds = Object.freeze([
  "openai",
  ...managedModelProviderDefinitions.map(({ id }) => id),
]);
export function isMetricsProviderId(value, environment = process.env) {
  if (typeof value !== "string") return false;
  if (new Set(metricsProviderIds).has(value)
    || isOpencodeGoProvider(value)) {
    return true;
  }
  const customPrimaryProvider = loadConfiguredCustomPrimaryModelProvider(environment);
  if (customPrimaryProvider !== undefined && customPrimaryProvider.id === value) {
    return true;
  }
  // 候选被 switch openai / 官方登录备份清理后，历史指标仍可按该 ID 清理。
  return Object.prototype.hasOwnProperty.call(readPrimaryProviderBackup(environment), value);
}

// 清理历史指标时允许数据库中已经不存在于当前配置的合法 Provider ID。
// 保持精确大小写匹配，避免把历史 `OpenAI` 误当成官方 `openai`。
export function isPrunableMetricsProviderId(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value);
}

const metricsRangeUsage = requestMetricsRangeNames.join("|");
const rangeUsage = `[--range <${metricsRangeUsage}> | --from YYYY-MM-DD --to YYYY-MM-DD]`;
const filtersUsage = "[--provider ID] [--model ID] [--operation response|compact] [--status completed|failed|incomplete|unknown] [--filter 关键字]";
export const metricsQueryOptions = ["--range", "--from", "--to", "--provider", "--model", "--operation", "--status", "--filter", "--thread", "--turn"];

export function metricsFilterOptions(options) {
  return parseRequestMetricsFilters({
    ...options,
    threadId: options.threadId ?? options.thread,
    turnId: options.turnId ?? options.turn,
  });
}

export const metricsCommandUsage = Object.freeze({
  run: "用法：codexc metrics run <Thread ID> [--format markdown|json|csv] [--stdout]",
  turns: `用法：codexc metrics turns <Thread ID> ${rangeUsage} ${filtersUsage} [--turn ID] [--format markdown|json|csv] [--stdout]`,
  threads: `用法：codexc metrics threads ${rangeUsage} ${filtersUsage} [--thread ID] [--turn ID] [--format markdown|json|csv] [--stdout]`,
  report: `用法：codexc metrics report ${rangeUsage} ${filtersUsage} [--thread ID] [--turn ID] [--group <global|providers|models>] [--format markdown|json|csv] [--stdout]`,
  export: `用法：codexc metrics export ${rangeUsage} ${filtersUsage} [--thread ID] [--turn ID] [--format json|csv|markdown] [--stdout]`,
  quota: `用法：codexc metrics quota [--range <${metricsRangeUsage}> | --from YYYY-MM-DD --to YYYY-MM-DD] [--format markdown|json|csv] [--stdout]`,
});

export function metricsRange(name, nowMs) {
  if (isRequestMetricsRangeName(name)) {
    return resolveRequestMetricsRange(name, nowMs);
  }
  const finalRange = requestMetricsRangeNames.at(-1);
  throw new Error(
    `--range 只支持 ${requestMetricsRangeNames.slice(0, -1).join("、")} 或 ${finalRange}`,
  );
}

export function metricsRangeOptions(options, nowMs, defaultRange = "30d") {
  if (options.from === undefined && options.to === undefined) {
    return metricsRange(options.range ?? defaultRange, nowMs);
  }
  if (options.range !== undefined || options.from === undefined || options.to === undefined) {
    throw new Error("自定义日期必须同时使用 --from 和 --to，且不能与 --range 同时使用");
  }
  return resolveRequestMetricsDates(options.from, options.to, nowMs);
}

export function metricsDimension(value) {
  if (value !== "global" && value !== "providers" && value !== "models") {
    throw new Error("--group 只支持 global、providers 或 models");
  }
  return requestMetricsAggregationDimension(value);
}

export function parseMetricsOptions(args, allowed) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!allowed.has(option)) throw new Error(`未知参数：${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} 缺少值`);
    result[option.slice(2)] = value;
    index += 1;
  }
  return result;
}

export function validateMetricsCommandArgs(subcommand, args) {
  const withoutStdout = args.filter((argument) => argument !== "--stdout");
  if (subcommand === "run") {
    parseMetricsRunArgs(withoutStdout);
    return;
  }
  if (subcommand === "turns") {
    parseMetricsTurnsArgs(withoutStdout);
    return;
  }
  if (subcommand === "threads") {
    parseMetricsThreadsArgs(withoutStdout);
    return;
  }
  if (subcommand === "report") {
    const options = parseMetricsOptions(
      withoutStdout,
      new Set([...metricsQueryOptions, "--group", "--format"]),
    );
    assertExportFormat(options.format ?? "markdown", ["markdown", "json", "csv"]);
    metricsRangeOptions(options, Date.now());
    metricsFilterOptions(options);
    if (options.group !== undefined) metricsDimension(options.group);
    return;
  }
  if (subcommand === "export") {
    const options = parseMetricsOptions(
      withoutStdout,
      new Set([...metricsQueryOptions, "--format"]),
    );
    assertExportFormat(options.format ?? "json", ["json", "csv", "markdown"]);
    metricsRangeOptions(options, Date.now());
    metricsFilterOptions(options);
    return;
  }
  if (subcommand === "quota") {
    const options = parseMetricsOptions(
      withoutStdout,
      new Set(["--range", "--from", "--to", "--format"]),
    );
    assertExportFormat(options.format ?? "markdown", ["markdown", "json", "csv"]);
    metricsRangeOptions(options, Date.now());
    return;
  }
  if (subcommand === "cleanup") {
    const options = parseCleanupOptions(
      args.filter((argument) => argument !== "--restart-gateway"),
    );
    if (options.before !== undefined) parseLocalDate(options.before);
    return;
  }
  if (subcommand === "prune") {
    if (args.length !== 1 || !isPrunableMetricsProviderId(args[0])) {
      throw new Error("用法：codexc metrics prune <provider>");
    }
    return;
  }
  if (subcommand === "upgrade") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--restart-gateway")) {
      throw new Error(`用法：codexc metrics ${subcommand} [--restart-gateway]`);
    }
    return;
  }
  if (
    subcommand === "status"
    && !(args.length === 0 || (args.length === 1 && args[0] === "--json"))
  ) {
    throw new Error("用法：codexc metrics status [--json]");
  }
  if (subcommand === "reset" && args.length > 0) {
    throw new Error(`用法：codexc metrics ${subcommand}`);
  }
}

export function parseCleanupOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--vacuum") {
      options.vacuum = true;
      continue;
    }
    if (!["--before", "--keep-days", "--max-rows"].includes(option)) {
      throw new Error(`未知参数：${option}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} 缺少值`);
    if (option === "--before") options.before = value;
    if (option === "--keep-days") options.keepDays = positiveInteger(Number(value), option);
    if (option === "--max-rows") options.maxRows = positiveInteger(Number(value), option);
    index += 1;
  }
  if (options.before !== undefined && options.keepDays !== undefined) {
    throw new Error("--before 与 --keep-days 不能同时使用");
  }
  return options;
}

export function parseMetricsRunArgs(args) {
  return parseThreadCommandArgs(args, metricsCommandUsage.run);
}

export function parseMetricsTurnsArgs(args) {
  return parseThreadCommandArgs(args, metricsCommandUsage.turns, true);
}

export function parseMetricsThreadsArgs(args) {
  const options = parseMetricsOptions(args, new Set([...metricsQueryOptions, "--format"]));
  const format = options.format ?? "markdown";
  assertExportFormat(format, ["markdown", "json", "csv"]);
  metricsRangeOptions(options, Date.now());
  metricsFilterOptions(options);
  return { ...options, format };
}

export function assertExportFormat(value, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`--format 只支持 ${allowed.join("、")}`);
  }
}

function parseThreadCommandArgs(args, usage, scoped = false) {
  let threadId;
  let format = "markdown";
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--format") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--format 缺少值");
      }
      format = value;
      index += 1;
      continue;
    }
    if (option.startsWith("--")) {
      if (scoped && metricsQueryOptions.includes(option) && option !== "--thread") {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`${option} 缺少值`);
        options[option.slice(2)] = value;
        index += 1;
        continue;
      }
      throw new Error(`未知参数：${option}`);
    }
    if (threadId !== undefined) {
      throw new Error("只能指定一个 Thread ID");
    }
    threadId = option;
  }
  if (!threadId) throw new Error(usage);
  assertExportFormat(format, ["markdown", "json", "csv"]);
  if (scoped) {
    metricsRangeOptions(options, Date.now());
    metricsFilterOptions({ ...options, threadId });
  }
  return { ...options, threadId, format };
}

export function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 必须是正整数`);
  return value;
}

export function parseLocalDate(value) {
  return parseRequestMetricsDate(value);
}
