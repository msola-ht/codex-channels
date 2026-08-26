import {
  loadManagedModelProviderDefinitions,
  opencodeGoProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import { loadConfiguredCustomSwitchingModelProviders } from "../runtime/model-provider-runtime.mjs";

export const CODEX_REMOTE_USAGE = "用法：codexc remote [--workspace ID] [Codex 参数...]";

export function parseCodexRemoteOptions(
  args,
  {
    customSwitchingProfiles = loadConfiguredCustomSwitchingModelProviders(process.env)
      .map(({ profileName, codexProfileName }) => ({ profileName, codexProfileName })),
  } = {},
) {
  const configuredManagedProfileDefinitions = loadManagedModelProviderDefinitions(process.env);
  const managedProfileDefinitions = [
    ...customSwitchingProfiles,
    ...configuredManagedProfileDefinitions,
    ...(configuredManagedProfileDefinitions.some(
      ({ profileName }) => profileName === opencodeGoProviderDefinition.profileName,
    )
      ? []
      : [opencodeGoProviderDefinition]),
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
    const internalProfile = internalProfileArgument(
      args,
      index,
      managedProfileDefinitions,
    );
    if (internalProfile) {
      throw new Error(
        `Codex Profile ${internalProfile.codexProfileName} 是内部名称；`
        + `请使用 --profile ${internalProfile.profileName}`,
      );
    }
    const reservedCustomProfile = reservedCustomInternalProfileArgument(args, index);
    if (reservedCustomProfile) {
      const provider = reservedCustomProfile.slice("sf-custom-".length);
      throw new Error(reservedCustomProfile === "sf-custom"
        ? "Codex Profile sf-custom 是内部保留名称；固定模式请直接使用 codexc remote"
        : `Codex Profile ${reservedCustomProfile} 是内部保留名称；`
          + `请先运行 codexc setup 配置对应 Provider，再使用 --profile custom-${provider}`);
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

function assertManagedProfileDefinitions(definitions) {
  const names = new Set();
  for (const { profileName, codexProfileName } of definitions) {
    if (
      typeof profileName !== "string"
      || profileName.trim() === ""
      || typeof codexProfileName !== "string"
      || codexProfileName.trim() === ""
      || profileName === codexProfileName
      || names.has(profileName)
      || names.has(codexProfileName)
    ) {
      throw new Error("受管模型 Provider Profile 定义无效或冲突");
    }
    names.add(profileName);
    names.add(codexProfileName);
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

function internalProfileArgument(args, index, definitions) {
  const argument = args[index];
  for (const { profileName, codexProfileName } of definitions) {
    if (
      (argument === "--profile" || argument === "-p")
      && args[index + 1] === codexProfileName
    ) {
      return { profileName, codexProfileName };
    }
    if (
      [`--profile=${codexProfileName}`, `-p=${codexProfileName}`, `-p${codexProfileName}`]
        .includes(argument)
    ) {
      return { profileName, codexProfileName };
    }
  }
  return undefined;
}

function reservedCustomInternalProfileArgument(args, index) {
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
  return profile === "sf-custom" || profile?.startsWith("sf-custom-")
    ? profile
    : undefined;
}
