import { deepseekProviderDefinition } from "../runtime/model-provider-definitions.mjs";

export const CODEX_REMOTE_USAGE = "用法：codexc remote [--workspace ID] [Codex 参数...]";

export function parseCodexRemoteOptions(args) {
  const passthrough = [];
  let workspaceId;
  let selectedProfile;
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
    const consumed = deepseekProfileArgumentLength(args, index);
    if (consumed > 0) {
      if (selectedProfile !== undefined) {
        throw new Error("只能指定一个 DeepSeek --profile");
      }
      selectedProfile = deepseekProviderDefinition.profileName;
      index += consumed - 1;
      continue;
    }
    passthrough.push(argument);
  }
  return { passthrough, workspaceId, selectedProfile };
}

function deepseekProfileArgumentLength(args, index) {
  const argument = args[index];
  const profile = deepseekProviderDefinition.profileName;
  if (
    (argument === "--profile" || argument === "-p")
    && args[index + 1] === profile
  ) {
    return 2;
  }
  return [
    `--profile=${profile}`,
    `-p=${profile}`,
    `-p${profile}`,
  ].includes(argument) ? 1 : 0;
}
