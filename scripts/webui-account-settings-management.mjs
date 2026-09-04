import {
  applyDeepseekConfiguration,
  applyDeepseekRestore,
  previewDeepseekConfiguration,
  previewDeepseekRestore,
} from "./deepseek-setup.mjs";
import {
  applyOpencodeGoDefaultAccountChange,
  applyOpencodeGoAccountRemoval,
  applyOpencodeGoAccountStop,
  previewOpencodeGoAccountRemoval,
  previewOpencodeGoAccountStop,
  previewOpencodeGoDefaultAccountChange,
} from "./opencode-go-account-management.mjs";
import {
  applyOpencodeGoAccountConfiguration as applyOpencodeGoAccountProvisioning,
  previewOpencodeGoAccountConfiguration,
} from "./opencode-go-account-provisioning.mjs";
import {
  loadOpencodeGoAccounts,
  opencodeGoAccountDisplayName,
  readOpencodeGoAccountMarker,
} from "../runtime/opencode-go-accounts.mjs";
import { loadManagedModelProviderSettings } from "../runtime/model-provider-runtime.mjs";
import { ManagementOperationError } from "./webui-management-operations.mjs";

export async function loadAccountSettingsResource(
  environment,
  loadAccounts = loadOpencodeGoAccounts,
  loadProviders = loadManagedModelProviderSettings,
) {
  try {
    const accounts = loadAccounts(environment);
    const providers = loadProviders(environment);
    let restoreAvailable = false;
    try {
      await previewDeepseekRestore({ environment });
      restoreAvailable = true;
    } catch {
      // 没有 DeepSeek 初始备份时不可恢复；详细状态由配置预览返回。
    }
    const deepseek = providers.find((provider) => provider.provider === "deepseek");
    return {
      opencodeGo: {
        configured: accounts.length > 0,
        defaultAccountId: accounts.find((account) => account.default)?.id ?? null,
        accounts: accounts.map((account) => {
          const marker = readOpencodeGoAccountMarker(environment, account.id);
          return {
            id: account.id,
            displayName: opencodeGoAccountDisplayName(account),
            ...(account.email === undefined ? {} : { email: account.email }),
            ...(account.phone === undefined ? {} : { phone: account.phone }),
            ...(marker?.mode === undefined ? {} : { mode: marker.mode }),
            default: account.default === true,
          };
        }),
      },
      deepseek: {
        configured: deepseek !== undefined,
        mode: deepseek?.mode ?? null,
        model: deepseek?.model ?? null,
        restoreAvailable,
      },
    };
  } catch {
    throw new ManagementOperationError("account_state_unavailable", "账户设置暂不可用");
  }
}

export function normalizeAccountSettingsMutation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ManagementOperationError("invalid_json", "账户设置操作正文必须是对象");
  }
  switch (input.operation) {
    case "opencode.account.configure":
      return {
        operation: input.operation,
        accountId: input.accountId,
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.phone === undefined ? {} : { phone: input.phone }),
        ...(input.contact === undefined ? {} : { contact: input.contact }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.reconfigure === undefined ? {} : { reconfigure: input.reconfigure }),
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        ...(input.confirmExclusiveConfigChange === undefined
          ? {}
          : { confirmExclusiveConfigChange: input.confirmExclusiveConfigChange }),
      };
    case "opencode.account.default":
      return { operation: input.operation, accountId: input.accountId };
    case "opencode.account.stop":
      return { operation: input.operation, accountId: input.accountId };
    case "opencode.account.remove":
      return {
        operation: input.operation,
        accountId: input.accountId,
        ...(input.confirmHistoryLoss === undefined ? {} : { confirmHistoryLoss: input.confirmHistoryLoss }),
      };
    case "deepseek.configure":
      return {
        operation: input.operation,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        ...(input.autoCompactPercent === undefined ? {} : { autoCompactPercent: input.autoCompactPercent }),
        ...(input.confirmExclusiveConfigChange === undefined
          ? {}
          : { confirmExclusiveConfigChange: input.confirmExclusiveConfigChange }),
      };
    case "deepseek.restore":
      return {
        operation: input.operation,
        ...(input.confirmRestore === undefined ? {} : { confirmRestore: input.confirmRestore }),
      };
    default:
      throw new ManagementOperationError("invalid_account_operation", "账户设置操作不受支持");
  }
}

