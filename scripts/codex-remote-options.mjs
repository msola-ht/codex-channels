import { managedModelProviderDefinitions } from "../runtime/model-provider-definitions.mjs";

export const CODEX_REMOTE_USAGE = "用法：codexc remote [--workspace ID] [Codex 参数...]";

export function parseCodexRemoteOptions(args) {
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
    const profileArgument = managedProfileArgument(args, index);
    if (profileArgument) {
      if (selectedProfile !== undefined || hasUnmanagedProfile) {
        throw new Error("受管模型 Provider --profile 不能与其他 --profile 同时使用");
      }
      selectedProfile = profileArgument.profile;
      index += profileArgument.consumed - 1;
      continue;
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

function managedProfileArgument(args, index) {
  const argument = args[index];
  for (const { profileName: profile } of managedModelProviderDefinitions) {
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
