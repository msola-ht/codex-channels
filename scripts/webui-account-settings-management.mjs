import { loadClinePassAccounts, clinePassProviderId, validateClinePassAccountId } from "../runtime/cline-pass-accounts.mjs";
import { previewClinePassConfiguration, applyClinePassConfiguration, previewClinePassRemoval, removeClinePassConfiguration, previewClinePassDefaultAccount, setClinePassDefaultAccount } from "./cline-pass-account-management.mjs";
import {
  applyDeepseekAccountConfiguration,
  previewDeepseekAccountConfiguration,
  removeDeepseekAccount,
  previewDeepseekAccountRemoval,
  setDeepseekDefaultAccount,
  previewDeepseekDefaultAccount,
} from "./deepseek-account-management.mjs";
import { loadDeepseekAccounts, deepseekProviderId, validateDeepseekAccountId } from "../runtime/deepseek-accounts.mjs";
import {
  applyOpencodeGoDefaultAccountChange,
  applyOpencodeGoAccountRemoval,
  applyOpencodeGoAccountStop,
  previewOpencodeGoAccountRemoval,
  previewOpencodeGoAccountStop,
  previewOpencodeGoDefaultAccountChange,
  OpenCodeGoAccountManagementError,
} from "./opencode-go-account-management.mjs";
import {
  applyOpencodeGoAccountConfiguration as applyOpencodeGoAccountProvisioning,
  previewOpencodeGoAccountConfiguration,
  OpenCodeGoAccountProvisioningError,
} from "./opencode-go-account-provisioning.mjs";
import {
  loadOpencodeGoAccounts,
  opencodeGoAccountDisplayName,
  opencodeGoProviderId,
  readOpencodeGoAccountMarker,
} from "../runtime/opencode-go-accounts.mjs";
import { loadManagedModelProviderSettings } from "../runtime/model-provider-runtime.mjs";
import { ManagementOperationError, managementOperationError } from "./webui-management-operations.mjs";
import { AccountManagementError } from "./account-management-error.mjs";
import { loadOllamaCloudAccounts, ollamaCloudProviderId, validateOllamaCloudAccountId } from "../runtime/ollama-cloud-accounts.mjs";
import { loadOllamaCloudModelChoices, previewOllamaCloudConfiguration, applyOllamaCloudConfiguration, previewOllamaCloudDefaultAccount, setOllamaCloudDefaultAccount, previewOllamaCloudRemoval, removeOllamaCloudConfiguration } from "./ollama-cloud-account-management.mjs";

export async function loadAccountSettingsResource(
  environment,
  loadAccounts = loadOpencodeGoAccounts,
  loadProviders = loadManagedModelProviderSettings,
) {
  try {
    const accounts = loadAccounts(environment);
    const providers = loadProviders(environment);
    const clineAccounts = loadClinePassAccounts(environment);
    const dsAccounts = loadDeepseekAccounts(environment);
    const olcAccounts = loadOllamaCloudAccounts(environment);
    return {
      opencodeGo: {
        configured: accounts.length > 0,
        defaultAccountId: accounts.find((account) => account.default)?.id ?? null,
        accounts: accounts.map((account) => {
          const marker = readOpencodeGoAccountMarker(environment, account.id);
          const providerId = opencodeGoProviderId(account.id);
          const provider = providers.find((entry) => entry.provider === providerId);
          return {
            id: account.id,
            provider: providerId,
            displayName: opencodeGoAccountDisplayName(account),
            ...(account.email === undefined ? {} : { email: account.email }),
            ...(account.phone === undefined ? {} : { phone: account.phone }),
            ...(marker?.mode === undefined ? {} : { mode: marker.mode }),
            model: provider?.model ?? null,
            default: account.default === true,
          };
        }),
      },
      clinePass: {
        configured: clineAccounts.length > 0,
        accounts: clineAccounts.map(account => {
          const providerId = clinePassProviderId(account.id);
          const provider = providers.find(entry => entry.provider === providerId);
          return { ...account, provider: providerId, mode: provider?.mode ?? null, model: provider?.model ?? null };
        }),
      },
      deepseek: {
        configured: dsAccounts.length > 0,
        accounts: dsAccounts.map((account) => {
          const providerId = deepseekProviderId(account.id);
          const provider = providers.find((entry) => entry.provider === providerId);
          return { ...account, provider: providerId, mode: provider?.mode ?? null, model: provider?.model ?? null };
        }),
      },
      ollamaCloud: {
        configured: olcAccounts.length > 0,
        ...loadOllamaCloudModelChoices(environment),
        accounts: olcAccounts.map(account => {
          const providerId = ollamaCloudProviderId(account.id);
          const provider = providers.find(entry => entry.provider === providerId);
          return { ...account, provider: providerId, mode: provider?.mode ?? null, model: provider?.model ?? null };
        }),
      },
    };
  } catch {
    throw new ManagementOperationError("account_state_unavailable", "账户设置暂不可用");
  }
}

