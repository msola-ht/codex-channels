import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseSemanticHtmlTables } from "./semantic-html-table.mjs";

export const deepseekPricingPageUrl =
  "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";

const maximumPageBytes = 256 * 1024;
const defaultDownloadAttempts = 3;
const defaultDownloadTimeoutMs = 30_000;
const maximumErrorLength = 2_000;
const modelPattern = /^deepseek-[a-z0-9][a-z0-9._-]{0,119}$/u;
const priceLabels = new Map([
  ["百万tokens输入（缓存命中）", "cachedInput"],
  ["百万tokens输入（缓存未命中）", "uncachedInput"],
  ["百万tokens输出", "output"],
]);

export async function runDeepseekPricingProposal({
  baselinePath,
  outputDirectory,
  download = () => downloadDeepseekPricingPage(globalThis.fetch),
}) {
  await mkdir(outputDirectory, { recursive: true });
  try {
    const baseline = parsePricingBaseline(await readFile(baselinePath, "utf8"));
    const downloaded = await download();
    validateDownloadMetadata(downloaded);
    const candidate = parseDeepseekPricingPage(
      downloaded.html,
      downloaded.lastModified,
    );
    const difference = comparePricingBaselines(baseline, candidate);
    const result = {
      status: "success",
      source: deepseekPricingPageUrl,
      sourceSha256: downloaded.sha256,
      sourceEtag: downloaded.etag,
      sourceLastModified: downloaded.lastModified,
      ...difference,
    };
    await writeOutputs(outputDirectory, candidate, result, renderSummary(result));
    return result;
  } catch (error) {
    const message = safeErrorMessage(error);
    const result = {
      status: "failure",
      changed: false,
      source: deepseekPricingPageUrl,
      sourceSha256: null,
      sourceEtag: null,
      sourceLastModified: null,
      scheduleChanged: false,
      changedModels: [],
      error: message,
    };
    await Promise.all([
      writeFile(
        resolve(outputDirectory, "result.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      ),
      writeFile(
        resolve(outputDirectory, "summary.md"),
        `# DeepSeek 官方价格检查失败\n\n- 来源：${deepseekPricingPageUrl}\n- 错误：${escapeMarkdown(message)}\n\n未创建候选价格基线或 Draft PR。\n`,
      ),
    ]);
    throw error;
  }
}

export async function downloadDeepseekPricingPage(
  fetchImpl,
  {
    attempts = defaultDownloadAttempts,
    sleep = defaultSleep,
    timeoutMs = defaultDownloadTimeoutMs,
  } = {},
) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 环境不支持 fetch");
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const signal = globalThis.AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(deepseekPricingPageUrl, {
        headers: { accept: "text/html" },
        redirect: "follow",
        signal,
      });
    } catch {
      lastError = signal.aborted
        ? new Error("DeepSeek 官方价格页下载超时")
        : new Error("DeepSeek 官方价格页网络请求失败");
      if (attempt < attempts) {
        await sleep(attempt * 1_000);
        continue;
      }
      throw lastError;
    }
    if (!response.ok) {
      lastError = new Error(`DeepSeek 官方价格页下载失败：HTTP ${response.status}`);
      if (!isRetryableStatus(response.status) || attempt === attempts) throw lastError;
      await sleep(attempt * 1_000);
      continue;
    }
    if (response.url && normalizeUrl(response.url) !== deepseekPricingPageUrl) {
      throw new Error("DeepSeek 官方价格页下载发生了未允许的重定向");
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("text/html")) {
      throw new Error("DeepSeek 官方价格页响应类型不是 HTML");
    }
    const lastModified = response.headers.get("last-modified");
    if (lastModified === null || !Number.isFinite(Date.parse(lastModified))) {
      throw new Error("DeepSeek 官方价格页缺少有效 Last-Modified");
    }
    let html;
    try {
      html = await readLimitedResponseText(response, maximumPageBytes);
    } catch (error) {
      if (error instanceof Error && error.message.includes("超过允许大小")) throw error;
      lastError = signal.aborted
        ? new Error("DeepSeek 官方价格页下载超时")
        : new Error("DeepSeek 官方价格页响应读取失败");
      if (attempt < attempts) {
        await sleep(attempt * 1_000);
        continue;
      }
      throw lastError;
    }
    const etag = response.headers.get("etag");
    if (etag !== null && (etag.length > 512 || /[\r\n]/u.test(etag))) {
      throw new Error("DeepSeek 官方价格页 ETag 无效");
    }
    return {
      html,
      sha256: createHash("sha256").update(html).digest("hex"),
      etag,
      lastModified: new Date(lastModified).toISOString(),
    };
  }
  throw lastError ?? new Error("DeepSeek 官方价格页下载失败");
}

