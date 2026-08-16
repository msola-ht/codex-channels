import { existsSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import * as clackPrompts from "@clack/prompts";
import { parse, stringify } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { opencodeGoProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import {
  loadPrimaryModelProvider,
  loadManagedModelProviderSettings,
  managedModelProviderRoleConfigPath,
  withManagedModelCatalogSettings,
  withPreservedManagedModelCatalogSettings,
} from "../runtime/model-provider-runtime.mjs";
import { writePrivateFileAtomic } from "../runtime/private-file.mjs";
import { createManagedProviderMarker } from "../runtime/model-provider-profile.mjs";
import { configureThirdPartyRole } from "./agents.mjs";
import { deepseekSetupScriptUrl, downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import {
  applyExclusiveProviderConfig,
  createSwitchingProviderProfile,
  hasProviderBaseConfig,
  restoreProviderBaseConfig,
} from "./managed-model-provider-setup.mjs";

const definition = opencodeGoProviderDefinition;
const defaultAutoCompactPercent = 60;

class OpenCodeGoSetupCancelled extends Error {}

export async function runOpenCodeGoSetup({
  allowBack = false,
  environment = process.env,
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  downloadCatalog = downloadDeepseekCatalog,
  prompts = clackPrompts,
  prompter,
  configureRole = configureThirdPartyRole,
} = {}) {
  const prompt = prompter ?? createPrompter(prompts, { allowBack });
  try {
    const action = await prompt.select(allowBack);
    if (action === "back") return { action: "back" };
    const paths = providerPaths(environment);
    if (action === "restore") {
      if (!await prompt.confirm("确认恢复首次配置 OpenCode Go 前的文件？", false)) {
        output.write("已取消，未修改任何文件。\n");
        return undefined;
      }
      await restoreInitialFiles(paths);
      output.write("已恢复配置 OpenCode Go 前的文件。\n");
      output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
      return { action: "restored", ...publicPaths(paths) };
    }

    const mode = action;
    await assertProfileOwnership(paths.profilePath, paths.markerPath);
    if (mode === "exclusive") {
      const primary = loadPrimaryModelProvider(environment);
      if (primary !== "openai" && primary !== definition.id) {
        throw new Error(`请先恢复当前固定 Provider：${primary}`);
      }
      if (!await prompt.confirm("固定模式会修改并备份 ~/.codex/config.toml，确认继续？", false)) {
        output.write("已取消，未修改任何文件。\n");
        return undefined;
      }
    }
    const apiKey = await prompt.secret("OpenCode Go API Key（以 sk- 开头）");
    if (!/^sk-[^\s"]+$/u.test(apiKey) || apiKey.length > 4_096) {
      throw new Error("OpenCode Go API Key 无效");
    }
    const previous = loadManagedModelProviderSettings(environment).find(
      (candidate) => candidate.provider === definition.id,
    );
    const selectedModel = previous?.model ?? definition.defaultModel;
    const downloaded = await downloadCatalog(fetchImpl);
    const model = downloaded.catalog.models.find(
      (candidate) => candidate?.slug === definition.defaultModel,
    );
    const contextWindow = model?.context_window;
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
      throw new Error("OpenCode Go 模型目录缺少上下文窗口");
    }
    const autoCompactLimit = Math.round(contextWindow * defaultAutoCompactPercent / 100);
    const defaultCatalog = withManagedModelCatalogSettings(
      downloaded.catalog,
      definition,
      {
        model: definition.defaultModel,
        reasoningEffort: definition.defaultReasoningEffort,
        autoCompactLimit,
      },
    );
    const managedCatalog = withPreservedManagedModelCatalogSettings(
      defaultCatalog,
      definition,
      previous?.models,
    );
    const trackedPaths = Object.entries(paths)
      .filter(([name]) => name !== "codexHome")
      .map(([, path]) => path);
    const snapshots = await snapshotFiles(trackedPaths);
    let guards;
    try {
      await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
      await preserveInitialFiles(paths);
      const currentConfig = await readTomlFile(paths.configPath);
      const initialConfig = await readBackupToml(paths);
      const currentMode = await readManagedMode(paths.markerPath);
      let nextConfig = currentConfig;
      let profileContent;
      if (mode === "switching") {
        if (currentMode === "exclusive") {
          nextConfig = restoreProviderBaseConfig(currentConfig, initialConfig, definition);
        }
        if (hasProviderBaseConfig(nextConfig, definition)) {
          throw new Error(
            `安装前的 Codex config.toml 已占用 ${definition.displayName} Provider 或 Profile；请先手工移除或改名`,
          );
        }
        profileContent = stringify(createSwitchingProviderProfile(definition, {
          apiKey,
          catalogPath: paths.catalogPath,
          model: selectedModel,
        }));
      } else {
        nextConfig = applyExclusiveProviderConfig(currentConfig, definition, {
          apiKey,
          catalogPath: paths.catalogPath,
          model: selectedModel,
        });
      }
      await writePrivateFileAtomic(
        paths.catalogPath,
        `${JSON.stringify(managedCatalog, null, 2)}\n`,
      );
      await writePrivateFileAtomic(paths.manifestPath, `${JSON.stringify({
        source: deepseekSetupScriptUrl,
        sha256: downloaded.sha256,
        downloadedAt: new Date().toISOString(),
      }, null, 2)}\n`);
      await replaceOptionalFile(
        paths.configPath,
        Object.keys(nextConfig).length === 0 ? undefined : stringify(nextConfig),
      );
      await replaceOptionalFile(paths.profilePath, profileContent);
      await writePrivateFileAtomic(
        paths.markerPath,
        stringify(createManagedProviderMarker(definition, mode)),
      );
      guards = await snapshotFiles(trackedPaths);
      await configureRole(definition.id, selectedModel, environment);
    } catch (error) {
      if (guards === undefined) throw error;
      await restoreSnapshots(snapshots, guards).catch((rollbackError) => {
        throw new AggregateError(
          [error, rollbackError],
          "OpenCode Go 配置失败，且未能完整恢复操作前文件",
        );
      });
      throw error;
    }
    output.write(mode === "switching"
      ? `OpenCode Go Profile 已保存：${paths.profilePath}\n`
      : `OpenCode Go 固定配置已保存：${paths.configPath}\n`);
    output.write(`模型目录已更新：${paths.catalogPath}\n`);
    output.write("共享第三方子代理（agents.external）已切换到 OpenCode Go。\n");
    output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
    return { action: "configured", mode, ...publicPaths(paths) };
  } catch (error) {
    if (allowBack && error instanceof OpenCodeGoSetupCancelled) return { action: "back" };
    throw error;
  }
}

function providerPaths(environment) {
  const codexHome = codexHomePath(environment);
  const backupDirectory = join(codexHome, definition.backupDirectoryName);
  return {
    codexHome,
    configPath: join(codexHome, "config.toml"),
    profilePath: join(codexHome, definition.profileFileName),
    markerPath: join(codexHome, definition.managedMarkerFileName),
    catalogPath: join(codexHome, definition.catalogFileName),
    manifestPath: join(codexHome, definition.catalogManifestFileName),
    roleConfigPath: managedModelProviderRoleConfigPath(environment),
    backupStatePath: join(backupDirectory, "state.json"),
    configBackupPath: join(backupDirectory, "config.toml"),
    profileBackupPath: join(backupDirectory, definition.profileFileName),
    markerBackupPath: join(backupDirectory, definition.managedMarkerFileName),
    roleConfigBackupPath: join(backupDirectory, "sf-agent.config.toml"),
    catalogBackupPath: join(backupDirectory, definition.catalogFileName),
    manifestBackupPath: join(backupDirectory, definition.catalogManifestFileName),
  };
}

function publicPaths(paths) {
  return {
    configPath: paths.configPath,
    profilePath: paths.profilePath,
    markerPath: paths.markerPath,
    catalogPath: paths.catalogPath,
  };
}

async function preserveInitialFiles(paths) {
  if (existsSync(paths.backupStatePath)) return;
  const state = {
    config: await backupOptional(paths.configPath, paths.configBackupPath),
    profile: await backupOptional(paths.profilePath, paths.profileBackupPath),
    marker: await backupOptional(paths.markerPath, paths.markerBackupPath),
    roleConfig: await backupOptional(paths.roleConfigPath, paths.roleConfigBackupPath),
    catalog: await backupOptional(paths.catalogPath, paths.catalogBackupPath),
    manifest: await backupOptional(paths.manifestPath, paths.manifestBackupPath),
  };
  await writePrivateFileAtomic(paths.backupStatePath, `${JSON.stringify(state)}\n`);
}

async function restoreInitialFiles(paths) {
  let state;
  try {
    state = JSON.parse(await readFile(paths.backupStatePath, "utf8"));
  } catch {
    throw new Error("未找到可恢复的 OpenCode Go 初始配置");
  }
  const legacyCatalogState = state.catalog === undefined && state.manifest === undefined;
  const restoredState = {
    config: state.config,
    profile: state.profile,
    marker: state.marker,
    roleConfig: state.roleConfig,
    catalog: legacyCatalogState ? false : state.catalog,
    manifest: legacyCatalogState ? false : state.manifest,
  };
  if (Object.values(restoredState).some((value) => typeof value !== "boolean")) {
    throw new Error("OpenCode Go 初始配置备份状态无效");
  }
  await restoreBackup(paths.configPath, paths.configBackupPath, restoredState.config);
  await restoreBackup(paths.profilePath, paths.profileBackupPath, restoredState.profile);
  await restoreBackup(paths.markerPath, paths.markerBackupPath, restoredState.marker);
  await restoreBackup(
    paths.roleConfigPath,
    paths.roleConfigBackupPath,
    restoredState.roleConfig,
  );
  await restoreBackup(
    paths.catalogPath,
    paths.catalogBackupPath,
    restoredState.catalog,
  );
  await restoreBackup(
    paths.manifestPath,
    paths.manifestBackupPath,
    restoredState.manifest,
  );
}

async function backupOptional(source, target) {
  const content = await readOptionalFile(source);
  if (content === undefined) return false;
  await writePrivateFileAtomic(target, content);
  return true;
}

async function restoreBackup(target, backup, existed) {
  if (existed === true) {
    await writePrivateFileAtomic(target, await readFile(backup));
  } else if (existed === false) {
    await removeOptionalFile(target);
  } else {
    throw new Error("OpenCode Go 初始配置备份状态无效");
  }
}

async function readBackupToml(paths) {
  const state = JSON.parse(await readFile(paths.backupStatePath, "utf8"));
  return state.config ? readTomlFile(paths.configBackupPath) : {};
}

async function readTomlFile(path) {
  const content = await readOptionalFile(path);
  if (content === undefined) return {};
  try {
    return parse(content.toString("utf8"));
  } catch {
    throw new Error("Codex config.toml 无法安全读取或解析");
  }
}

async function readManagedMode(markerPath) {
  const content = await readOptionalFile(markerPath);
  if (content === undefined) return undefined;
  const marker = await parseManagedMarker(content);
  return marker.mode;
}

async function assertProfileOwnership(profilePath, markerPath) {
  const [profile, marker] = await Promise.all([
    readOptionalFile(profilePath),
    readOptionalFile(markerPath),
  ]);
  if (profile === undefined && marker === undefined) return;
  if (marker === undefined) {
    throw new Error("OpenCode Go 管理标记不存在，拒绝覆盖现有 Profile");
  }
  await parseManagedMarker(marker);
}

async function parseManagedMarker(content) {
  let marker;
  try {
    marker = parse(content.toString("utf8"));
  } catch {
    throw new Error("OpenCode Go 管理标记无效，拒绝覆盖现有 Profile");
  }
  if (
    marker.version !== 1
    || marker.provider !== definition.id
    || !["switching", "exclusive"].includes(marker.mode)
  ) {
    throw new Error("OpenCode Go 管理标记无效，拒绝覆盖现有 Profile");
  }
  return marker;
}

async function snapshotFiles(paths) {
  return Promise.all(paths.map(async (path) => ({ path, content: await readOptionalFile(path) })));
}

async function restoreSnapshots(snapshots, guards) {
  for (const guard of guards) {
    const current = await readOptionalFile(guard.path);
    if (!sameOptionalContent(current, guard.content)) {
      throw new Error(`OpenCode Go 配置文件在事务期间发生变化：${guard.path}`);
    }
  }
  for (const snapshot of snapshots) {
    await replaceOptionalFile(snapshot.path, snapshot.content);
  }
}

async function readOptionalFile(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function replaceOptionalFile(path, content) {
  if (content === undefined) return removeOptionalFile(path);
  await writePrivateFileAtomic(path, content);
}

async function removeOptionalFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function sameOptionalContent(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}

function createPrompter(prompts, { allowBack }) {
  return {
    select: async () => {
      const value = await prompts.select({
        message: "OpenCode Go Provider",
        options: [
          { value: "switching", label: "OpenAI + OpenCode Go 切换模式" },
          { value: "exclusive", label: "仅 OpenCode Go 固定模式" },
          { value: "restore", label: "恢复配置前状态" },
          ...(allowBack ? [{ value: "back", label: "返回上一级" }] : []),
        ],
      });
      if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
      return value;
    },
    secret: async (message) => {
      const value = await prompts.password({ message });
      if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
      return value;
    },
    confirm: async (message, initialValue) => {
      const value = await prompts.confirm({ message, initialValue });
      if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
      return value;
    },
  };
}
