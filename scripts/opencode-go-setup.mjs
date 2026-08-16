import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import * as clackPrompts from "@clack/prompts";
import { parse, stringify } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  opencodeGoProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import { writePrivateFileAtomic } from "../runtime/private-file.mjs";
import {
  createManagedProviderMarker,
  createManagedProviderProfile,
} from "../runtime/model-provider-profile.mjs";
import {
  deepseekSetupScriptUrl,
  downloadDeepseekCatalog,
} from "./deepseek-setup.mjs";

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
} = {}) {
  const prompt = prompter ?? createPrompter(prompts, { allowBack });
  try {
    const action = await prompt.select(allowBack);
    if (action === "back") return { action: "back" };
    const codexHome = codexHomePath(environment);
    const profilePath = join(codexHome, opencodeGoProviderDefinition.profileFileName);
    const markerPath = join(codexHome, opencodeGoProviderDefinition.managedMarkerFileName);
    const catalogPath = join(codexHome, opencodeGoProviderDefinition.catalogFileName);
    const manifestPath = join(codexHome, opencodeGoProviderDefinition.catalogManifestFileName);
    if (action === "remove") {
      const [profile, marker] = await Promise.all([
        readOptionalFile(profilePath),
        readOptionalFile(markerPath),
      ]);
      if (profile !== undefined || marker !== undefined) {
        await assertManagedMarker(markerPath);
      }
      await Promise.all([
        removeOptionalFile(profilePath),
        removeOptionalFile(markerPath),
      ]);
      output.write("OpenCode Go Provider 已移除；共享 DeepSeek 模型目录已保留。\n");
      output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
      return { action: "removed", profilePath, markerPath };
    }
    await assertProfileOwnership(profilePath, markerPath);
    const apiKey = await prompt.secret("OpenCode Go API Key（以 sk- 开头）");
    if (!/^sk-[^\s"]+$/u.test(apiKey) || apiKey.length > 4_096) {
      throw new Error("OpenCode Go API Key 无效");
    }
    const downloaded = await downloadCatalog(fetchImpl);
    const model = downloaded.catalog.models.find(
      (candidate) => candidate?.slug === opencodeGoProviderDefinition.defaultModel,
    );
    const contextWindow = model?.context_window;
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
      throw new Error("OpenCode Go 共享模型目录缺少上下文窗口");
    }
    const snapshots = await snapshotFiles([profilePath, markerPath, catalogPath, manifestPath]);
    try {
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      await writePrivateFileAtomic(catalogPath, `${JSON.stringify(downloaded.catalog, null, 2)}\n`);
      await writePrivateFileAtomic(manifestPath, `${JSON.stringify({
        source: deepseekSetupScriptUrl,
        sha256: downloaded.sha256,
        downloadedAt: new Date().toISOString(),
      }, null, 2)}\n`);
      await writePrivateFileAtomic(profilePath, stringify(createManagedProviderProfile(
        opencodeGoProviderDefinition,
        {
          apiKey,
          catalogPath,
          autoCompactLimit: Math.round(
          contextWindow * defaultAutoCompactPercent / 100,
          ),
        },
      )));
      await writePrivateFileAtomic(markerPath, stringify(
        createManagedProviderMarker(opencodeGoProviderDefinition),
      ));
    } catch (error) {
      await restoreSnapshots(snapshots).catch((rollbackError) => {
        throw new AggregateError(
          [error, rollbackError],
          "OpenCode Go 配置失败，且未能完整恢复操作前文件",
        );
      });
      throw error;
    }
    output.write(`OpenCode Go Profile 已保存：${profilePath}\n`);
    output.write(`模型目录已更新：${catalogPath}\n`);
    output.write("当前开放模型：deepseek-v4-flash、deepseek-v4-pro\n");
    output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
    return { action: "configured", profilePath, markerPath, catalogPath };
  } catch (error) {
    if (allowBack && error instanceof OpenCodeGoSetupCancelled) {
      return { action: "back" };
    }
    throw error;
  }
}

async function assertProfileOwnership(profilePath, markerPath) {
  const profile = await readOptionalFile(profilePath);
  if (profile === undefined) return;
  await assertManagedMarker(markerPath);
}

async function assertManagedMarker(markerPath) {
  const content = await readOptionalFile(markerPath);
  if (content === undefined) {
    throw new Error("OpenCode Go 管理标记不存在，拒绝覆盖现有 Profile");
  }
  let marker;
  try {
    marker = parse(content?.toString("utf8") ?? "");
  } catch {
    throw new Error("OpenCode Go 管理标记无效，拒绝覆盖现有 Profile");
  }
  if (marker.version !== 1
    || marker.provider !== opencodeGoProviderDefinition.id
    || marker.mode !== "switching") {
    throw new Error("OpenCode Go 管理标记无效，拒绝覆盖现有 Profile");
  }
}

async function snapshotFiles(paths) {
  return Promise.all(paths.map(async (path) => ({ path, content: await readOptionalFile(path) })));
}

async function restoreSnapshots(snapshots) {
  for (const snapshot of snapshots) {
    if (snapshot.content === undefined) {
      await removeOptionalFile(snapshot.path);
    } else {
      await writePrivateFileAtomic(snapshot.path, snapshot.content);
    }
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

async function removeOptionalFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function createPrompter(prompts, { allowBack }) {
  return {
    select: async () => {
      const value = await prompts.select({
        message: "OpenCode Go Provider",
        options: [
          { value: "configure", label: "安装或更新" },
          { value: "remove", label: "移除" },
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
  };
}