export function parseDeepseekPricingPage(html, sourceUpdatedAt) {
  if (typeof html !== "string" || html.length === 0 || html.length > maximumPageBytes) {
    throw new Error("DeepSeek 官方价格页正文无效");
  }
  const updatedAt = normalizeTimestamp(sourceUpdatedAt, "来源更新时间");
  const document = parseSemanticHtmlTables(html, "DeepSeek 官方价格页");
  const currentTable = document.tables.find((table) =>
    table.some((row) => row.includes("百万tokens输入（缓存命中）"))
    && !table.some((row) => row.includes("空闲时段")));
  const scheduledTable = document.tables.find((table) =>
    table.some((row) => row.includes("空闲时段"))
    && table.some((row) => row.includes("高峰时段")));
  if (!currentTable || !scheduledTable) {
    throw new Error("DeepSeek 官方价格页缺少当前或峰谷价格表");
  }
  const current = parseCurrentPrices(currentTable);
  const scheduled = parseScheduledPrices(scheduledTable);
  assertSameModels(current, scheduled.offPeak, "当前价与空闲时段价格");
  assertSameModels(current, scheduled.peak, "当前价与高峰时段价格");
  const schedule = parseSchedule(document.text);
  return validateNormalizedBaseline({
    schemaVersion: 1,
    source: deepseekPricingPageUrl,
    sourceUpdatedAt: updatedAt,
    currency: "CNY",
    unit: "per_million_tokens",
    timezone: "Asia/Shanghai",
    plans: [{
      effectiveFrom: null,
      effectiveUntil: schedule.effectiveFrom,
      windows: [{
        kind: "all_day",
        localRanges: [],
        models: current,
      }],
    }, {
      effectiveFrom: schedule.effectiveFrom,
      effectiveUntil: null,
      windows: [{
        kind: "off_peak",
        localRanges: [],
        models: scheduled.offPeak,
      }, {
        kind: "peak",
        localRanges: schedule.peakRanges,
        models: scheduled.peak,
      }],
    }],
  });
}

export function comparePricingBaselines(baseline, candidate) {
  const previousSchedules = scheduleSignature(baseline);
  const currentSchedules = scheduleSignature(candidate);
  const scheduleChanged = previousSchedules !== currentSchedules;
  const models = new Set([
    ...collectModelNames(baseline),
    ...collectModelNames(candidate),
  ]);
  const changedModels = [...models]
    .filter((model) => modelSignature(baseline, model) !== modelSignature(candidate, model))
    .sort();
  return {
    changed: scheduleChanged || changedModels.length > 0,
    scheduleChanged,
    changedModels,
  };
}

function parsePricingBaseline(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("DeepSeek 官方价格基线不是有效 JSON");
  }
  return validateNormalizedBaseline(parsed);
}

function validateNormalizedBaseline(value) {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.source !== deepseekPricingPageUrl
    || value.currency !== "CNY"
    || value.unit !== "per_million_tokens"
    || value.timezone !== "Asia/Shanghai"
    || !Array.isArray(value.plans)
    || value.plans.length === 0
    || value.plans.length > 20) {
    throw new Error("DeepSeek 官方价格基线格式无效");
  }
  const sourceUpdatedAt = normalizeTimestamp(value.sourceUpdatedAt, "来源更新时间");
  const plans = value.plans.map((plan, index) => validatePlan(plan, index));
  if (plans[0].effectiveFrom !== null || plans.at(-1).effectiveUntil !== null) {
    throw new Error("DeepSeek 价格计划必须覆盖完整时间范围");
  }
  for (let index = 1; index < plans.length; index += 1) {
    if (plans[index - 1].effectiveUntil !== plans[index].effectiveFrom) {
      throw new Error("DeepSeek 价格计划存在空档或重叠");
    }
  }
  const expectedModels = collectModelNames({ plans: [plans[0]] });
  for (const plan of plans) {
    assertSameModelNames(expectedModels, collectModelNames({ plans: [plan] }));
  }
  return {
    schemaVersion: 1,
    source: deepseekPricingPageUrl,
    sourceUpdatedAt,
    currency: "CNY",
    unit: "per_million_tokens",
    timezone: "Asia/Shanghai",
    plans,
  };
}

