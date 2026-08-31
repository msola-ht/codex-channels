import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

export function effectiveCodexBinary(
  configuredBinary,
  environment = process.env,
) {
  const installedBinary = environmentVariable(environment, "CODEX_BINARY")?.trim();
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
  const windows = process.platform === "win32";
  const candidates = (path) => executableCandidates(path, environment, windows);
  if (
    isAbsolute(normalized)
    || normalized.includes("/")
    || (windows && normalized.includes("\\"))
  ) {
    return firstExecutable(candidates(resolve(normalized)));
  }
  const path = environmentVariable(environment, "PATH", windows)?.trim();
  if (!path) {
    return undefined;
  }
  for (const directory of path.split(windows ? ";" : delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = firstExecutable(candidates(join(directory, normalized)));
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

export function executableInvocation(
  executable,
  args = [],
  environment = process.env,
) {
  if (
    process.platform === "win32"
    && [".cjs", ".js", ".mjs"].includes(extname(executable).toLowerCase())
  ) {
    return { file: process.execPath, args: [executable, ...args], windowsVerbatimArguments: false };
  }
  if (
    process.platform !== "win32"
    || ![".bat", ".cmd"].includes(extname(executable).toLowerCase())
  ) {
    return { file: executable, args: [...args], windowsVerbatimArguments: false };
  }
  const directCodex = directCodexShimInvocation(executable, args);
  if (directCodex) return directCodex;
  const commandInterpreter = environmentVariable(
    environment,
    "ComSpec",
    true,
  )?.trim();
  if (!commandInterpreter) {
    throw new Error("Windows 批处理入口需要 ComSpec 指向 cmd.exe");
  }
  const commandLine = [
    escapeWindowsCommand(executable),
    ...args.map((argument) => escapeWindowsArgument(argument)),
  ].join(" ");
  return {
    file: commandInterpreter,
    args: ["/d", "/s", "/v:off", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function directCodexShimInvocation(executable, args) {
  if (process.platform !== "win32" || extname(executable).toLowerCase() !== ".cmd") {
    return undefined;
  }
  const normalized = executable.replace(/\\/gu, "/").toLowerCase();
  if (!normalized.endsWith("/codex.cmd")) return undefined;
  const entry = join(
    executable.slice(0, -"codex.cmd".length),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  if (!existsSync(entry)) return undefined;
  return { file: process.execPath, args: [entry, ...args], windowsVerbatimArguments: false };
}

export function resolveExecutableInvocation(
  command,
  args = [],
  environment = process.env,
) {
  return executableInvocation(
    resolveExecutable(command, environment),
    args,
    environment,
  );
}

function executableCandidates(candidate, environment, windows) {
  if (!windows || extname(candidate)) return [candidate];
  const pathExtensions = (
    environmentVariable(environment, "PATHEXT", true)?.trim()
    || ".COM;.EXE;.BAT;.CMD"
  )
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  return pathExtensions.map((extension) => `${candidate}${extension}`);
}

function environmentVariable(
  environment,
  name,
  windows = process.platform === "win32",
) {
  if (environment[name] !== undefined || !windows) {
    return environment[name];
  }
  const normalizedName = name.toLowerCase();
  const actualName = Object.keys(environment)
    .find((candidate) => candidate.toLowerCase() === normalizedName);
  return actualName === undefined ? undefined : environment[actualName];
}

function firstExecutable(candidates) {
  for (const candidate of candidates) {
    const executable = executablePath(candidate);
    if (executable) return executable;
  }
  return undefined;
}

const windowsCommandMetaCharacterPattern = /([()\][%!^"`<>&|;, *?])/gu;

function escapeWindowsCommand(value) {
  return String(value).replace(windowsCommandMetaCharacterPattern, "^$1");
}

function escapeWindowsArgument(value) {
  let escaped = String(value)
    .replace(/(\\*)"/gu, '$1$1\\"')
    .replace(/(\\*)$/u, "$1$1");
  escaped = `"${escaped}"`;
  return escaped.replace(windowsCommandMetaCharacterPattern, "^$1");
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
