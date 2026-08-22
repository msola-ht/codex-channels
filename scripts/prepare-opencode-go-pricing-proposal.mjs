import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseSemanticHtmlTables } from "./semantic-html-table.mjs";

export const openCodeGoPageUrl = "https://opencode.ai/docs/go/";

const maximumPageBytes = 512 * 1024;
const maximumErrorLength = 2_000;
const defaultDownloadAttempts = 3;
const defaultDownloadTimeoutMs = 30_000;
const modelPattern = /^[a-z0-9][a-z0-9._-]{0,119}$/u;
const pricingHeader = [
  "Model",
  "Input",
  "Output",
  "Cached Read",
  "Cached Write",
  "Usage",
];
const peakHoursPattern = /Peak hours are\s+(.+?)\s+UTC/u;
const localRangePattern = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/u;
const localRangeGlobalPattern = /(\d{2}):(\d{2})-(\d{2}):(\d{2})/gu;
const timeOfDayPattern = /^(.*?)\s*\((Off-Peak|Peak)\)$/u;
const tierPattern = /^(.*?)\s*\((≤|>)\s*(\d+)K tokens\)$/u;
const endpointHeader = ["Model", "Model ID", "Endpoint", "AI SDK Package"];
const allowedEndpointPaths = new Set([
  "/zen/go/v1/responses",
  "/zen/go/v1/chat/completions",
  "/zen/go/v1/messages",
]);
const allowedAiSdkPackages = new Set([
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/anthropic",
]);

export async function runOpenCodeGoPricingProposal({
  baselinePath,
  outputDirectory,
  download = () => downloadOpenCodeGoPage(globalThis.fetch),
}) {
  await mkdir(outputDirectory, { recursive: true });
  try {
    const baseline = validateBaseline(JSON.parse(await readFile(baselinePath, "utf8")));
    const downloaded = await download();
    validateDownload(downloaded);
    const candidate = parseOpenCodeGoPricingPage(downloaded.html);
    const changedModels = compareModels(baseline.models, candidate.models);
    const result = {
      status: "success",
      changed: changedModels.length > 0,
      source: openCodeGoPageUrl,
      sourceSha256: downloaded.sha256,
      sourceEtag: downloaded.etag,
      sourceLastModified: downloaded.lastModified,
      changedModels,
    };
    await Promise.all([
      writeFile(
        resolve(outputDirectory, "candidate-baseline.json"),
        `${JSON.stringify(candidate, null, 2)}\n`,
      ),
      writeFile(resolve(outputDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`),
      writeFile(resolve(outputDirectory, "summary.md"), renderSummary(result)),
    ]);
    return result;
  } catch (error) {
    const message = safeErrorMessage(error);
    const result = {
      status: "failure",
      changed: false,
      source: openCodeGoPageUrl,
      sourceSha256: null,
      sourceEtag: null,
      sourceLastModified: null,
      changedModels: [],
      error: message,
    };
    await Promise.all([
      writeFile(resolve(outputDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`),
      writeFile(
        resolve(outputDirectory, "summary.md"),
        `# OpenCode Go 官方价格检查失败\n\n- 来源：${openCodeGoPageUrl}\n- 错误：${escapeMarkdown(message)}\n\n未创建候选价格基线或 Draft PR。\n`,
      ),
    ]);
    throw error;
  }
}

export async function downloadOpenCodeGoPage(
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
      response = await fetchImpl(openCodeGoPageUrl, {
        headers: { accept: "text/html" },
        redirect: "follow",
        signal,
      });
    } catch {
      lastError = signal.aborted
        ? new Error("OpenCode Go 官方页面下载超时")
        : new Error("OpenCode Go 官方页面网络请求失败");
      if (attempt < attempts) {
        await sleep(attempt * 1_000);
        continue;
      }
      throw lastError;
    }
    if (!response.ok) {
      lastError = new Error(`OpenCode Go 官方页面下载失败：HTTP ${response.status}`);
      if (!isRetryableStatus(response.status) || attempt === attempts) throw lastError;
      await sleep(attempt * 1_000);
      continue;
    }
    if (response.url && normalizeUrl(response.url) !== openCodeGoPageUrl) {
      throw new Error("OpenCode Go 官方页面下载发生了未允许的重定向");
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("text/html")) {
      throw new Error("OpenCode Go 官方页面响应类型不是 HTML");
    }
    const html = await readLimitedResponseText(response, maximumPageBytes);
    const etag = response.headers.get("etag");
    if (etag !== null && (etag.length > 512 || /[\r\n]/u.test(etag))) {
      throw new Error("OpenCode Go 官方页面 ETag 无效");
    }
    const lastModifiedHeader = response.headers.get("last-modified");
    const lastModified = lastModifiedHeader && Number.isFinite(Date.parse(lastModifiedHeader))
      ? new Date(lastModifiedHeader).toISOString()
      : null;
    return {
      html,
      sha256: createHash("sha256").update(html).digest("hex"),
      etag,
      lastModified,
    };
  }
  throw lastError ?? new Error("OpenCode Go 官方页面下载失败");
}

