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
