import { createHash } from "node:crypto";
import { ollamaCloudProviderDefinition, isManagedProviderModelValid } from "../runtime/model-provider-definitions.mjs";

const origin = "https://ollama.com";
const maximumBytes = 2 * 1024 * 1024;
const maximumTotalBytes = 16 * 1024 * 1024;
const maximumModels = 64;
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Public metadata only: no credentials, persistence or capability acceptance. */
export async function discoverOllamaCloudModels({ fetchImpl = globalThis.fetch, signal } = {}) {
  const controller = new AbortController();
  const operation = globalThis.AbortSignal.any([controller.signal, globalThis.AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]);
  let totalBytes = 0;
  const read = async (path, model) => {
    operation.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method: model === undefined ? "GET" : "POST",
        headers: { accept: "application/json", ...(model === undefined ? {} : { "content-type": "application/json" }) },
        ...(model === undefined ? {} : { body: JSON.stringify({ model }) }),
        redirect: "error", signal: operation,
      });
    } catch {
      operation.throwIfAborted();
      throw new Error("Ollama 公开模型接口请求失败");
    }
    if (!response.ok || response.url && response.url !== `${origin}${path}`) {
      await response.body?.cancel();
      throw new Error(`Ollama 公开模型接口拒绝请求（HTTP ${response.status}）`);
    }
    if (!response.body) throw new Error("Ollama 模型元数据缺少正文");
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks = [];
    try {
      for (;;) {
        operation.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        totalBytes += value.byteLength;
        if (bytes > maximumBytes || totalBytes > maximumTotalBytes) {
          controller.abort(new Error("Ollama 模型元数据超过读取预算"));
          operation.throwIfAborted();
        }
        chunks.push(value);
      }
      operation.throwIfAborted();
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new Error("Ollama 模型元数据不是有效 JSON"); }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };
  try {
    const models = await read("/v1/models");
    const ids = modelIds(models);
    const tags = tagIndex(await read("/api/tags"));
    const initialTagsDigest = digest([...tags]);
    const results = new Array(ids.length);
    let cursor = 0;
    // All workers are joined before returning or reporting cancellation.
    const workers = await Promise.allSettled(Array.from({ length: Math.min(3, ids.length) }, async () => {
      while (cursor < ids.length) {
        const index = cursor++;
        const id = ids[index];
        operation.throwIfAborted();
        if (!isManagedProviderModelValid(ollamaCloudProviderDefinition, id)) {
          results[index] = { id, status: "excluded", reasonCode: "invalidId", reason: "模型 ID 不符合长度、空白或字符约束" };
          continue;
        }
        if (!tags.has(id)) {
          results[index] = { id, status: "unconfirmed", reasonCode: "missingTag", reason: "公开模型列表与 tags 集合不一致" };
          continue;
        }
        try {
          const show = await read("/api/show", id);
          const mapped = candidate(id, show, tags.get(id).capabilities);
          results[index] = { ...mapped, fingerprint: tags.get(id), showSha256: digest(show) };
        } catch {
          operation.throwIfAborted();
          results[index] = { id, status: "unconfirmed", reasonCode: "details", reason: "模型详情读取或解析失败；不能判为已下架" };
        }
      }
    }));
    const failure = workers.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    const latestIds = modelIds(await read("/v1/models"));
    const latestTags = tagIndex(await read("/api/tags"));
    const stable = digest(ids) === digest(latestIds) && initialTagsDigest === digest([...latestTags]);
    if (!stable) {
      for (const result of results) {
        result.status = "unconfirmed";
        result.reasonCode = "sourceChanged";
        result.reason = "发现期间来源发生变化，请重新发现；未修改已保存目录";
      }
    }
    return {
      source: "ollama-cloud", generatorVersion: 1, fetchedAt: new Date().toISOString(),
      sources: ["/v1/models", "/api/tags", "/api/show"].map(path => `${origin}${path}`),
      modelsSha256: digest(models), tagsSha256: initialTagsDigest, stable,
      unmatchedTags: [...tags.keys()].filter(id => !ids.includes(id)),
      candidates: results,
    };
  } finally {
    controller.abort();
  }
}