export function parseOpenCodeGoPricingPage(html) {
  if (typeof html !== "string" || html.length === 0 || html.length > maximumPageBytes) {
    throw new Error("OpenCode Go 官方页面正文无效");
  }
  const sourceUpdatedAt = parseSourceUpdatedAt(html);
  const { tables } = parseSemanticHtmlTables(html, "OpenCode Go 官方页面");
  const pricingTable = findTable(tables, pricingHeader, "价格");
  const endpointTable = findTable(tables, endpointHeader, "模型端点");
  const peakHours = parsePeakHours(html);
  const endpointsByDisplayName = new Map();
  for (const row of endpointTable.slice(1)) {
    if (row.length !== endpointHeader.length || !modelPattern.test(row[1])) {
      throw new Error("OpenCode Go 官方模型端点表条目无效");
    }
    const displayName = normalizeModelName(row[0]);
    if (endpointsByDisplayName.has(displayName)) {
      throw new Error(`OpenCode Go 官方模型端点重复：${row[0]}`);
    }
    endpointsByDisplayName.set(displayName, {
      model: row[1],
      endpoint: parseEndpoint(row[2]),
      aiSdkPackage: parseAiSdkPackage(row[3]),
    });
  }
  const rowsByModel = new Map();
  for (const row of pricingTable.slice(1)) {
    if (row.length !== pricingHeader.length) {
      throw new Error("OpenCode Go 官方价格表列数无效");
    }
    const parsedName = parsePricingDisplayName(row[0]);
    const endpointRecord = endpointsByDisplayName.get(normalizeModelName(parsedName.displayName));
    if (!endpointRecord) throw new Error(`OpenCode Go 官方价格模型缺少端点 ID：${row[0]}`);
    const limitedFree = row.slice(1).every((value) => value === "-");
    const entry = rowsByModel.get(endpointRecord.model) ?? {
      ...endpointRecord,
      rows: [],
      offPeak: null,
      peak: null,
      pricingStatus: null,
    };
    if (limitedFree) {
      if (parsedName.maximumInputTokens !== null
        || parsedName.timeOfDay !== null
        || entry.rows.length > 0
        || entry.offPeak !== null
        || entry.peak !== null
        || entry.pricingStatus !== null) {
        throw new Error(`OpenCode Go 官方限时免费模型条目无效：${row[0]}`);
      }
      entry.pricingStatus = "limited-free";
      rowsByModel.set(endpointRecord.model, entry);
      continue;
    }
    if (entry.pricingStatus !== null) {
      throw new Error(`OpenCode Go 官方限时免费模型条目无效：${row[0]}`);
    }
    const price = {
      maximumInputTokens: parsedName.maximumInputTokens,
      input: parseUsd(row[1], false),
      output: parseUsd(row[2], false),
      cachedRead: parseUsd(row[3], false),
      cachedWrite: parseUsd(row[4], true),
      includedUsageUsd: parseUsd(row[5], false),
    };
    if (parsedName.timeOfDay === null) {
      entry.rows.push(price);
    } else {
      if (parsedName.maximumInputTokens !== null || entry[parsedName.timeOfDay] !== null) {
        throw new Error(`OpenCode Go 官方价格时段条目无效：${row[0]}`);
      }
      entry[parsedName.timeOfDay] = price;
    }
    rowsByModel.set(endpointRecord.model, entry);
  }
  if (rowsByModel.size === 0) throw new Error("OpenCode Go 官方价格表没有模型");
  const models = {};
  for (const model of [...rowsByModel.keys()].sort()) {
    const { endpoint, aiSdkPackage, rows, offPeak, peak, pricingStatus } = rowsByModel.get(model);
    if (pricingStatus === "limited-free") {
      models[model] = { endpoint, aiSdkPackage, pricingStatus };
      continue;
    }
    if (offPeak !== null || peak !== null) {
      if (offPeak === null || peak === null) {
        throw new Error(`OpenCode Go 官方价格缺少完整峰谷档位：${model}`);
      }
      if (rows.length > 0 || offPeak.includedUsageUsd !== peak.includedUsageUsd) {
        throw new Error(`OpenCode Go 官方价格峰谷档位无效：${model}`);
      }
      models[model] = {
        endpoint,
        aiSdkPackage,
        peakOffPeak: {
          offPeak: withoutMaximumInputTokens(offPeak),
          peak: withoutMaximumInputTokens(peak),
        },
        includedUsageUsd: offPeak.includedUsageUsd,
      };
      continue;
    }
    validatePriceRows(model, rows);
    const includedUsageUsd = rows[0].includedUsageUsd;
    const normalizedRows = rows.map((row) => ({
      maximumInputTokens: row.maximumInputTokens,
      input: row.input,
      output: row.output,
      cachedRead: row.cachedRead,
      cachedWrite: row.cachedWrite,
    }));
    models[model] = normalizedRows.length === 1
      ? {
          endpoint,
          aiSdkPackage,
          ...withoutMaximumInputTokens(normalizedRows[0]),
          includedUsageUsd,
        }
      : { endpoint, aiSdkPackage, tiers: normalizedRows, includedUsageUsd };
  }
  return validateBaseline({
    schemaVersion: 3,
    source: openCodeGoPageUrl,
    sourceUpdatedAt,
    currency: "USD",
    unit: "per_million_tokens",
    timezone: "UTC",
    peakHours,
    models,
  });
}

