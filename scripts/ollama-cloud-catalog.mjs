import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { connectHomePath } from "../runtime/connect-home.mjs";
import { ensurePrivateDirectorySync, inspectPrivateDirectoryAccessSync, readPrivateFileSync, writePrivateFileAtomic } from "../runtime/private-file.mjs";
import { withPrivateFileLock } from "../runtime/private-file-lock.mjs";
import { ollamaCloudProviderDefinition, isManagedProviderModelValid } from "../runtime/model-provider-definitions.mjs";
import { createIndependentModelDraft, defaultModelDisplayName } from "../runtime/model-catalog.mjs";
import { createResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { withThirdPartyLocalTools } from "../runtime/third-party-model-catalog.mjs";

const origin = "https://ollama.com";
const maximumBytes = 2 * 1024 * 1024;
const maximumTotalBytes = 16 * 1024 * 1024;
const maximumModels = 64;
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cacheLifetimeMs = 60 * 60 * 1000;
const cacheMaximumBytes = 2 * 1024 * 1024;
const hex = z.string().regex(/^[a-f0-9]{64}$/u);
const date = z.string().max(40).refine(value => Number.isFinite(Date.parse(value)));
const effort = z.enum([...efforts]);
const fingerprintSchema = z.object({ digest: z.string().min(1).max(256).regex(/^[^\p{Cc}]+$/u),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), modifiedAt: date,
  capabilities: z.array(z.string().max(64).regex(/^[^\p{Cc}]*$/u)).max(32), }).strict();
const candidateSchema = z.object({ id: z.string().min(1).max(200).refine(value => isManagedProviderModelValid(ollamaCloudProviderDefinition, value)),
  status: z.literal("candidate"), requiresResponsesVerification: z.literal(false),
  upstreamContextWindow: z.number().int().min(1024).max(Number.MAX_SAFE_INTEGER), contextWindowPolicyCap: z.literal(393_216),
  proposedContextWindow: z.number().int().min(1024).max(393_216), reasoningEfforts: z.array(effort).min(1).max(7),
  defaultReasoningEffort: effort, reasoningMode: z.enum(["toggle", "levels"]), imageCandidate: z.boolean(),
  applyPatchToolType: z.literal("freeform"), supportsSearchTool: z.literal(true), supportsWebsockets: z.literal(false),
  fingerprint: fingerprintSchema, showSha256: hex,
}).strict().refine(value => value.proposedContextWindow === Math.min(value.upstreamContextWindow, 393_216)
  && new Set(value.reasoningEfforts).size === value.reasoningEfforts.length && value.reasoningEfforts.includes(value.defaultReasoningEffort)
  && (value.reasoningMode !== "toggle" || value.reasoningEfforts.every(level => level === "none" || level === "high"))
  && value.imageCandidate === value.fingerprint.capabilities.includes("vision")
  && ["completion", "tools"].every(capability => value.fingerprint.capabilities.includes(capability)));
const unavailableSchema = z.object({ id: z.string().min(1).max(1024), status: z.enum(["unconfirmed", "excluded"]),
  reason: z.string().min(1).max(256), reasonCode: z.enum(["invalidId", "missingTag", "details", "sourceChanged", "capabilities", "capabilityConflict", "unsupported", "context", "thinking", "defaultThinking"]),
  fingerprint: fingerprintSchema.optional(), showSha256: hex.optional(), }).strict();
const discoverySchema = z.object({ source: z.literal("ollama-cloud"), generatorVersion: z.literal(1), fetchedAt: date,
  sources: z.tuple([z.literal(`${origin}/v1/models`), z.literal(`${origin}/api/tags`), z.literal(`${origin}/api/show`)]),
  modelsSha256: hex, tagsSha256: hex, stable: z.literal(true), unmatchedTags: z.array(z.string().min(1).max(1024)).max(maximumModels),
  candidates: z.array(z.union([candidateSchema, unavailableSchema])).min(1).max(maximumModels),
}).strict().refine(value => new Set(value.candidates.map(candidate => candidate.id)).size === value.candidates.length
  && !value.candidates.some(candidate => ["details", "sourceChanged"].includes(candidate.reasonCode)));
const cacheSchema = z.object({ schemaVersion: z.literal(1), discovery: discoverySchema }).strict();

// Apply the catalog's supported range to both live metadata and existing v1
// snapshots without rewriting a cache or reducing the upstream capability.
function supportedCandidates(candidates) {
  return candidates.map(candidate => candidate.status === "candidate" && candidate.upstreamContextWindow > 100_000_000
    ? { ...candidate, status: "unconfirmed", reasonCode: "context",
      reason: `上游最大上下文 ${candidate.upstreamContextWindow} 超过当前目录支持的 100000000 Token，不能生成目录` }
    : candidate);
}