function modelIds(value) {
  if (!record(value) || !Array.isArray(value.data) || !value.data.length || value.data.length > maximumModels
    || value.data.some(item => !record(item) || typeof item.id !== "string" || !item.id.length || item.id.length > 1024)) {
    throw new Error("Ollama 模型列表结构或数量无效");
  }
  const ids = value.data.map(item => item.id).sort();
  if (new Set(ids).size !== ids.length) throw new Error("Ollama 模型列表包含重复 ID");
  return ids;
}

function tagIndex(value) {
  if (!record(value) || !Array.isArray(value.models) || value.models.length > maximumModels) throw new Error("Ollama tags 结构或数量无效");
  const tags = new Map();
  for (const item of value.models) {
    if (!record(item) || typeof item.name !== "string" || !item.name.length || item.name.length > 1024
      || typeof item.digest !== "string" || !item.digest.length || item.digest.length > 256 || /\p{Cc}/u.test(item.digest)
      || !Number.isSafeInteger(item.size) || item.size < 0
      || typeof item.modified_at !== "string" || item.modified_at.length > 40 || !Number.isFinite(Date.parse(item.modified_at))
      || !Array.isArray(item.capabilities) || item.capabilities.length > 32
      || item.capabilities.some(value => typeof value !== "string" || value.length > 64 || /\p{Cc}/u.test(value))
      || tags.has(item.name)) throw new Error("Ollama tags 字段无效或模型名称重复");
    tags.set(item.name, { digest: item.digest, size: item.size, modifiedAt: item.modified_at, capabilities: [...item.capabilities].sort() });
  }
  return new Map([...tags].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function candidate(id, show, tagCapabilities) {
  const unconfirmed = (reason, reasonCode) => ({ id, status: "unconfirmed", reason, reasonCode });
  if (!record(show) || !Array.isArray(show.capabilities) || show.capabilities.some(value => typeof value !== "string")) return unconfirmed("能力字段缺失或无效", "capabilities");
  if (digest([...show.capabilities].sort()) !== digest(tagCapabilities)) return unconfirmed("tags 与 show 的能力声明不一致，请重新发现", "capabilityConflict");
  if (!show.capabilities.includes("completion") || !show.capabilities.includes("tools")) {
    return { id, status: "excluded", reasonCode: "unsupported", reason: "缺少 completion 或 tools 能力" };
  }
  const architecture = show.model_info?.["general.architecture"];
  const contextFields = record(show.model_info) ? Object.entries(show.model_info).filter(([key]) => key.endsWith(".context_length")) : [];
  const context = typeof architecture === "string" ? show.model_info[`${architecture}.context_length`]
    : contextFields.length === 1 ? contextFields[0][1] : undefined;
  if (!Number.isSafeInteger(context) || context < 1024) return unconfirmed("上下文窗口缺失、歧义或无效", "context");
  const thinking = show.thinking;
  if (!record(thinking) || !Array.isArray(thinking.values) || !thinking.values.length || thinking.values.length > 16
    || thinking.values.some(value => value !== false && (typeof value !== "string" || !efforts.has(value)))) {
    return unconfirmed("思考元数据缺失或含未确认的布尔/等级映射", "thinking");
  }
  const levels = thinking.values.map(value => value === false ? "none" : value);
  const defaultLevel = thinking.default === false ? "none" : thinking.default;
  if (new Set(levels).size !== levels.length || !levels.includes(defaultLevel)) return unconfirmed("默认思考等级或等级集合无效", "defaultThinking");
  return { id, status: "candidate", requiresResponsesVerification: true,
    upstreamContextWindow: context, contextWindowPolicyCap: 393_216,
    proposedContextWindow: Math.min(context, 393_216),
    reasoningEfforts: levels, defaultReasoningEffort: defaultLevel,
    imageCandidate: show.capabilities.includes("vision"),
    applyPatchToolType: null, supportsWebsockets: false,
  };
}