export async function previewAccountSettingsMutation(input, environment) {
  try {
    switch (input.operation) {
      case "opencode.account.configure":
        return await previewOpencodeGoAccountConfiguration(input, { environment });
      case "opencode.account.default":
        return previewOpencodeGoDefaultAccountChange(input.accountId, { environment });
      case "opencode.account.stop":
        return await previewOpencodeGoAccountStop(input.accountId, { environment });
      case "opencode.account.remove":
        return await previewOpencodeGoAccountRemoval(input.accountId, { environment });
      case "deepseek.configure":
        return previewDeepseekConfiguration(input, { environment });
      case "deepseek.restore":
        return await previewDeepseekRestore({ environment });
      default:
        throw new ManagementOperationError("invalid_account_operation", "账户设置操作不受支持");
    }
  } catch (error) {
    throw toManagementError(error);
  }
}

export async function applyAccountSettingsMutation(input, environment) {
  try {
    switch (input.operation) {
      case "opencode.account.configure":
        return await applyOpencodeGoAccountProvisioning(accountSettingsApplyInput(input), { environment });
      case "opencode.account.default":
        return await applyOpencodeGoDefaultAccountChange(input.accountId, { environment });
      case "opencode.account.stop":
        return await applyOpencodeGoAccountStop(input.accountId, { environment });
      case "opencode.account.remove":
        return await applyOpencodeGoAccountRemoval(accountSettingsApplyInput(input), { environment });
      case "deepseek.configure":
        return await applyDeepseekConfiguration(accountSettingsApplyInput(input), { environment });
      case "deepseek.restore":
        return await applyDeepseekRestore(accountSettingsApplyInput(input), { environment });
      default:
        throw new ManagementOperationError("invalid_account_operation", "账户设置操作不受支持");
    }
  } catch (error) {
    throw toManagementError(error);
  }
}

export function accountSettingsApplyInput(input) {
  switch (input.operation) {
    case "opencode.account.configure":
      return input.mode === "exclusive"
        ? { ...input, confirmExclusiveConfigChange: true }
        : input;
    case "opencode.account.remove":
      return { ...input, confirmHistoryLoss: true };
    case "deepseek.configure":
      return input.mode === "exclusive"
        ? { ...input, confirmExclusiveConfigChange: true }
        : input;
    case "deepseek.restore":
      return { ...input, confirmRestore: true };
    default:
      return input;
  }
}

export function redactAccountSettingsResult(result) {
  if (!result || typeof result !== "object") return { action: "completed" };
  return {
    ...(typeof result.action === "string" ? { action: result.action } : {}),
    ...(typeof result.operation === "string" ? { operation: result.operation } : {}),
    ...(result.account !== undefined ? { account: redactAccount(result.account) } : {}),
    ...(result.provider !== undefined ? { provider: redactProvider(result.provider) } : {}),
    ...(result.mode !== undefined ? { mode: result.mode } : {}),
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.willChange !== undefined ? { willChange: result.willChange } : {}),
    ...(result.effects !== undefined ? { effects: result.effects } : {}),
    ...(result.confirmation !== undefined ? { confirmation: result.confirmation } : {}),
    ...(result.activation !== undefined ? { activation: result.activation } : {}),
    ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
  };
}

function redactAccount(account) {
  if (account === null || typeof account !== "object") return account;
  return {
    ...(typeof account.id === "string" ? { id: account.id } : {}),
    ...(typeof account.provider === "string" ? { provider: account.provider } : {}),
    ...(typeof account.displayName === "string" ? { displayName: account.displayName } : {}),
    ...(typeof account.email === "string" ? { email: account.email } : {}),
    ...(typeof account.phone === "string" ? { phone: account.phone } : {}),
    ...(typeof account.default === "boolean" ? { default: account.default } : {}),
    ...(typeof account.exists === "boolean" ? { exists: account.exists } : {}),
  };
}

function redactProvider(provider) {
  if (provider === null || typeof provider !== "object") return provider;
  return {
    ...(typeof provider.id === "string" ? { id: provider.id } : {}),
    ...(typeof provider.name === "string" ? { name: provider.name } : {}),
  };
}

function toManagementError(error) {
  if (error instanceof ManagementOperationError) return error;
  return new ManagementOperationError(
    typeof error?.code === "string" ? error.code : "account_settings_failed",
    error instanceof Error ? error.message : "账户设置操作失败",
    error?.field,
  );
}