function withoutMaximumInputTokens(price) {
  return {
    input: price.input,
    output: price.output,
    cachedRead: price.cachedRead,
    cachedWrite: price.cachedWrite,
  };
}

function validateBaseline(value) {
  if (!isRecord(value)
    || value.schemaVersion !== 3
    || value.source !== openCodeGoPageUrl
    || value.currency !== "USD"
    || value.unit !== "per_million_tokens"
    || typeof value.sourceUpdatedAt !== "string"
    || !Number.isFinite(Date.parse(value.sourceUpdatedAt))
    || value.timezone !== "UTC"
    || !Array.isArray(value.peakHours)
    || value.peakHours.length === 0
    || !value.peakHours.every(isValidLocalRange)
    || !isRecord(value.models)
    || Object.keys(value.models).length === 0) {
    throw new Error("OpenCode Go 官方价格基线格式无效");
  }
  return value;
}

function findTable(tables, expectedHeader, label) {
  const matching = tables.filter((table) =>
    table.length > 0 && arraysEqual(table[0], expectedHeader));
  if (matching.length !== 1) {
    throw new Error(`OpenCode Go 官方页面必须包含唯一${label}表`);
  }
  return matching[0];
}

function parsePricingDisplayName(value) {
  const timeMatch = timeOfDayPattern.exec(value);
  if (timeMatch) {
    return {
      displayName: timeMatch[1],
      maximumInputTokens: null,
      timeOfDay: timeMatch[2] === "Off-Peak" ? "offPeak" : "peak",
    };
  }
  const match = tierPattern.exec(value);
  if (!match) {
    return { displayName: value, maximumInputTokens: null, timeOfDay: null };
  }
  const threshold = Number(match[3]) * 1_000;
  return {
    displayName: match[1],
    maximumInputTokens: match[2] === "≤" ? threshold : null,
    timeOfDay: null,
  };
}

function parsePeakHours(html) {
  const match = peakHoursPattern.exec(html);
  if (!match) throw new Error("OpenCode Go 官方页面缺少 Peak 时段说明");
  const ranges = match[1].match(localRangeGlobalPattern) ?? [];
  const unique = [...new Set(ranges)];
  if (unique.length === 0 || unique.length !== ranges.length) {
    throw new Error("OpenCode Go 官方页面 Peak 时段无效");
  }
  if (!unique.every(isValidLocalRange)) {
    throw new Error("OpenCode Go 官方页面 Peak 时段无效");
  }
  return unique;
}

