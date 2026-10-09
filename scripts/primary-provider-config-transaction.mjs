import {
  loadConfiguredCustomSwitchingModelProviders,
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
          "Codex 配置写入结果无法确认；私有凭据新旧版本均保留，自定义切换 Provider Profile 保持移除，请检查主配置后再操作",
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

function switchingProfileSnapshot(environment, providerId) {
  if (providerId === undefined) return undefined;
  return loadConfiguredCustomSwitchingModelProviders(environment)
    .find(({ id }) => id === providerId);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
