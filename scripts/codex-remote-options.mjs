import {
  loadManagedModelProviderDefinitions,
} from "../runtime/model-provider-definitions.mjs";
import {
  loadConfiguredCustomSwitchingModelProviders,
} from "../runtime/model-provider-runtime.mjs";
import { isOpencodeGoProviderNamespace } from "../runtime/opencode-go-accounts.mjs";
import { resolveProviderSelection } from "./provider-selection.mjs";

export const CODEX_REMOTE_USAGE = "用法：codexc remote [--workspace ID] [-p Provider-ID | --provider Provider-ID | --profile Profile] [Codex 参数...]\n-p / --provider 接受完整 Provider ID、已配置的规范 sf- 名称，以及 agg / sf-agg；省略时连接主实例。个人 Profile 使用 --profile。";

export function parseCodexRemoteOptions(
  args,
  {
    environment = process.env,
    managedProfileDefinitions: suppliedManagedProfileDefinitions,
    primaryProvider,
    customPrimaryProvider,
    customSwitchingProfiles = loadConfiguredCustomSwitchingModelProviders(environment)
      .map(({ provider, profileName }) => ({
        providerId: provider,
        profileName,
      })),
  } = {},
) {
  const configuredManagedProfileDefinitions = suppliedManagedProfileDefinitions
    ?? loadManagedModelProviderDefinitions(environment);
  const managedProfileDefinitions = [
    ...customSwitchingProfiles,
    ...configuredManagedProfileDefinitions,
  ];
  assertManagedProfileDefinitions(managedProfileDefinitions);
  const passthrough = [];
  let workspaceId;
  let selectedProfile;
  let selectedProvider;
  let hasUnmanagedProfile = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      passthrough.push(...args.slice(index));
      break;
    }
    if (argument === "--workspace") {
      if (workspaceId !== undefined) throw new Error("只能指定一个 --workspace");
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error(CODEX_REMOTE_USAGE);
      workspaceId = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--workspace=")) {
      throw new Error(CODEX_REMOTE_USAGE);
    }
    if (argument === "--provider" || argument === "-p") {
      if (selectedProvider !== undefined) throw new Error("只能指定一个 --provider");
      if (selectedProfile !== undefined || hasUnmanagedProfile) {
        throw new Error("--provider 不能与 --profile 同时使用");
      }
      const selection = resolveProviderSelection(args[index + 1], {
        environment, primaryProvider, customPrimaryProvider,
        managedProfileDefinitions: configuredManagedProfileDefinitions,
        customSwitchingProfiles,
      });
      selectedProvider = selection.provider;
      selectedProfile = selection.profileName;
      index += 1;
      continue;
    }
    if (argument.startsWith("--provider=") || /^-p./u.test(argument)) throw new Error(CODEX_REMOTE_USAGE);
    const profile = codexProfileArgument(args, index);
    if (profile && selectedProvider !== undefined) {
      throw new Error("--provider 不能与 --profile 同时使用");
    }
    const profileArgument = managedProfileArgument(args, index, managedProfileDefinitions);
    if (profileArgument) {
      if (selectedProfile !== undefined || hasUnmanagedProfile) {
        throw new Error("受管模型 Provider --profile 不能与其他 --profile 同时使用");
      }
      selectedProfile = profileArgument.profile;
      index += profileArgument.consumed - 1;
      continue;
    }
    const oldProfile = oldManagedProfileArgument(
      args,
      index,
      managedProfileDefinitions,
    );
    if (oldProfile) {
      throw new Error(
        `Profile ${oldProfile.profileName} 不是该 Provider 的规范名称；`
        + `请使用 --profile ${oldProfile.canonicalProfileName}`,
      );
    }
    const customProviderId = customProviderIdArgument(args, index, customSwitchingProfiles);
    if (customProviderId) {
      throw new Error(
        `${customProviderId.providerId} 是 Provider ID；`
        + `请使用 --profile ${customProviderId.profileName}`,
      );
    }
    const reservedProfile = reservedManagedProfileArgument(args, index);
    if (reservedProfile) {
      throw new Error(reservedManagedProfileMessage(reservedProfile));
    }
    if (profile) {
      if (selectedProfile !== undefined) {
        throw new Error("受管模型 Provider --profile 不能与其他 --profile 同时使用");
      }
      if (hasUnmanagedProfile) throw new Error("只能指定一个 --profile");
      hasUnmanagedProfile = true;
      passthrough.push(...args.slice(index, index + profile.consumed));
      index += profile.consumed - 1;
      continue;
    }
    passthrough.push(argument);
  }
  return { passthrough, workspaceId, selectedProfile, selectedProvider };
}

