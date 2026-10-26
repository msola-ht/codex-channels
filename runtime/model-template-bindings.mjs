const sources = new Set(["official", "deepseek", "cline"]);
const reserved = new Set(["__proto__", "prototype", "constructor"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function modelId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && !reserved.has(value);
}

/** Read explicit provenance only; never infer bindings from model names. */
export function readModelTemplateBindings(manifest, modelIds) {
  if (!record(manifest)) throw new Error("模型来源清单无效");
  if (!Object.hasOwn(manifest, "modelTemplates")) return {};
  const bindings = manifest.modelTemplates;
  if (!record(bindings)) throw new Error("模型模板关联无效");
  const enabled = new Set(modelIds);
  const result = {};
  for (const [id, reference] of Object.entries(bindings)) {
    if (!modelId(id) || !enabled.has(id) || !record(reference)
      || Object.keys(reference).length !== 2 || !Object.hasOwn(reference, "source")
      || !Object.hasOwn(reference, "model") || !sources.has(reference.source) || !modelId(reference.model)) {
      throw new Error("模型模板关联无效或引用了目录中不存在的模型");
    }
    result[id] = { source: reference.source, model: reference.model };
  }
  return result;
}

/** OLC metadata provenance is separate from explicitly selected prompt templates. */
export function validateOllamaCloudCatalogManifest(manifest, modelIds) {
  const bindings = readModelTemplateBindings(manifest, modelIds);
  if (manifest.source !== "ollama-cloud" || Object.values(bindings).some(binding => binding.source !== "official")) {
    throw new Error("Ollama Cloud 目录来源须为 ollama-cloud，提示词模板仅支持 official");
  }
  if (manifest.templateUpdates !== undefined) {
    if (!record(manifest.templateUpdates) || Object.entries(manifest.templateUpdates).some(([id, update]) =>
      !modelIds.includes(id) || !record(update) || update.source !== "official" || !modelId(update.model)
      || typeof update.revision !== "string" || !/^[a-f0-9]{64}$/u.test(update.revision)
      || !Array.isArray(update.sections) || update.sections.length === 0 || update.sections.length > 2
      || new Set(update.sections).size !== update.sections.length
      || update.sections.some(section => !["prompts", "settings"].includes(section)))) {
      throw new Error("Ollama Cloud 模板更新记录无效");
    }
  }
  if (manifest.modelDiscovery !== undefined) {
    const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
    const date = value => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
    const levels = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    if (!record(manifest.modelDiscovery) || Object.keys(manifest.modelDiscovery).length > 64
      || Buffer.byteLength(JSON.stringify(manifest.modelDiscovery)) > 128 * 1024
      || Object.entries(manifest.modelDiscovery).some(([id, source]) => {
        if (!modelIds.includes(id) || !record(source) || Object.keys(source).length !== 11
          || Object.keys(source).some(key => !["generatorVersion", "sources", "fetchedAt", "modelsSha256", "tagsSha256", "showSha256", "fingerprint", "upstreamContextWindow", "contextWindowPolicyCap", "verification", "model"].includes(key))
          || source.model !== id || source.generatorVersion !== 1 || !date(source.fetchedAt)
          || !hex(source.modelsSha256) || !hex(source.tagsSha256) || !hex(source.showSha256)
          || !Array.isArray(source.sources) || source.sources.length !== 3
          || source.sources.some((url, index) => url !== ["https://ollama.com/v1/models", "https://ollama.com/api/tags", "https://ollama.com/api/show"][index])
          || !Number.isSafeInteger(source.upstreamContextWindow) || source.upstreamContextWindow <= 0
          || source.contextWindowPolicyCap !== 393_216 || !record(source.fingerprint)) return true;
        const fingerprint = source.fingerprint;
        if (Object.keys(fingerprint).length !== 4 || Object.keys(fingerprint).some(key => !["digest", "size", "modifiedAt", "capabilities"].includes(key))
          || typeof fingerprint.digest !== "string" || !fingerprint.digest || fingerprint.digest.length > 256 || /\p{Cc}/u.test(fingerprint.digest)
          || !Number.isSafeInteger(fingerprint.size) || fingerprint.size < 0 || !date(fingerprint.modifiedAt)
          || !Array.isArray(fingerprint.capabilities) || fingerprint.capabilities.length > 32
          || fingerprint.capabilities.some(value => typeof value !== "string" || value.length > 64 || /\p{Cc}/u.test(value))) return true;
        const verification = source.verification;
        return !record(verification) || Object.keys(verification).length !== 5
          || Object.keys(verification).some(key => !["verifiedAt", "reasoningEfforts", "jsonReasoningEffort", "requests", "scope"].includes(key))
          || !date(verification.verifiedAt) || verification.scope !== "responses-sse-and-json-default-roundtrip"
          || !Array.isArray(verification.reasoningEfforts) || !verification.reasoningEfforts.length || verification.reasoningEfforts.length > 7
          || new Set(verification.reasoningEfforts).size !== verification.reasoningEfforts.length
          || verification.reasoningEfforts.some(value => !levels.has(value))
          || !verification.reasoningEfforts.includes(verification.jsonReasoningEffort)
          || verification.requests !== verification.reasoningEfforts.length * 2 + 2;
      })) throw new Error("Ollama Cloud 模型发现与验证来源记录无效");
  }
  return bindings;
}

/** Existing Cline provenance stays readable; new fixed catalogs use DS bindings. */
export function validateClinePassCatalogManifest(manifest, modelIds, defaultModel) {
  const bindings = readModelTemplateBindings(manifest, modelIds);
  if (Object.hasOwn(manifest, "cline")) {
    const source = manifest.cline;
    if (!record(source) || Object.keys(source).length !== 2 || Object.keys(source).some(key => !["commit", "downloadedAt"].includes(key))
      || typeof source.commit !== "string" || !/^[a-f0-9]{40}$/u.test(source.commit)
      || !Number.isSafeInteger(source.downloadedAt) || source.downloadedAt <= 0
      || !["deepseek", "cline"].includes(manifest.source)
      || manifest.source === "deepseek" && manifest.model !== "deepseek-flash"
      || modelIds.includes(defaultModel) !== (manifest.source === "deepseek")) throw new Error("CLP 模型目录与来源不一致");
  } else if (manifest.source !== "deepseek" || manifest.model !== undefined || !Object.hasOwn(manifest, "modelTemplates")) {
    throw new Error("CLP 固定模型目录来源无效");
  }
  return bindings;
}