function validatePlan(value, index) {
  if (!isRecord(value) || !Array.isArray(value.windows) || value.windows.length === 0) {
    throw new Error(`DeepSeek 第 ${index + 1} 个价格计划无效`);
  }
  const effectiveFrom = value.effectiveFrom === null
    ? null
    : normalizeTimestamp(value.effectiveFrom, "价格生效时间");
  const effectiveUntil = value.effectiveUntil === null
    ? null
    : normalizeTimestamp(value.effectiveUntil, "价格失效时间");
  if (effectiveFrom !== null
    && effectiveUntil !== null
    && Date.parse(effectiveFrom) >= Date.parse(effectiveUntil)) {
    throw new Error("DeepSeek 价格计划时间范围无效");
  }
  const windows = value.windows.map(validateWindow);
  const kinds = new Set(windows.map(({ kind }) => kind));
  const allDay = windows.length === 1 && kinds.has("all_day");
  const peak = windows.length === 2 && kinds.has("off_peak") && kinds.has("peak");
  if (kinds.size !== windows.length || (!allDay && !peak)) {
    throw new Error("DeepSeek 价格时段组合无效");
  }
  if (peak) {
    const offPeak = windows.find(({ kind }) => kind === "off_peak");
    const peakWindow = windows.find(({ kind }) => kind === "peak");
    if (offPeak.localRanges.length !== 0 || peakWindow.localRanges.length === 0) {
      throw new Error("DeepSeek 峰谷价格时段无效");
    }
  }
  const expectedModels = new Set(Object.keys(windows[0].models));
  for (const window of windows.slice(1)) {
    assertSameModelNames(expectedModels, new Set(Object.keys(window.models)));
  }
  return { effectiveFrom, effectiveUntil, windows };
}

function validateWindow(value) {
  if (!isRecord(value)
    || !["all_day", "off_peak", "peak"].includes(value.kind)
    || !Array.isArray(value.localRanges)
    || !isRecord(value.models)
    || Object.keys(value.models).length === 0) {
    throw new Error("DeepSeek 价格时段无效");
  }
  const localRanges = value.localRanges.map(normalizeLocalRange).sort();
  validateRangeOverlap(localRanges);
  const models = {};
  for (const model of Object.keys(value.models).sort()) {
    const candidate = value.models[model];
    if (!modelPattern.test(model) || !isRecord(candidate)) {
      throw new Error("DeepSeek 价格模型条目无效");
    }
    models[model] = {
      cachedInput: normalizePrice(candidate.cachedInput, model),
      uncachedInput: normalizePrice(candidate.uncachedInput, model),
      output: normalizePrice(candidate.output, model),
    };
  }
  return { kind: value.kind, localRanges, models };
}

function parseCurrentPrices(table) {
  const models = findHeaderModels(table);
  const prices = Object.fromEntries(models.map((model) => [model, {}]));
  for (const [label, key] of priceLabels) {
    const row = table.find((candidate) => candidate.includes(label));
    if (!row) throw new Error(`DeepSeek 当前价格表缺少：${label}`);
    const values = row.slice(-models.length).map(parseYuanPrice);
    models.forEach((model, index) => {
      prices[model][key] = values[index];
    });
  }
  return normalizeModelPrices(prices);
}