export function normalizeAccountSettingsMutation(input) {
  const normalized = accountSettingsMutation(input);
  if (Object.keys(input).some(key => key !== "confirmationToken" && !Object.hasOwn(normalized, key))) {
    throw new ManagementOperationError("invalid_account_operation", "账户设置请求包含不支持的字段");
  }
  return normalized;
}

function accountSettingsMutation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ManagementOperationError("invalid_json", "账户设置操作正文必须是对象");
  }
  switch (input.operation) {
    case "olc.configure":
      return {
        operation: input.operation,
        accountId: managementAccountId(input.accountId, validateOllamaCloudAccountId),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.initialModel === undefined ? {} : { initialModel: input.initialModel }),
        ...(input.reconfigure === undefined ? {} : { reconfigure: input.reconfigure }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        ...(input.confirmExclusiveConfigChange === undefined ? {} : { confirmExclusiveConfigChange: input.confirmExclusiveConfigChange }),
      };
    case "olc.default":
    case "olc.remove":
      return { operation: input.operation, accountId: managementAccountId(input.accountId, validateOllamaCloudAccountId) };
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
    case "clp.configure":
    case "deepseek.configure":
      return {
        operation: input.operation,
        accountId: managementAccountId(input.accountId, input.operation === "clp.configure" ? validateClinePassAccountId : validateDeepseekAccountId),
        ...(input.reconfigure === undefined ? {} : { reconfigure: input.reconfigure }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        ...(input.confirmExclusiveConfigChange === undefined
          ? {}
          : { confirmExclusiveConfigChange: input.confirmExclusiveConfigChange }),
      };
    case "clp.default":
    case "clp.remove":
    case "deepseek.default":
    case "deepseek.remove":
      return { operation: input.operation, accountId: managementAccountId(input.accountId, input.operation.startsWith("clp.") ? validateClinePassAccountId : validateDeepseekAccountId) };
    default:
      throw new ManagementOperationError("invalid_account_operation", "账户设置操作不受支持");
  }
}

function managementAccountId(value, validate) {
  try {
    return validate(value);
  } catch {
    throw new ManagementOperationError("invalid-account-id", "账户 ID 格式无效，请使用 1–32 位小写字母、数字、- 或 _", "accountId");
  }
}

export async function previewAccountSettingsMutation(input, environment, options = {}) {
  try {
    switch (input.operation) {
      case "olc.configure":
        return await previewOllamaCloudConfiguration(input, { ...options, environment });
      case "olc.default":
        return previewOllamaCloudDefaultAccount(input.accountId, { environment });
      case "olc.remove":
        return await previewOllamaCloudRemoval(input.accountId, { ...options, environment });
      case "opencode.account.configure":
        return await previewOpencodeGoAccountConfiguration(input, { environment });
      case "opencode.account.default":
        return previewOpencodeGoDefaultAccountChange(input.accountId, { environment });
      case "opencode.account.stop":
        return await previewOpencodeGoAccountStop(input.accountId, { environment });
      case "opencode.account.remove":
        return await previewOpencodeGoAccountRemoval(input.accountId, { environment });
      case "clp.configure":
        return previewClinePassConfiguration(input, { environment });
      case "clp.default":
        return previewClinePassDefaultAccount(input.accountId, { environment });
      case "clp.remove":
        return await previewClinePassRemoval(input.accountId, { environment });
      case "deepseek.configure":
        return previewDeepseekAccountConfiguration(input, { environment });
      case "deepseek.remove":
        return await previewDeepseekAccountRemoval(input.accountId, { environment });
      case "deepseek.default": {
        return { ...previewDeepseekDefaultAccount(input.accountId, { environment }), operation: input.operation };
      }
      default:
        throw new ManagementOperationError("invalid_account_operation", "账户设置操作不受支持");
    }
  } catch (error) {
    throw toManagementError(error);
  }
}