function isValidLocalRange(value) {
  const match = localRangePattern.exec(value);
  if (!match) return false;
  const [startHour, startMinute, endHour, endMinute] = match
    .slice(1)
    .map((part) => Number(part));
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) {
    return false;
  }
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return start < end;
}

function validatePriceRows(model, rows) {
  if (rows.length === 1) {
    if (rows[0].maximumInputTokens !== null) {
      throw new Error(`OpenCode Go 模型价格档位未覆盖完整范围：${model}`);
    }
    return;
  }
  if (rows.length !== 2
    || !Number.isSafeInteger(rows[0].maximumInputTokens)
    || rows[1].maximumInputTokens !== null
    || rows[0].includedUsageUsd !== rows[1].includedUsageUsd) {
    throw new Error(`OpenCode Go 模型价格档位无效：${model}`);
  }
}

function parseUsd(value, nullable) {
  if (nullable && value === "-") return null;
  const match = /^\$(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(value);
  if (!match) throw new Error(`OpenCode Go 美元价格无效：${value}`);
  const number = Number(value.slice(1));
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000) {
    throw new Error(`OpenCode Go 美元价格超出范围：${value}`);
  }
  return number;
}

function parseEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`OpenCode Go 官方模型端点无效：${value}`);
  }
  if (endpoint.protocol !== "https:"
    || endpoint.origin !== "https://opencode.ai"
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.search !== ""
    || endpoint.hash !== ""
    || !allowedEndpointPaths.has(endpoint.pathname)) {
    throw new Error(`OpenCode Go 官方模型端点无效：${value}`);
  }
  return endpoint.href;
}

function parseAiSdkPackage(value) {
  if (!allowedAiSdkPackages.has(value)) {
    throw new Error(`OpenCode Go 官方 AI SDK Package 无效：${value}`);
  }
  return value;
}

function parseSourceUpdatedAt(html) {
  const matches = [...html.matchAll(/<time\b[^>]*\bdatetime=["']([^"']+)["'][^>]*>/giu)]
    .map((match) => match[1])
    .filter((value) => Number.isFinite(Date.parse(value)));
  const unique = [...new Set(matches)];
  if (unique.length !== 1) throw new Error("OpenCode Go 官方页面更新时间无效");
  return new Date(unique[0]).toISOString();
}

function normalizeModelName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function compareModels(previous, current) {
  const models = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...models]
    .filter((model) => JSON.stringify(previous[model] ?? null) !== JSON.stringify(current[model] ?? null))
    .sort();
}

async function readLimitedResponseText(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null
    && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)) {
    throw new Error("OpenCode Go 官方页面超过允许大小");
  }
  if (!response.body) throw new Error("OpenCode Go 官方页面响应缺少正文");
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
      throw new Error("OpenCode Go 官方页面超过允许大小");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function renderSummary(result) {
  return [
    "# OpenCode Go 官方价格检查",
    "",
    `- 状态：${result.changed ? "发现变化" : "没有变化"}`,
    `- 来源：${result.source}`,
    `- 页面 SHA-256：${result.sourceSha256}`,
    `- Last-Modified：${result.sourceLastModified ?? "无"}`,
    `- ETag：${escapeMarkdown(result.sourceEtag ?? "无")}`,
    `- 价格变化模型：${result.changedModels.length === 0 ? "无" : result.changedModels.map((model) => `\`${model}\``).join("、")}`,
    "",
    "候选基线保存官方页面列出的全部模型 Token 单价、价格档位（含 Peak/Off-Peak）、套餐包含用量、端点和 SDK 协议。",
    "自动检查不会开放新模型、自动合并、发布或部署。",
    "",
  ].join("\n");
}

function validateDownload(value) {
  if (!isRecord(value)
    || typeof value.html !== "string"
    || typeof value.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || (value.etag !== null && typeof value.etag !== "string")
    || (value.lastModified !== null && typeof value.lastModified !== "string")) {
    throw new Error("OpenCode Go 官方页面下载结果无效");
  }
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function main() {
  const [baselinePath, outputDirectory] = process.argv.slice(2);
  if (!baselinePath || !outputDirectory) {
    throw new Error(
      "用法：node scripts/prepare-opencode-go-pricing-proposal.mjs <基线文件> <输出目录>",
    );
  }
  await runOpenCodeGoPricingProposal({ baselinePath, outputDirectory });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