function parseScheduledPrices(table) {
  const header = table.find((row) => row.includes("模型"));
  if (!header
    || ![...priceLabels.keys()].every((label) => header.includes(label))) {
    throw new Error("DeepSeek 峰谷价格表表头无效");
  }
  const result = { offPeak: {}, peak: {} };
  let currentModel = null;
  for (const row of table) {
    if (row[0] && modelPattern.test(row[0])) currentModel = row[0];
    const periodIndex = row.findIndex((cell) => cell === "空闲时段" || cell === "高峰时段");
    if (periodIndex < 0) continue;
    if (!currentModel) throw new Error("DeepSeek 峰谷价格行缺少模型");
    const values = row.slice(periodIndex + 1).map(parseYuanPrice);
    if (values.length !== priceLabels.size) throw new Error("DeepSeek 峰谷价格列数无效");
    const target = row[periodIndex] === "空闲时段" ? result.offPeak : result.peak;
    if (target[currentModel]) throw new Error(`DeepSeek 峰谷价格模型重复：${currentModel}`);
    target[currentModel] = {
      cachedInput: values[0],
      uncachedInput: values[1],
      output: values[2],
    };
  }
  return {
    offPeak: normalizeModelPrices(result.offPeak),
    peak: normalizeModelPrices(result.peak),
  };
}

function findHeaderModels(table) {
  const header = table.find((row) => row.includes("模型")
    && row.some((cell) => modelPattern.test(cell)));
  if (!header) throw new Error("DeepSeek 当前价格表缺少模型表头");
  const models = header.filter((cell) => modelPattern.test(cell));
  if (models.length === 0 || new Set(models).size !== models.length) {
    throw new Error("DeepSeek 当前价格表模型无效");
  }
  return models;
}

function parseSchedule(text) {
  const match = /高峰时段为北京时间\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})、\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})（其余为空闲时段）.*?新价格将于北京时间\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})\s*开始生效/u.exec(text);
  if (!match) throw new Error("DeepSeek 官方价格页峰谷时段或生效时间无法解析");
  const ranges = [
    `${normalizeClock(match[1])}-${normalizeClock(match[2])}`,
    `${normalizeClock(match[3])}-${normalizeClock(match[4])}`,
  ].sort();
  validateRangeOverlap(ranges);
  const year = match[5];
  const month = match[6].padStart(2, "0");
  const day = match[7].padStart(2, "0");
  const hour = match[8].padStart(2, "0");
  const minute = match[9];
  const effectiveFrom = `${year}-${month}-${day}T${hour}:${minute}:00+08:00`;
  normalizeTimestamp(effectiveFrom, "价格生效时间");
  return { effectiveFrom, peakRanges: ranges };
}

function normalizeModelPrices(value) {
  const models = {};
  for (const model of Object.keys(value).sort()) {
    if (!modelPattern.test(model) || !isRecord(value[model])) {
      throw new Error("DeepSeek 价格模型条目无效");
    }
    models[model] = {
      cachedInput: normalizePrice(value[model].cachedInput, model),
      uncachedInput: normalizePrice(value[model].uncachedInput, model),
      output: normalizePrice(value[model].output, model),
    };
  }
  if (Object.keys(models).length === 0) throw new Error("DeepSeek 价格模型为空");
  return models;
}

function parseYuanPrice(value) {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?元$/u.exec(value);
  if (!match) throw new Error(`DeepSeek 人民币价格无效：${value}`);
  return normalizePrice(Number(value.slice(0, -1)), "官方页面");
}

function normalizePrice(value, model) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new Error(`DeepSeek 模型价格无效：${model}`);
  }
  return value;
}

function normalizeLocalRange(value) {
  if (typeof value !== "string") throw new Error("DeepSeek 本地价格时段无效");
  const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/u.exec(value);
  if (!match) throw new Error("DeepSeek 本地价格时段无效");
  const start = normalizeClock(match[1]);
  const end = normalizeClock(match[2]);
  if (clockMinutes(start) >= clockMinutes(end)) {
    throw new Error("DeepSeek 本地价格时段无效");
  }
  return `${start}-${end}`;
}