export async function applyAccountSettingsMutation(input, environment, confirmedPreview, options = {}) {
  try {
    switch (input.operation) {
      case "olc.configure":
        return await applyOllamaCloudConfiguration(accountSettingsApplyInput(input, confirmedPreview), { ...options, environment });
      case "olc.default":
        return await setOllamaCloudDefaultAccount(input.accountId, { environment, signal: options.signal, expectedRevision: confirmedPreview?.revision });
      case "olc.remove":
        return await removeOllamaCloudConfiguration(accountSettingsApplyInput(input, confirmedPreview), { ...options, environment });
      case "opencode.account.configure":
        return await applyOpencodeGoAccountProvisioning(accountSettingsApplyInput(input, confirmedPreview), { environment });
      case "opencode.account.default":
        return await applyOpencodeGoDefaultAccountChange(input.accountId, { environment, expectedRevision: confirmedPreview?.revision });
      case "opencode.account.stop":
        return await applyOpencodeGoAccountStop(input.accountId, { environment });
      case "opencode.account.remove":
        return await applyOpencodeGoAccountRemoval(accountSettingsApplyInput(input, confirmedPreview), { environment });
      case "clp.configure":
        return await applyClinePassConfiguration(accountSettingsApplyInput(input, confirmedPreview), { environment });
      case "clp.default":
        return await setClinePassDefaultAccount(input.accountId, { environment, expectedRevision: confirmedPreview?.revision });
      case "clp.remove":
        return await removeClinePassConfiguration(accountSettingsApplyInput(input, confirmedPreview), { environment });
      case "deepseek.configure":
        return await applyDeepseekAccountConfiguration(accountSettingsApplyInput(input, confirmedPreview), { environment });
      case "deepseek.default":
        return await setDeepseekDefaultAccount(input.accountId, { environment, expectedRevision: confirmedPreview?.revision });
      case "deepseek.remove":
        return await removeDeepseekAccount(accountSettingsApplyInput(input, confirmedPreview), { environment });
      default:
        throw new ManagementOperationError("invalid_account_operation", "账户设置操作不受支持");
    }
  } catch (error) {
    throw toManagementError(error);
  }
}

export function accountSettingsApplyInput(input, confirmedPreview) {
  switch (input.operation) {
    case "olc.configure":
    case "opencode.account.configure":
    case "clp.configure":
    case "deepseek.configure":
      return { ...input,
        ...(confirmedPreview?.revision === undefined ? {} : { expectedRevision: confirmedPreview.revision }),
        ...(confirmedPreview?.effects?.writesMainConfig === true ? { confirmExclusiveConfigChange: true } : {}),
      };
    case "opencode.account.remove":
      return { ...input, confirmHistoryLoss: true, expectedRevision: confirmedPreview?.revision };
    case "clp.remove":
    case "olc.remove":
    case "deepseek.remove":
      return { ...input, confirmRemove: true, expectedRevision: confirmedPreview?.revision };
    default:
      return input;
  }
}

export function redactAccountSettingsResult(result) {
  if (!result || typeof result !== "object") return { action: "completed" };
  return {
    ...(typeof result.action === "string" ? { action: result.action } : {}),
    ...(typeof result.revision === "string" ? { revision: result.revision } : {}),
    ...(typeof result.operation === "string" ? { operation: result.operation } : {}),
    ...(result.account !== undefined ? { account: redactAccount(result.account) } : {}),
    ...(result.provider !== undefined ? { provider: redactProvider(result.provider) } : {}),
    ...(result.mode !== undefined ? { mode: result.mode } : {}),
    ...(["switching", "exclusive"].includes(result.previousMode) ? { previousMode: result.previousMode } : {}),
    ...(["preserve", "replace"].includes(result.credentialAction) ? { credentialAction: result.credentialAction } : {}),
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(result.initialModel !== undefined ? { initialModel: result.initialModel } : {}),
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
  if (error instanceof AccountManagementError && ["authentication-rate-limited", "authentication-timeout", "authentication-unavailable"].includes(error.code)) {
    return new ManagementOperationError(error.code, "Ollama Cloud 账户认证暂不可用，未保存账户", error.field,
      error.code === "authentication-rate-limited" ? 429 : error.code === "authentication-timeout" ? 504 : 503);
  }
  return managementOperationError(error, [OpenCodeGoAccountManagementError, OpenCodeGoAccountProvisioningError, AccountManagementError], "account_settings_failed");
}