/** Public metadata cache only; confirmation snapshots retain their separate ten-minute lifetime. */
export async function loadOllamaCloudModels({ environment = process.env, signal, refresh = false, fetchImpl = globalThis.fetch } = {}) {
  if (typeof refresh !== "boolean") throw new Error("Ollama 缓存刷新选项无效");
  const operation = globalThis.AbortSignal.any([globalThis.AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]);
  const home = connectHomePath(environment);
  const directories = [home, join(home, "providers"), join(home, "providers", "ollama-cloud")];
  const path = join(directories[2], "discovery-cache.json");
  const read = () => {
    operation.throwIfAborted();
    for (const directory of directories) {
      try { inspectPrivateDirectoryAccessSync(directory); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    }
    let raw;
    try { raw = readPrivateFileSync(path, cacheMaximumBytes); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    try { return cacheSchema.parse(JSON.parse(raw)).discovery; }
    catch { throw new Error("Ollama 模型缓存格式损坏或版本不受支持；未修改缓存，请检查 discovery-cache.json"); }
  };
  const fresh = value => value && Date.now() >= Date.parse(value.fetchedAt) && Date.now() - Date.parse(value.fetchedAt) < cacheLifetimeMs;
  const result = (value, hit) => ({ ...value, candidates: supportedCandidates(value.candidates), cache: { hit, fetchedAt: value.fetchedAt,
    expiresAt: new Date(Date.parse(value.fetchedAt) + cacheLifetimeMs).toISOString() } });
  const cached = read();
  if (!refresh && fresh(cached)) return result(cached, true);
  for (const directory of directories) {
    try { inspectPrivateDirectoryAccessSync(directory); }
    catch (error) { if (error.code !== "ENOENT") throw error; ensurePrivateDirectorySync(directory); }
  }
  return withPrivateFileLock(path, async () => {
    operation.throwIfAborted();
    const latest = read();
    if (!refresh && fresh(latest)) return result(latest, true);
    const discovery = await discoverOllamaCloudSnapshot({ fetchImpl, signal: operation });
    operation.throwIfAborted();
    // Failed or unstable lookups must not replace the last complete snapshot.
    if (!discovery.stable || discovery.candidates.some(candidate => candidate.reasonCode === "details")) {
      throw new Error("Ollama 模型来源变化或详情读取失败；未更新缓存，请重新读取");
    }
    const document = cacheSchema.parse({ schemaVersion: 1, discovery });
    const content = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(content) > cacheMaximumBytes) throw new Error("Ollama 模型缓存超过 2 MiB，未更新缓存");
    await writePrivateFileAtomic(path, content, { signal: operation });
    operation.throwIfAborted();
    return result(discovery, false);
  }, { label: "Ollama 模型缓存" }).catch(error => {
    operation.throwIfAborted();
    throw error;
  });
}

/** Public metadata only: no credentials, persistence or capability acceptance. */
export async function discoverOllamaCloudModels({ fetchImpl = globalThis.fetch, signal } = {}) {
  const discovery = await discoverOllamaCloudSnapshot({ fetchImpl, signal });
  return { ...discovery, candidates: supportedCandidates(discovery.candidates) };
}

async function discoverOllamaCloudSnapshot({ fetchImpl, signal }) {
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
    || thinking.values.some(value => typeof value !== "boolean" && (typeof value !== "string" || !efforts.has(value)))) {
    return unconfirmed("思考元数据缺失或含未确认的布尔/等级映射", "thinking");
  }
  // Ollama's OpenAI compatibility maps none to false and recognized efforts to
  // true for boolean-only controls. High is a carrier for "on", not a strength.
  const toggle = thinking.values.every(value => typeof value === "boolean");
  if (!toggle && thinking.values.includes(true)) return unconfirmed("混合开关与等级的开启值无法唯一映射", "thinking");
  const mapEffort = value => value === false ? "none" : value === true ? "high" : value;
  const levels = thinking.values.map(mapEffort);
  const defaultLevel = mapEffort(thinking.default);
  if (!thinking.values.includes(thinking.default)) return unconfirmed("默认思考值不在来源选项中", "defaultThinking");
  if (new Set(levels).size !== levels.length || !levels.includes(defaultLevel)) return unconfirmed("默认思考等级或等级集合无效", "defaultThinking");
  return { id, status: "candidate", requiresResponsesVerification: false,
    upstreamContextWindow: context, contextWindowPolicyCap: 393_216,
    proposedContextWindow: Math.min(context, 393_216),
    reasoningEfforts: levels, defaultReasoningEffort: defaultLevel,
    reasoningMode: toggle ? "toggle" : "levels",
    imageCandidate: show.capabilities.includes("vision"),
    applyPatchToolType: "freeform", supportsSearchTool: true, supportsWebsockets: false,
  };
}

/** Metadata supplies model capabilities; Responses adapters are the OLC default policy. */
export function createOllamaCloudDiscoveredModel(candidate, environment = process.env) {
  if (candidate?.status !== "candidate") throw new Error("Ollama 模型元数据不完整，不能生成目录");
  let name = "";
  for (const character of defaultModelDisplayName(candidate.id) || candidate.id) {
    if (name.length + character.length > 120) break;
    name += character;
  }
  return withThirdPartyLocalTools(createResponsesModelCatalog([createIndependentModelDraft({
    id: candidate.id, name,
    // The default window policy must not replace the upstream capability limit.
    contextWindow: candidate.proposedContextWindow, maxContextWindow: candidate.upstreamContextWindow,
    reasoningEfforts: candidate.reasoningEfforts, defaultReasoningEffort: candidate.defaultReasoningEffort,
    ...(candidate.reasoningMode === "toggle" ? { reasoningDescriptions: Object.fromEntries(candidate.reasoningEfforts.map(effort =>
      [effort, effort === "none" ? "关闭思考" : "开启思考（兼容值 high，不代表强度等级）"])) } : {}),
    supportsImages: candidate.imageCandidate, supportsImageDetailOriginal: false,
    applyPatchToolType: "freeform", supportsSearchTool: true, supportsWebSearch: false,
    supportsReasoningSummary: false, defaultReasoningSummary: "none",
    supportsVerbosity: false, defaultVerbosity: null,
  })], candidate.id, {}, environment), environment).models[0];
}