function customProviderIdArgument(args, index, definitions) {
  const argument = args[index];
  for (const { providerId, profileName } of definitions) {
    if (
      argument === "--profile"
      && args[index + 1] === providerId
    ) {
      return { providerId, profileName };
    }
    if (argument === `--profile=${providerId}`) {
      return { providerId, profileName };
    }
  }
  return undefined;
}

function assertManagedProfileDefinitions(definitions) {
  const names = new Set();
  for (const { profileName } of definitions) {
    if (
      typeof profileName !== "string"
      || profileName.trim() === ""
      || !profileName.startsWith("sf-")
      || names.has(profileName)
    ) {
      throw new Error("受管模型 Provider Profile 定义无效或冲突");
    }
    names.add(profileName);
  }
}

function codexProfileArgument(args, index) {
  const argument = args[index];
  if (argument === "--profile") {
    if (!args[index + 1] || args[index + 1].startsWith("-")) throw new Error(CODEX_REMOTE_USAGE);
    return { consumed: 2 };
  }
  if (argument.startsWith("--profile=")) {
    if (argument.endsWith("=")) throw new Error(CODEX_REMOTE_USAGE);
    return { consumed: 1 };
  }
  return undefined;
}

function managedProfileArgument(args, index, definitions) {
  const argument = args[index];
  for (const { profileName: profile } of definitions) {
    if (
      argument === "--profile"
      && args[index + 1] === profile
    ) {
      return { profile, consumed: 2 };
    }
    if (argument === `--profile=${profile}`) {
      return { profile, consumed: 1 };
    }
  }
  return undefined;
}

function oldManagedProfileArgument(args, index, definitions) {
  const argument = args[index];
  for (const definition of definitions) {
    const canonicalProfileName = definition.profileName;
    const profileName = nonCanonicalManagedProfileName(definition);
    if (
      typeof profileName !== "string"
      || profileName === canonicalProfileName
    ) {
      continue;
    }
    if (
      argument === "--profile"
      && args[index + 1] === profileName
    ) {
      return { profileName, canonicalProfileName };
    }
    if (argument === `--profile=${profileName}`) {
      return { profileName, canonicalProfileName };
    }
  }
  return undefined;
}

function nonCanonicalManagedProfileName(definition) {
  if (typeof definition.providerId === "string") {
    return `custom-${definition.providerId}`;
  }
  if (definition.storageId === "opencode-go") {
    return definition.accountId === undefined
      ? "opencode-go"
      : `opencode-go-${definition.accountId}`;
  }
  return ["deepseek", "ccg"].includes(definition.storageId)
    || isOpencodeGoProviderNamespace(definition.id)
    ? definition.id
    : undefined;
}

function reservedManagedProfileArgument(args, index) {
  const argument = args[index];
  let profile;
  if (argument === "--profile") {
    profile = args[index + 1];
  } else if (argument.startsWith("--profile=")) {
    profile = argument.slice("--profile=".length);

  }
  return profile === "sf-custom"
    || profile?.startsWith("sf-ds-")
    || profile?.startsWith("sf-custom-")
    || profile === "sf-ocg"
    || profile?.startsWith("sf-ocg-")
    || profile === "sf-clp"
    || profile?.startsWith("sf-clp-")
    || profile?.startsWith("sf-ccg-")
    ? profile
    : undefined;
}

function reservedManagedProfileMessage(profile) {
  if (profile === "sf-custom") {
    return "Codex Profile sf-custom 是内部保留名称；固定模式请直接使用 codexc remote";
  }
  if (profile.startsWith("sf-custom-")) {
    return `Codex Profile ${profile} 尚未配置；请先运行 codexc setup 配置对应 Provider`;
  }
  if (profile === "sf-ocg" || profile.startsWith("sf-ocg-")) {
    return `OpenCode Go Profile ${profile} 尚未配置；请先运行 codexc setup 配置对应账户`;
  }
  if (profile.startsWith("sf-ccg-")) {
    return `CCG Profile ${profile} 尚未配置；请先运行 codexc setup 配置对应账户`;
  }
  return `Codex Profile ${profile} 尚未配置；请先运行 codexc setup 配置对应 Provider`;
}
