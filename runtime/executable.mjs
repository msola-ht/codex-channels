import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export function effectiveCodexBinary(
  configuredBinary,
  environment = process.env,
) {
  const installedBinary = environment.CODEX_BINARY?.trim();
  return configuredBinary === "codex" && installedBinary
    ? installedBinary
    : configuredBinary;
}

export function resolveExecutable(command, environment = process.env) {
  const executable = resolveOptionalExecutable(command, environment);
  if (!executable) {
    throw new Error(`找不到可执行文件：${command}`);
  }
  return executable;
}

export function resolveOptionalExecutable(command, environment = process.env) {
  const normalized = typeof command === "string" ? command.trim() : "";
  if (!normalized) {
    return undefined;
  }
  if (isAbsolute(normalized) || normalized.includes("/")) {
    return executablePath(resolve(normalized));
  }
  const path = environment.PATH?.trim();
  if (!path) {
    return undefined;
  }
  for (const directory of path.split(delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = executablePath(join(directory, normalized));
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function executablePath(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    if (!statSync(candidate).isFile()) {
      return undefined;
    }
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}