function normalizeClock(value) {
  if (typeof value !== "string" || !/^\d{1,2}:\d{2}$/u.test(value)) {
    throw new Error("DeepSeek 本地价格时段无效");
  }
  const [hourText, minuteText] = value.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59 || (hour === 24 && minute !== 0)) {
    throw new Error("DeepSeek 本地价格时段无效");
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function validateRangeOverlap(ranges) {
  for (let index = 1; index < ranges.length; index += 1) {
    const previousEnd = clockMinutes(ranges[index - 1].split("-")[1]);
    const currentStart = clockMinutes(ranges[index].split("-")[0]);
    if (previousEnd > currentStart) throw new Error("DeepSeek 本地价格时段重叠");
  }
}

function clockMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function normalizeTimestamp(value, label) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error(`DeepSeek ${label}无效`);
  }
  return value;
}

function scheduleSignature(value) {
  return JSON.stringify(value.plans.map((plan) => ({
    effectiveFrom: plan.effectiveFrom,
    effectiveUntil: plan.effectiveUntil,
    windows: plan.windows.map((window) => ({
      kind: window.kind,
      localRanges: window.localRanges,
    })),
  })));
}

function modelSignature(value, model) {
  return JSON.stringify(value.plans.map((plan) => plan.windows.map((window) =>
    window.models[model] ?? null)));
}

function collectModelNames(value) {
  return new Set(value.plans.flatMap((plan) =>
    plan.windows.flatMap((window) => Object.keys(window.models))));
}

function assertSameModels(left, right, label) {
  try {
    assertSameModelNames(new Set(Object.keys(left)), new Set(Object.keys(right)));
  } catch {
    throw new Error(`DeepSeek ${label}的模型集合不一致`);
  }
}

function assertSameModelNames(left, right) {
  if (left.size !== right.size || [...left].some((model) => !right.has(model))) {
    throw new Error("DeepSeek 价格计划的模型集合不一致");
  }
}

function validateDownloadMetadata(value) {
  if (!isRecord(value)
    || typeof value.html !== "string"
    || typeof value.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || (value.etag !== null && typeof value.etag !== "string")) {
    throw new Error("DeepSeek 官方价格页下载结果无效");
  }
  normalizeTimestamp(value.lastModified, "来源更新时间");
}

async function readLimitedResponseText(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null
    && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)) {
    throw new Error("DeepSeek 官方价格页超过允许大小");
  }
  if (!response.body) throw new Error("DeepSeek 官方价格页响应缺少正文");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("DeepSeek 官方价格页超过允许大小");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function writeOutputs(outputDirectory, candidate, result, summary) {
  await Promise.all([
    writeFile(
      resolve(outputDirectory, "candidate-baseline.json"),
      `${JSON.stringify(candidate, null, 2)}\n`,
    ),
    writeFile(
      resolve(outputDirectory, "result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    ),
    writeFile(resolve(outputDirectory, "summary.md"), summary),
  ]);
}

function renderSummary(result) {
  return [
    "# DeepSeek 官方价格检查",
    "",
    `- 状态：${result.changed ? "发现变化" : "没有变化"}`,
    `- 来源：${result.source}`,
    `- 页面 SHA-256：${result.sourceSha256}`,
    `- Last-Modified：${result.sourceLastModified}`,
    `- ETag：${escapeMarkdown(result.sourceEtag ?? "无")}`,
    `- 时段或生效时间变化：${result.scheduleChanged ? "是" : "否"}`,
    `- 价格变化模型：${formatList(result.changedModels)}`,
    "",
    "候选基线只保存结构化人民币 Token 单价、北京时间时段和生效日期。",
    "自动检查不会修改历史价格快照、自动合并、发布或部署。",
    "",
  ].join("\n");
}

function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.href;
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function defaultSleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function safeErrorMessage(error) {
  return (error instanceof Error ? error.message : "未知错误").slice(0, maximumErrorLength);
}

function escapeMarkdown(value) {
  return value.replaceAll("`", "'").replaceAll("\n", " ");
}

function formatList(values) {
  return values.length === 0 ? "无" : values.map((value) => `\`${value}\``).join("、");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function main() {
  const [baselinePath, outputDirectory] = process.argv.slice(2);
  if (!baselinePath || !outputDirectory) {
    throw new Error(
      "用法：node scripts/prepare-deepseek-pricing-proposal.mjs <基线文件> <输出目录>",
    );
  }
  await runDeepseekPricingProposal({ baselinePath, outputDirectory });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
