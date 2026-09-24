import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { providerStorageRoot } from "./connect-home.mjs";
import { executableInvocation, resolveExecutable } from "./executable.mjs";
import { record } from "./model-provider-managed-runtime.mjs";
import { writePrivateFileAtomicSync } from "./private-file.mjs";

const officialModelCatalogMaximumBytes = 8 * 1024 * 1024;
const officialModelCatalogTimeoutMs = 30_000;

export function customOfficialModelCatalogPath(environment = process.env) {
  return join(providerStorageRoot(environment), "custom", "official-models.json");
}

export function withOfficialModelCatalog(argumentsList, catalogPath) {
  if (typeof catalogPath !== "string" || catalogPath.trim() === "") {
    throw new Error("Codex 官方模型目录路径无效");
  }
  const kept = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const value = argumentsList[index];
    if (value === "-c") {
      const next = argumentsList[index + 1];
      if (typeof next === "string" && next.startsWith("model_catalog_json=")) {
        index += 1;
        continue;
      }
    }
    kept.push(value);
  }
  return [...kept, "-c", `model_catalog_json=${JSON.stringify(catalogPath)}`];
}

export function readOfficialModelCatalog(environment = process.env, codexBinary = environment.CODEX_BINARY ?? "codex") {
  if (typeof codexBinary !== "string" || codexBinary.trim() === "") {
    throw new Error("Codex CLI 路径无效");
  }
  let invocation;
  try {
    invocation = executableInvocation(
      resolveExecutable(codexBinary, environment),
      ["debug", "models", "--bundled"],
      environment,
    );
  } catch {
    throw new Error("无法启动 Codex CLI 导出官方模型目录");
  }
  const result = spawnSync(invocation.file, invocation.args, {
    encoding: "utf8",
    env: environment,
    maxBuffer: officialModelCatalogMaximumBytes,
    timeout: officialModelCatalogTimeoutMs,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("Codex 官方模型目录导出失败；请运行 codexc doctor 检查 Codex CLI 安装");
  }
  return parseOfficialModelCatalog(result.stdout);
}

export function writeCustomOfficialModelCatalog(environment = process.env, codexBinary) {
  if (typeof codexBinary !== "string" || codexBinary.trim() === "") throw new Error("Codex CLI 路径无效");
  const catalog = readOfficialModelCatalog(environment, codexBinary);
  const path = customOfficialModelCatalogPath(environment);
  writePrivateFileAtomicSync(path, `${JSON.stringify(catalog)}\n`);
  return path;
}

function parseOfficialModelCatalog(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Codex 官方模型目录不是有效 JSON");
  }
  const models = record(parsed).models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("Codex 官方模型目录缺少模型");
  }
  const slugs = new Set();
  for (const value of models) {
    const model = record(value);
    const slug = model.slug;
    if (typeof slug !== "string" || slug.trim() === "" || slugs.has(slug)) {
      throw new Error("Codex 官方模型目录包含无效模型");
    }
    slugs.add(slug);
  }
  return parsed;
}
