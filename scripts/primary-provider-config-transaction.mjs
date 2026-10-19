import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { providerStorageRoot } from "../runtime/connect-home.mjs";
import { createProviderFileReader } from "../runtime/provider-file-access.mjs";
import { ensurePrivateDirectorySync, readPrivateFileSync, writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import {
  customPrimaryProviderProfilePath,
  customSwitchingProviderRegistryPath,
  loadConfiguredCustomSwitchingModelProviders,
  loadCustomSwitchingProviderIds,
  removeCustomPrimaryProviderSwitchingProfile,
  restoreCustomPrimaryProviderSwitchingProfile,
  writeCustomPrimaryProviderCredential,
  removeCustomPrimaryProviderCredential,
} from "../runtime/model-provider-runtime.mjs";
import {
  areCodexUserConfigEditsApplied,
  readCodexUserConfigSnapshot,
} from "./codex-user-config.mjs";

export async function writePrimaryProviderConfigEditsWithProfileRemoval({
  environment,
  providerId,
  switchingProvider = switchingProfileSnapshot(environment, providerId),
  edits,
  expectedVersion,
  createClient,
  credential,
}) {
  const client = await createClient({ environment });
  try {
    await client.connect();
    if (switchingProvider !== undefined) {
      preserveSwitchingProfileConversion(environment, switchingProvider, expectedVersion, edits);
    }
    if (credential !== undefined) writeCustomPrimaryProviderCredential(credential, environment);
    try {
      if (switchingProvider !== undefined) {
        removeCustomPrimaryProviderSwitchingProfile(
          environment,
          switchingProvider.id,
          switchingProvider.profileContent,
        );
      }
    } catch (error) {
      if (credential !== undefined) removeCustomPrimaryProviderCredential(environment, credential.providerId, credential.environmentKey);
      throw error;
    }
    try {
      await client.writeUserConfigEdits(edits, { expectedVersion });
      return;
    } catch (error) {
      let currentConfig;
      let applied;
      try {
        currentConfig = (await readCodexUserConfigSnapshot(environment, { createClient })).config;
        applied = areCodexUserConfigEditsApplied(currentConfig, edits);
      } catch (confirmationError) {
        throw new AggregateError(
          [error, confirmationError],
          "Codex 配置写入结果无法确认；私有凭据新旧版本均保留；"
          + (switchingProvider === undefined ? "" : "转换前快照位于 Provider 数据目录的 profile-conversion-backups；")
          + "请检查主配置后再操作",
          { cause: confirmationError },
        );
      }
      if (applied) return;
      const providerBlock = record(record(record(currentConfig).model_providers)[credential?.providerId]);
      if (credential !== undefined && providerBlock.env_key === credential.environmentKey) {
        throw new AggregateError([error], "Codex 配置已引用新的私有凭据，但完整保存结果不一致；已保留凭据版本，请检查主配置后再操作", { cause: error });
      }
      if (credential !== undefined) removeCustomPrimaryProviderCredential(environment, credential.providerId, credential.environmentKey);
      if (switchingProvider === undefined) throw error;
      const currentProvider = optionalString(record(currentConfig).model_provider);
      if ((currentProvider !== undefined && currentProvider !== "openai")
        || Object.prototype.hasOwnProperty.call(record(record(currentConfig).model_providers), switchingProvider.id)) throw error;
      try {
        restoreCustomPrimaryProviderSwitchingProfile(
          environment,
          switchingProvider.id,
          switchingProvider.profileContent,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Codex 配置写入失败，且自定义切换 Provider Profile 回滚失败",
          { cause: rollbackError },
        );
      }
      throw error;
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Preserve the destructive conversion's inputs independently of its RPC outcome. */
function preserveSwitchingProfileConversion(environment, provider, expectedVersion, edits) {
  const read = createProviderFileReader(environment);
  const profilePath = customPrimaryProviderProfilePath(environment, provider.id);
  const registryPath = customSwitchingProviderRegistryPath(environment);
  const profileContent = read(profilePath);
  if (profileContent !== provider.profileContent || !loadCustomSwitchingProviderIds(environment).includes(provider.id)) {
    throw new Error("切换 Provider 在备份前已变化，未执行转换");
  }
  const snapshot = {
    schemaVersion: 1,
    providerId: provider.id,
    expectedVersion,
    edits,
    files: [
      { path: join(codexHomePath(environment), "config.toml"), content: read(join(codexHomePath(environment), "config.toml")) },
      { path: profilePath, content: profileContent },
      { path: registryPath, content: read(registryPath) },
    ],
  };
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  const root = providerStorageRoot(environment);
  ensurePrivateDirectorySync(root);
  const directory = join(root, "profile-conversion-backups");
  ensurePrivateDirectorySync(directory);
  const path = join(directory, `${randomUUID()}.json`);
  writePrivateFileAtomicSync(path, content);
  if (readPrivateFileSync(path, Buffer.byteLength(content)) !== content
    || snapshot.files.some(file => read(file.path) !== file.content)) {
    throw new Error("转换前备份或配置回读不一致，未执行转换；保留备份供核对");
  }
}

function switchingProfileSnapshot(environment, providerId) {
  if (providerId === undefined) return undefined;
  if (!loadCustomSwitchingProviderIds(environment).includes(providerId)) return undefined;
  try {
    return loadConfiguredCustomSwitchingModelProviders(environment, providerId)[0];
  } catch {
    // 其他 Provider 的模型目录不可读不应阻止本次移除；目标自身是否可用由调用方先行校验。
    return undefined;
  }
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
