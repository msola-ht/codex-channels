import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  chmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveExecutableInvocation } from "./executable.mjs";
import { codexHomePath } from "./codex-home.mjs";
import { invokeWindowsAcl, invokeWindowsAclSync } from "./windows-acl-bridge.mjs";

const defaultMaximumPrivateFileBytes = 1_048_576;

export class WindowsPrivatePathError extends Error {
  constructor(message) {
    super(message);
    this.name = "WindowsPrivatePathError";
  }
}

/** Read current configuration without repairing permissions or caching ACL results. */
export async function readPrivateConfigFile(path, { signal, maximumBytes = defaultMaximumPrivateFileBytes } = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 2_097_152) {
    throw new Error("私有配置读取上限无效");
  }
  signal?.throwIfAborted();
  if (process.platform === "win32") {
    const metadata = await lstat(path);
    signal?.throwIfAborted();
    if (metadata.isSymbolicLink()) throw new Error("私有路径不能是符号链接");
    const invocation = windowsPrivatePathInvocation();
    let result;
    try {
      result = await invokeWindowsAcl(invocation, { operation: "read-config", kind: "file", path, maximumBytes }, 1024 + 8 * maximumBytes, signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw windowsPrivatePathProcessError(error, error.code, "", path, "file", "read-config");
    }
    signal?.throwIfAborted();
    let response;
    try { response = JSON.parse(result); } catch { throw new Error("Windows 私有配置读取结果无效"); }
    if (response?.ok === false) throw windowsPrivatePathProcessError(undefined, 1, result, path, "file", "read-config");
    if (response?.ok !== true || typeof response.content !== "string"
      || Buffer.byteLength(response.content, "utf8") > maximumBytes) {
      throw new Error("Windows 私有配置读取结果无效");
    }
    return response.content;
  }
  const validateParent = async () => {
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || (parent.mode & 0o022) !== 0
      || (process.getuid !== undefined && parent.uid !== process.getuid())) {
      throw new Error("config.toml 父目录权限或类型无效");
    }
    return parent;
  };
  const parent = await validateParent();
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await descriptor.stat();
    if (!before.isFile() || before.size > maximumBytes
      || (before.mode & 0o077) !== 0
      || (process.getuid !== undefined && before.uid !== process.getuid())) {
      throw new Error("私有配置权限、类型或大小无效");
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await descriptor.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximumBytes) throw new Error("私有配置超过读取上限");
    const content = buffer.subarray(0, length).toString("utf8");
    const after = await descriptor.stat();
    const current = await lstat(path);
    const currentParent = await validateParent();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
      || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino
      || Buffer.byteLength(content, "utf8") > maximumBytes) {
      throw new Error("私有配置在读取期间发生变化");
    }
    signal?.throwIfAborted();
    return content;
  } finally {
    await descriptor.close();
  }
}

export function readPrivateFileSync(
  path,
  maximumBytes = defaultMaximumPrivateFileBytes,
) {
  validateSyncReadLimit(maximumBytes);
  if (process.platform === "win32") {
    return readWindowsFileSync(path, "file", maximumBytes);
  }
  return readUnixFileSync(path, maximumBytes, false);
}

function validateSyncReadLimit(maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 16_777_216) {
    throw new Error("私有配置读取上限无效");
  }
}

