import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { deepseekProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import { createDeepseekTemplateCatalog } from "./provider-model-catalog.mjs";
import { createManagedProviderCatalog } from "./managed-model-provider-setup.mjs";

export const deepseekSetupScriptUrl = "https://cdn.deepseek.com/api-docs/codex-deepseek-setup.sh";
const maximumScriptBytes = 2 * 1024 * 1024;
const defaultDownloadAttempts = 3;
const defaultDownloadTimeoutMs = 30_000;
const minimumWindowPercent = 10;
const maximumWindowPercent = 100;

export async function downloadDeepseekCatalog(
  fetchImpl,
  {
    attempts = defaultDownloadAttempts,
    sleep = defaultSleep,
    timeoutMs = defaultDownloadTimeoutMs,
    signal: operationSignal,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("当前 Node.js 环境不支持 fetch");
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    operationSignal?.throwIfAborted();
    const deadline = globalThis.AbortSignal.timeout(timeoutMs);
    const signal = operationSignal ? globalThis.AbortSignal.any([operationSignal, deadline]) : deadline;
    let response;
    try {
      response = await fetchImpl(deepseekSetupScriptUrl, {
        headers: { accept: "text/plain" },
        redirect: "follow",
        signal,
      });
    } catch {
      operationSignal?.throwIfAborted();
      lastError = signal.aborted
        ? new Error("DeepSeek 官方脚本下载超时")
        : new Error("DeepSeek 官方脚本网络请求失败");
      if (attempt < attempts) {
        await sleep(attempt * 1_000, operationSignal);
        continue;
      }
      throw lastError;
    }
    if (!response.ok) {
      await response.body?.cancel();
      operationSignal?.throwIfAborted();
      lastError = new Error(`DeepSeek 官方脚本下载失败：HTTP ${response.status}`);
      if (!isRetryableStatus(response.status) || attempt === attempts) throw lastError;
      await sleep(attempt * 1_000, operationSignal);
      continue;
    }
    if (response.url && response.url !== deepseekSetupScriptUrl) {
      await response.body?.cancel();
      throw new Error("DeepSeek 官方脚本下载发生了未允许的重定向");
    }
    let script;
    try {
      script = await readLimitedResponseText(response, maximumScriptBytes);
    } catch (error) {
      operationSignal?.throwIfAborted();
      if (error instanceof Error && error.message === "DeepSeek 官方脚本超过允许大小") {
        throw error;
      }
      lastError = signal.aborted
        ? new Error("DeepSeek 官方脚本下载超时")
        : new Error("DeepSeek 官方脚本响应读取失败");
      if (attempt < attempts) {
        await sleep(attempt * 1_000, operationSignal);
        continue;
      }
      throw lastError;
    }
    operationSignal?.throwIfAborted();
    const catalog = extractDeepseekCatalog(script);
    return {
      catalog,
      sha256: createHash("sha256").update(script).digest("hex"),
    };
  }
  throw lastError ?? new Error("DeepSeek 官方脚本下载失败");
}

async function readLimitedResponseText(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    await response.body?.cancel();
    throw new Error("DeepSeek 官方脚本超过允许大小");
  }
  if (!response.body) {
    throw new Error("DeepSeek 官方脚本响应缺少正文");
  }
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
      throw new Error("DeepSeek 官方脚本超过允许大小");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function defaultSleep(milliseconds, signal) {
  return delay(milliseconds, undefined, { signal });
}

export function extractDeepseekCatalog(script) {
  const matches = [...script.matchAll(
    /<<'CODEX_MODELS_JSON'\s*\r?\n([\s\S]*?)\r?\nCODEX_MODELS_JSON(?:\r?\n|$)/gu,
  )];
  if (matches.length !== 1) {
    throw new Error("DeepSeek 官方脚本中的模型目录标记无效");
  }
  let catalog;
  try {
    catalog = JSON.parse(matches[0][1]);
  } catch {
    throw new Error("DeepSeek 官方模型目录不是有效 JSON");
  }
  if (!catalog || !Array.isArray(catalog.models)) {
    throw new Error("DeepSeek 官方模型目录缺少 models");
  }
  return catalog;
}

export function createManagedDeepseekCatalog(
  catalog,
  previousModels = [],
  windowPercent = null,
) {
  if (windowPercent !== null && (
    !Number.isInteger(windowPercent)
    || windowPercent < minimumWindowPercent
    || windowPercent > maximumWindowPercent
  )) {
    throw new Error("DeepSeek 上下文窗口百分比无效");
  }
  return createManagedProviderCatalog(
    createDeepseekTemplateCatalog(catalog, "deepseek"),
    deepseekProviderDefinition,
    {
      previousModels,
      windowPercent,
    },
  );
}
