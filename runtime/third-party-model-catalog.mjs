import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectorySync, readPrivateFileSync, writePrivateFileAtomicSync } from "./private-file.mjs";

const maximumBytes = 8 * 1024 * 1024;
const localToolNames = ["send_user_message_async", "clock"];

function readLocalTools() {
  const catalog = JSON.parse(readFileSync(new URL("./model-catalog-base.json", import.meta.url), "utf8"));
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length !== 1
    || typeof catalog.models[0]?.slug !== "string" || !catalog.models[0].slug.trim()) {
    throw new Error("基础模型模板缺失、无效或不唯一");
  }
  const tools = catalog.models[0].experimental_supported_tools;
  if (!Array.isArray(tools) || tools.some(tool => typeof tool !== "string" || !tool.trim())
    || localToolNames.some(tool => !tools.includes(tool))) {
    throw new Error("固定底座缺少有效的本地工具声明");
  }
  return tools.filter(tool => localToolNames.includes(tool));
}

/** Shared by explicit template projections and runtime snapshots; never mutate the source. */
export function withThirdPartyLocalTools(catalog) {
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error("第三方运行模型目录缺少模型");
  }
  const localTools = readLocalTools();
  return {
    models: catalog.models.map(model => {
      if (!model || typeof model.slug !== "string" || !model.slug.trim()) {
        throw new Error("第三方运行模型目录包含无效模型");
      }
      const tools = model.experimental_supported_tools === undefined ? [] : model.experimental_supported_tools;
      if (!Array.isArray(tools) || tools.some(tool => typeof tool !== "string" || !tool.trim())) {
        throw new Error("第三方模型工具声明无效");
      }
      return { ...model, experimental_supported_tools: [...new Set([...tools, ...localTools])] };
    }),
  };
}

export function writeThirdPartyRuntimeModelCatalog(sourcePath, dataDir, provider) {
  if (typeof provider !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(provider)) {
    throw new Error("第三方运行模型目录 Provider 无效");
  }
  let catalog;
  try {
    catalog = JSON.parse(readPrivateFileSync(sourcePath, maximumBytes));
  } catch {
    throw new Error("无法安全读取第三方模型目录");
  }
  const content = `${JSON.stringify(withThirdPartyRuntimeTools(catalog))}\n`;
  if (Buffer.byteLength(content) > maximumBytes) throw new Error("第三方运行模型目录超过 8 MiB");
  const runtimeDirectory = join(dataDir, "runtime");
  ensurePrivateDirectorySync(runtimeDirectory);
  const directory = join(runtimeDirectory, "model-catalogs");
  ensurePrivateDirectorySync(directory);
  const path = join(directory, `${provider}.json`);
  writePrivateFileAtomicSync(path, content);
  return path;
}

/** Responses Lite suppresses hosted tools and selects OpenAI's standalone executor. */
export function withThirdPartyRuntimeTools(catalog) {
  const projected = withThirdPartyLocalTools(catalog);
  return { models: projected.models.map(model => ({ ...model, use_responses_lite: false })) };
}