function readUnixFileSync(path, maximumBytes, sharedConfig) {
  // Only the main Codex config follows its documented shared/symlink contract.
  const openedPath = sharedConfig ? realpathSync(path) : path;
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(openedPath, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  const validate = metadata => {
    if (!metadata.isFile() || metadata.size > maximumBytes
      || (!sharedConfig && (metadata.mode & 0o077) !== 0)
      || (process.getuid !== undefined && metadata.uid !== process.getuid())) {
      throw new Error("私有文件权限、类型或大小无效");
    }
  };
  try {
    const before = fstatSync(descriptor);
    validate(before);
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximumBytes) throw new Error("私有文件超过读取上限");
    const after = fstatSync(descriptor);
    validate(after);
    const current = lstatSync(openedPath);
    validate(current);
    const content = buffer.subarray(0, length).toString("utf8");
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.dev !== before.dev || current.ino !== before.ino
      || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs
      || (sharedConfig && realpathSync(path) !== openedPath)
      || Buffer.byteLength(content, "utf8") > maximumBytes) {
      throw new Error("私有文件在读取期间发生变化");
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

/** Upstream config is shared with Codex's sandbox: validate integrity, not secrecy. */
export function readCodexConfigFileSync(path, maximumBytes = defaultMaximumPrivateFileBytes) {
  validateSyncReadLimit(maximumBytes);
  if (process.platform !== "win32") return readUnixFileSync(path, maximumBytes, true);
  return readWindowsFileSync(path, "codex-config", maximumBytes);
}

function readWindowsFileSync(path, kind, maximumBytes) {
  // Preserve ENOENT for optional-file callers before invoking the ACL adapter.
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error("私有路径不能是符号链接");
  let result;
  try {
    result = invokeWindowsAclSync(windowsPrivatePathInvocation(),
      { operation: "read-config", kind, path, maximumBytes }, 1024 + 8 * maximumBytes);
  } catch (error) {
    throw windowsPrivatePathProcessError(error, error.code, "", path, kind, "read-config");
  }
  let response;
  try { response = JSON.parse(result); } catch { throw new WindowsPrivatePathError("Windows 私有配置读取结果无效"); }
  if (response?.ok === false) throw windowsPrivatePathProcessError(undefined, 1, result, path, kind, "read-config");
  if (response?.ok !== true || typeof response.content !== "string" || Buffer.byteLength(response.content, "utf8") > maximumBytes) {
    throw new WindowsPrivatePathError("Windows 私有配置读取结果无效");
  }
  return response.content;
}

export function assertCodexConfigAccessSync(path) {
  if (process.platform === "win32") assertWindowsPrivatePathSync(path, "codex-config");
}

export function writePrivateFileAtomicSync(path, content) {
  const parent = dirname(path);
  let parentExisted = true;
  try { lstatSync(parent); } catch (error) { if (error.code !== "ENOENT") throw error; parentExisted = false; }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  let staging;
  if (process.platform === "win32") {
    if (parentExisted) assertWindowsPrivatePathSync(parent, "parent-directory");
    else securePrivateDirectorySync(parent);
    // Protect an empty staging directory before writing any bytes. Do not strip
    // sandbox read ACLs from shared parents such as Codex Home.
    staging = mkdtempSync(join(parent, ".codexc-write-"));
  }
  const temporaryPath = staging ? join(staging, "content") : privateTemporaryPath(path);
  try {
    if (staging) securePrivateDirectorySync(staging);
    writeFileSync(temporaryPath, content, { mode: 0o600, flag: "wx" });
    securePrivateFileSync(temporaryPath);
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  } finally {
    if (staging) rmdirSync(staging);
  }
}

export async function writePrivateFileAtomic(path, content, options = {}) {
  return writeFileAtomic(path, content, false, options);
}

export async function writeCodexConfigFileAtomic(path, content, options = {}) {
  return writeFileAtomic(path, content, true, options);
}

async function writeFileAtomic(path, content, sharedConfig, { signal }) {
  signal?.throwIfAborted();
  const parent = dirname(path);
  let parentExisted = true;
  try { await lstat(parent); } catch (error) { if (error.code !== "ENOENT") throw error; parentExisted = false; }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  let staging;
  if (process.platform === "win32") {
    if (parentExisted) await assertWindowsPrivatePath(parent, "parent-directory", "verify", {}, signal);
    else await securePrivateDirectory(parent, { signal });
    staging = await mkdtemp(join(parent, ".codexc-write-"));
  }
  const sharedWindows = process.platform === "win32" && sharedConfig;
  // ReplaceFile merges inherited ACLs at the replacement's current parent.
  // Keep shared replacements beside the destination, private before any content.
  const temporaryPath = staging && !sharedWindows ? join(staging, "content") : privateTemporaryPath(path);
  let retainStaging = false;
  try {
    signal?.throwIfAborted();
    if (staging) await securePrivateDirectory(staging, { signal });
    if (sharedWindows) {
      await writeFile(temporaryPath, "", { flag: "wx" });
      await securePrivateFile(temporaryPath, { signal });
      await writeFile(temporaryPath, content, { flag: "r+", signal });
    } else await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx", signal });
    await securePrivateFile(temporaryPath, { signal });
    signal?.throwIfAborted();
    if (process.platform === "win32" && sharedConfig) {
      retainStaging = true;
      await assertWindowsPrivatePath(temporaryPath, "codex-config", "replace-config", {
        destination: resolve(path), recoveryDirectory: resolve(staging),
      }, signal);
      retainStaging = false;
    } else await rename(temporaryPath, path);
  } catch (error) {
    if (retainStaging) {
      throw new WindowsPrivatePathError(`共享配置替换未确认，保留恢复目录 ${staging}；尚存的新内容可能位于 ${temporaryPath} 或 ${temporaryPath}.replacement；${error.message}`);
    }
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    if (staging && !retainStaging) await rmdir(staging);
  }
}

/** Explicit user repair only; normal readers/writers must never reclaim ownership. */
export function repairWindowsPrivateFileSync(path) {
  if (process.platform !== "win32") throw new Error("定向 ACL 修复只支持 Windows");
  assertWindowsPrivatePathSync(path, "file", "repair");
}

export function securePrivateFileSync(path) {
  if (process.platform === "win32") {
    assertWindowsPrivatePathSync(path, "file", "secure");
    return;
  }
  chmodSync(path, 0o600);
}

export function securePrivateDirectorySync(path) {
  if (process.platform === "win32") {
    assertWindowsPrivatePathSync(path, "directory", "secure");
    return;
  }
  chmodSync(path, 0o700);
}

export async function securePrivateFile(path, { signal } = {}) {
  signal?.throwIfAborted();
  if (process.platform === "win32") await assertWindowsPrivatePath(path, "file", "secure", {}, signal);
  else await secureUnixPrivatePath(path, false, signal);
  signal?.throwIfAborted();
}

export async function securePrivateDirectory(path, { signal } = {}) {
  signal?.throwIfAborted();
  if (process.platform === "win32") await assertWindowsPrivatePath(path, "directory", "secure", {}, signal);
  else await secureUnixPrivatePath(path, true, signal);
  signal?.throwIfAborted();
}

async function secureUnixPrivatePath(path, directory, signal) {
  const validate = metadata => {
    if (metadata.isSymbolicLink() || !(directory ? metadata.isDirectory() : metadata.isFile())
      || (process.getuid !== undefined && metadata.uid !== process.getuid())) {
      throw new Error("私有路径类型或所有者无效");
    }
  };
  const before = await lstat(path);
  validate(before);
  signal?.throwIfAborted();
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await descriptor.stat();
    validate(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("私有路径在保护期间发生变化");
    signal?.throwIfAborted();
    await descriptor.chmod(directory ? 0o700 : 0o600);
    const current = await lstat(path);
    validate(current);
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("私有路径在保护期间发生变化");
  } finally { await descriptor.close(); }
}

export async function assertPrivateDirectoryAccess(path, { signal } = {}) {
  signal?.throwIfAborted();
  if (process.platform === "win32") await assertWindowsPrivatePath(path, "directory", "verify", {}, signal);
  signal?.throwIfAborted();
}

function validatePrivateDirectory(metadata) {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || (process.platform !== "win32" && ((metadata.mode & 0o077) !== 0
      || (process.getuid !== undefined && metadata.uid !== process.getuid())))) {
    throw new Error("私有目录权限、类型或所有者无效");
  }
}

function directoryIdentity(before, opened, current) {
  for (const metadata of [before, opened, current]) validatePrivateDirectory(metadata);
  if (before.dev !== opened.dev || before.ino !== opened.ino
    || current.dev !== opened.dev || current.ino !== opened.ino) {
    throw new Error("私有目录在校验期间发生变化");
  }
  return { dev: opened.dev, ino: opened.ino };
}

/** Inspect existing resources without creating directories or repairing permissions. */
export async function inspectPrivateDirectoryAccess(path, { signal } = {}) {
  signal?.throwIfAborted();
  const before = await lstat(path);
  signal?.throwIfAborted();
  validatePrivateDirectory(before);
  if (process.platform === "win32") {
    await assertWindowsPrivatePath(path, "directory", "verify", {}, signal);
    const current = await lstat(path);
    signal?.throwIfAborted();
    return directoryIdentity(before, current, current);
  }
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NONBLOCK
    | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
  let identity;
  try {
    const opened = await descriptor.stat();
    const current = await lstat(path);
    identity = directoryIdentity(before, opened, current);
    signal?.throwIfAborted();
  } finally { await descriptor.close(); }
  signal?.throwIfAborted();
  return identity;
}

export function inspectPrivateDirectoryAccessSync(path) {
  const before = lstatSync(path);
  validatePrivateDirectory(before);
  if (process.platform === "win32") {
    assertWindowsPrivatePathSync(path, "directory");
    const current = lstatSync(path);
    return directoryIdentity(before, current, current);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK
    | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
  try {
    return directoryIdentity(before, fstatSync(descriptor), lstatSync(path));
  } finally { closeSync(descriptor); }
}

/** Create or protect a directory only after checking its type and ownership. */
export function ensurePrivateDirectorySync(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || (process.platform !== "win32" && process.getuid !== undefined && metadata.uid !== process.getuid())) {
    throw new Error("私有目录类型或所有者无效");
  }
  securePrivateDirectorySync(path);
  assertPrivateDirectoryAccessSync(path);
}

/** Tighten a trusted Windows socket directory to the locked Codex user-only ACL. */
export function secureAppServerSocketDirectorySync(path) {
  if (process.platform === "win32") {
    assertWindowsPrivatePathSync(path, "socket-directory", "secure");
    return;
  }
  chmodSync(path, 0o700);
}

export function assertPrivateDirectoryAccessSync(path) {
  if (process.platform === "win32") {
    assertWindowsPrivatePathSync(path, "directory");
  }
}

export function assertPrivateFileAccessSync(path) {
  if (process.platform === "win32") {
    assertWindowsPrivatePathSync(path, "file");
    return;
  }
  const metadata = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || (metadata.mode & 0o077) !== 0
    || (currentUid !== undefined && metadata.uid !== currentUid)
  ) {
    throw new Error("私有文件权限或类型无效");
  }
}

