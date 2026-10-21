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
