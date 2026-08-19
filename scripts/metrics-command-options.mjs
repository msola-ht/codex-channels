import { managedModelProviderDefinitions } from "../runtime/model-provider-definitions.mjs";
import { loadConfiguredCustomPrimaryModelProvider } from "../runtime/model-provider-runtime.mjs";

export const metricsProviderIds = Object.freeze([
  "openai",
  ...managedModelProviderDefinitions.map(({ id }) => id),
]);
export const metricsProviderUsage = metricsProviderIds.join("|");

export function isMetricsProviderId(value, environment = process.env) {
  if (typeof value !== "string") return false;
  if (new Set(metricsProviderIds).has(value)
    || value === "opencode-go"
    || /^opencode-go-[a-z0-9_-]{1,32}$/u.test(value)) {
    return true;
  }
  const customPrimaryProvider = loadConfiguredCustomPrimaryModelProvider(environment);
  return customPrimaryProvider !== undefined && customPrimaryProvider.id === value;
}

export const metricsCommandUsage = Object.freeze({
  run: "用法：codexc metrics run <Thread ID> [--format markdown|json|csv] [--stdout]",
  turns: "用法：codexc metrics turns <Thread ID> [--format markdown|json|csv] [--stdout]",
  threads: "用法：codexc metrics threads [--format markdown|json|csv] [--stdout]",
  report: "用法：codexc metrics report [--range <today|yesterday|this-week|last-week|this-month|last-month|24h|7d|30d|90d|365d|all> | --from YYYY-MM-DD --to YYYY-MM-DD] [--group <global|providers|models>] [--format markdown|json|csv] [--stdout]",
  export: "用法：codexc metrics export [--range <today|yesterday|this-week|last-week|this-month|last-month|24h|7d|30d|90d|365d|all> | --from YYYY-MM-DD --to YYYY-MM-DD] [--format <json|csv|markdown>] [--thread <Thread ID>] [--stdout]",
});

export function metricsRange(name, nowMs) {
  const duration = {
    "24h": 24 * 60 * 60 * 1_000,
    "7d": 7 * 24 * 60 * 60 * 1_000,
    "30d": 30 * 24 * 60 * 60 * 1_000,
    "90d": 90 * 24 * 60 * 60 * 1_000,
    "365d": 365 * 24 * 60 * 60 * 1_000,
  }[name];
  if (duration !== undefined) {
    return { name, startAtMs: Math.max(0, nowMs - duration), endAtMs: nowMs };
  }
  if (name === "all") return { name, startAtMs: 0, endAtMs: nowMs };
  const today = startOfLocalDay(nowMs);
  if (name === "today") return { name, startAtMs: today, endAtMs: nowMs };
  if (name === "yesterday") {
    return { name, startAtMs: addLocalDays(today, -1), endAtMs: today };
  }
  const thisWeek = startOfLocalWeek(nowMs);
  if (name === "this-week") return { name, startAtMs: thisWeek, endAtMs: nowMs };
  if (name === "last-week") {
    return { name, startAtMs: addLocalDays(thisWeek, -7), endAtMs: thisWeek };
  }
  const thisMonth = startOfLocalMonth(nowMs);
  if (name === "this-month") return { name, startAtMs: thisMonth, endAtMs: nowMs };
  if (name === "last-month") {
    const startAtMs = previousLocalMonth(thisMonth);
    return { name, startAtMs, endAtMs: thisMonth };
  }
  throw new Error(
    "--range 只支持 today、yesterday、this-week、last-week、this-month、last-month、24h、7d、30d、90d、365d 或 all",
  );
}

export function metricsRangeOptions(options, nowMs) {
  if (options.from === undefined && options.to === undefined) {
    return metricsRange(options.range ?? "30d", nowMs);
  }
  if (options.range !== undefined || options.from === undefined || options.to === undefined) {
    throw new Error("自定义日期必须同时使用 --from 和 --to，且不能与 --range 同时使用");
  }
  const startAtMs = parseLocalDate(options.from);
  const requestedEndAtMs = addLocalDays(parseLocalDate(options.to), 1);
  const endAtMs = Math.min(requestedEndAtMs, nowMs);
  if (startAtMs >= endAtMs) throw new Error("自定义日期范围无效");
  return {
    name: `${options.from}..${options.to}`,
    startAtMs,
    endAtMs,
  };
}

export function metricsDimension(value) {
  const result = { global: "global", providers: "provider", models: "model" }[value];
  if (!result) throw new Error("--group 只支持 global、providers 或 models");
  return result;
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

export function validateMetricsCommandArgs(subcommand, args, environment = process.env) {
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
      new Set(["--range", "--from", "--to", "--group", "--format"]),
    );
    assertExportFormat(options.format ?? "markdown", ["markdown", "json", "csv"]);
    metricsRangeOptions(options, Date.now());
    if (options.group !== undefined) metricsDimension(options.group);
    return;
  }
  if (subcommand === "export") {
    const options = parseMetricsOptions(
      withoutStdout,
      new Set(["--range", "--from", "--to", "--format", "--thread"]),
    );
    assertExportFormat(options.format ?? "json", ["json", "csv", "markdown"]);
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
    if (args.length !== 1 || !isMetricsProviderId(args[0], environment)) {
      throw new Error(`用法：codexc metrics prune <${metricsProviderUsage}>`);
    }
    return;
  }
  if (subcommand === "upgrade" || subcommand === "sync-reset") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--restart-gateway")) {
      throw new Error(`用法：codexc metrics ${subcommand} [--restart-gateway]`);
    }
    return;
  }
  if ((subcommand === "status" || subcommand === "reset") && args.length > 0) {
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
  return parseThreadCommandArgs(args, metricsCommandUsage.turns);
}

export function parseMetricsThreadsArgs(args) {
  let format = "markdown";
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
    throw new Error(`未知参数：${option}`);
  }
  assertExportFormat(format, ["markdown", "json", "csv"]);
  return { format };
}

export function assertExportFormat(value, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`--format 只支持 ${allowed.join("、")}`);
  }
}

function parseThreadCommandArgs(args, usage) {
  let threadId;
  let format = "markdown";
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
      throw new Error(`未知参数：${option}`);
    }
    if (threadId !== undefined) {
      throw new Error("只能指定一个 Thread ID");
    }
    threadId = option;
  }
  if (!threadId) throw new Error(usage);
  assertExportFormat(format, ["markdown", "json", "csv"]);
  return { threadId, format };
}

export function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 必须是正整数`);
  return value;
}

export function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new Error("日期必须使用 YYYY-MM-DD 格式");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    throw new Error(`日期无效：${value}`);
  }
  return date.getTime();
}

function startOfLocalDay(nowMs) {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addLocalDays(timestamp, days) {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function startOfLocalWeek(nowMs) {
  const date = new Date(startOfLocalDay(nowMs));
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
}

function startOfLocalMonth(nowMs) {
  const date = new Date(nowMs);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function previousLocalMonth(timestamp) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth() - 1, 1).getTime();
}
