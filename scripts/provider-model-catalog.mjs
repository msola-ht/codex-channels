import { readFileSync } from "node:fs";

const settings = JSON.parse(readFileSync(new URL("../provider-model-catalog.json", import.meta.url), "utf8"));

function appendFlashClone(source, slug) {
  const catalog = structuredClone(source);
  const matches = catalog.models.filter((entry) => entry.slug === settings.flashSourceModel);
  if (matches.length !== 1) throw new Error("DS 模型目录必须包含唯一的 Flash 模板");
  if (catalog.models.some((entry) => entry.slug === slug)) {
    throw new Error("DS 模型目录与独立 V4.1 模型重复，请更新模型目录适配");
  }
  catalog.models.push({ ...structuredClone(matches[0]), slug, display_name: settings.v41DisplayName });
  return catalog;
}

export function createOpencodeGoCatalog(source) {
  return appendFlashClone(source, settings.ocg.v41Model);
}

export function createCcgCatalog(source) {
  const catalog = appendFlashClone(source, settings.ccg.v41Model);
  catalog.models = catalog.models.map((entry) => {
    if (entry.slug === settings.ccg.v41Model) return entry;
    const slug = settings.ccg.modelIds[entry.slug];
    if (typeof slug !== "string") throw new Error(`CCG 缺少 DS 模型 ID 映射：${entry.slug}`);
    return { ...entry, slug };
  });
  return catalog;
}
