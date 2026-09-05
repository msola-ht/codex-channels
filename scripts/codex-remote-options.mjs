import {
  loadManagedModelProviderDefinitions,
} from "../runtime/model-provider-definitions.mjs";
import { loadConfiguredCustomSwitchingModelProviders } from "../runtime/model-provider-runtime.mjs";
import { isOpencodeGoProviderNamespace } from "../runtime/opencode-go-accounts.mjs";

export const CODEX_REMOTE_USAGE = "用法：codexc remote [--workspace ID] [Codex 参数...]";

export function parseCodexRemoteOptions(
  args,
  {
    environment = process.env,
    managedProfileDefinitions: suppliedManagedProfileDefinitions,
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
    if (codexProfileArgument(args, index)) {
      if (selectedProfile !== undefined) {
        throw new Error("受管模型 Provider --profile 不能与其他 --profile 同时使用");
      }
      hasUnmanagedProfile = true;
    }
    passthrough.push(argument);
  }
  return { passthrough, workspaceId, selectedProfile };
}

function customProviderIdArgument(args, index, definitions) {
  const argument = args[index];
  for (const { providerId, profileName } of definitions) {
    if (
      (argument === "--profile" || argument === "-p")
      && args[index + 1] === providerId
    ) {
      return { providerId, profileName };
    }
    if ([`--profile=${providerId}`, `-p=${providerId}`, `-p${providerId}`].includes(argument)) {
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
  if (argument === "--profile" || argument === "-p") {
    return typeof args[index + 1] === "string" ? { consumed: 2 } : undefined;
  }
  if (argument.startsWith("--profile=") || argument.startsWith("-p=")) {
    return { consumed: 1 };
  }
  if (/^-p[^-]/u.test(argument)) return { consumed: 1 };
  return undefined;
}

function managedProfileArgument(args, index, definitions) {
  const argument = args[index];
  for (const { profileName: profile } of definitions) {
    if (
      (argument === "--profile" || argument === "-p")
      && args[index + 1] === profile
    ) {
      return { profile, consumed: 2 };
    }
    if ([`--profile=${profile}`, `-p=${profile}`, `-p${profile}`].includes(argument)) {
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
      (argument === "--profile" || argument === "-p")
      && args[index + 1] === profileName
    ) {
      return { profileName, canonicalProfileName };
    }
    if (
      [`--profile=${profileName}`, `-p=${profileName}`, `-p${profileName}`]
        .includes(argument)
    ) {
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
  return definition.id === "deepseek" || isOpencodeGoProviderNamespace(definition.id)
    ? definition.id
    : undefined;
}

function reservedManagedProfileArgument(args, index) {
  const argument = args[index];
  let profile;
  if (argument === "--profile" || argument === "-p") {
    profile = args[index + 1];
  } else if (argument.startsWith("--profile=")) {
    profile = argument.slice("--profile=".length);
  } else if (argument.startsWith("-p=")) {
    profile = argument.slice("-p=".length);
  } else if (/^-p[^-]/u.test(argument)) {
    profile = argument.slice(2);
  }
  return profile === "sf-custom"
    || profile?.startsWith("sf-custom-")
    || profile === "sf-opencode-go"
    || profile?.startsWith("sf-opencode-go-")
    || profile === "sf-ocg"
    || profile?.startsWith("sf-ocg-")
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
  if (profile === "sf-opencode-go" || profile.startsWith("sf-opencode-go-")) {
    return `OpenCode Go Profile ${profile} 已废弃；请使用 --profile sf-ocg-<账户>`;
  }
  if (profile === "sf-ocg" || profile.startsWith("sf-ocg-")) {
    return `OpenCode Go Profile ${profile} 尚未配置；请先运行 codexc setup 配置对应账户`;
  }
  return `Codex Profile ${profile} 尚未配置；请先运行 codexc setup 配置对应 Provider`;
}