export function assertPrivateConfigAccessSync(configPath) {
  if (process.platform !== "win32") return;
  assertWindowsPrivatePathSync(configPath, "file");
  assertWindowsPrivatePathSync(dirname(configPath), "parent-directory");
}

function assertWindowsPrivatePathSync(path, kind, operation = "verify", additional = {}) {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw new Error("私有路径不能是符号链接");
  const invocation = windowsPrivatePathInvocation();
  let result;
  try { result = invokeWindowsAclSync(invocation, { operation, kind, path, ...additional }, 1_048_576); }
  catch (error) { throw windowsPrivatePathProcessError(error, error.code, "", path, kind, operation); }
  let response;
  try {
    response = JSON.parse(result.trim());
  } catch {
    throw new WindowsPrivatePathError("Windows 私有路径 ACL 检查返回无效");
  }
  if (response?.ok === false) throw windowsPrivatePathProcessError(undefined, 1, result, path, kind, operation);
  if (response?.ok !== true) throw new WindowsPrivatePathError("Windows 私有路径 ACL 校验未通过");
}

async function assertWindowsPrivatePath(path, kind, operation = "verify", additional = {}, signal) {
  signal?.throwIfAborted();
  const before = await lstat(path);
  if (before.isSymbolicLink()) throw new Error("私有路径不能是符号链接");
  let result;
  try {
    result = await invokeWindowsAcl(windowsPrivatePathInvocation(), { operation, kind, path, ...additional }, 1_048_576, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw windowsPrivatePathProcessError(error, error.code, "", path, kind, operation);
  }
  signal?.throwIfAborted();
  let response;
  try { response = JSON.parse(result.trim()); }
  catch { throw new WindowsPrivatePathError("Windows 私有路径 ACL 检查返回无效"); }
  if (response?.ok === false) throw windowsPrivatePathProcessError(undefined, 1, result, path, kind, operation);
  if (response?.ok !== true) throw new WindowsPrivatePathError("Windows 私有路径 ACL 校验未通过");
}

function windowsPrivatePathProcessError(error, status, stdout, path, kind, operation) {
  const context = `（${operation}/${kind}；路径=${JSON.stringify(path).slice(0, 320)}）`;
  if (error?.code === "ERR_WINDOWS_NATIVE_LOAD") {
    return new WindowsPrivatePathError("Windows 原生组件无法加载，尚未检查文件 ACL；请在当前 PowerShell 7 环境重新运行 npm run install:global；源码开发请运行 npm run build。");
  }
  let response;
  try { response = JSON.parse(stdout); } catch { /* Process startup or script parsing may produce no JSON. */ }
  const reasons = new Set([
    "缺少 ACL 请求", "ACL 操作无效", "ACL 路径类型无效", "ACL 路径无效",
    "父目录只支持校验", "配置读取只支持普通文件", "私有路径不能是重解析点",
    "私有路径必须是普通文件", "私有路径必须是目录", "私有路径必须由当前 SID 拥有",
    "受信任 SID 缺少完全控制权限", "其他主体具有不安全的私有路径访问权限",
    "私有路径缺少受信任 SID 权限", "私有路径仍继承父目录权限",
    "私有路径 ACL 正由其他进程更新，请重试", "Socket 目录必须仅允许当前 SID 访问",
    "私有配置超过读取上限",
    "私有路径祖先必须为不可替换的本地普通目录",
    "共享 Codex 配置只支持校验、读取和原子替换",
    "权限修复只支持普通文件", "管理员所有文件含拒绝规则，无法定向修复",
    "管理员所有文件缺少当前 SID 完全控制权限，无法定向修复",
  ]);
  if ((!error || typeof error.code === "number") && status === 1 && response?.ok === false) {
    const stage = ["request", "lock", "inspect", "secure", "verify", "verify-parent", "read-config"].includes(response.stage)
      ? response.stage : "unknown";
    const reason = reasons.has(response.reason) ? response.reason : "系统权限操作失败";
    const repairableReason = [
      "私有路径必须由当前 SID 拥有", "受信任 SID 缺少完全控制权限",
      "其他主体具有不安全的私有路径访问权限", "私有路径缺少受信任 SID 权限",
      "私有路径仍继承父目录权限",
    ].includes(reason);
    const repairHint = operation !== "repair" && stage !== "verify-parent" && kind === "file" && repairableReason
      && path.endsWith(".toml")
      && dirname(resolve(path)).toLowerCase() === codexHomePath().toLowerCase()
      ? "；请在当前用户的普通终端运行 codexc security repair，成功后重试原命令"
      : "";
    return new WindowsPrivatePathError(`Windows 私有路径 ACL 检查失败：${reason}；阶段=${stage}${context}${repairHint}`);
  }
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || error?.code === "ENOBUFS") {
    return new WindowsPrivatePathError(`Windows 私有路径 ACL 检查输出超过上限${context}`);
  }
  if (error?.code === "ETIMEDOUT" || error?.killed === true) {
    return new WindowsPrivatePathError(`Windows 私有路径 ACL 检查超时，已终止（冷启动最多 5 秒，复用请求最多 2 秒）；尚不能判定 ACL 是否有效${context}`);
  }
  if (error?.code === "EBUSY") {
    return new WindowsPrivatePathError(`Windows ACL 检查请求繁忙，请稍后重试${context}`);
  }
  if (error && typeof error.code === "string") {
    return new WindowsPrivatePathError(`Windows 私有路径 ACL 检查无法启动，请检查 PowerShell 7（pwsh）${context}`);
  }
  const exit = Number.isInteger(status) ? status : "未知";
  return new WindowsPrivatePathError(`Windows 私有路径 ACL 检查进程失败（exit=${exit}）；可能是脚本执行或权限校验失败${context}`);
}

function windowsPrivatePathInvocation() {
  try {
    return resolveExecutableInvocation("pwsh", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      join(dirname(fileURLToPath(import.meta.url)), "windows-private-acl.ps1"),
    ]);
  } catch {
    throw new WindowsPrivatePathError("Windows 私有路径 ACL 检查需要 PowerShell 7（pwsh）");
  }
}

function privateTemporaryPath(path) {
  return `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}
