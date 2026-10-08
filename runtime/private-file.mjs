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
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
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
  if (process.platform === "win32") {
    return readWindowsFileSync(path, "file", maximumBytes);
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const metadata = fstatSync(descriptor);
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile()
      || metadata.size > maximumBytes
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
      || (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      throw new Error("私有文件权限、类型或大小无效");
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

/** Upstream config is shared with Codex's sandbox: validate integrity, not secrecy. */
export function readCodexConfigFileSync(path, maximumBytes = defaultMaximumPrivateFileBytes) {
  if (process.platform !== "win32") return readPrivateFileSync(path, maximumBytes);
  return readWindowsFileSync(path, "codex-config", maximumBytes);
}

function readWindowsFileSync(path, kind, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 16_777_216) throw new Error("私有配置读取上限无效");
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

export async function writePrivateFileAtomic(path, content) {
  return writeFileAtomic(path, content, false);
}

export async function writeCodexConfigFileAtomic(path, content) {
  return writeFileAtomic(path, content, true);
}

async function writeFileAtomic(path, content, sharedConfig) {
  const parent = dirname(path);
  let parentExisted = true;
  try { await lstat(parent); } catch (error) { if (error.code !== "ENOENT") throw error; parentExisted = false; }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  let staging;
  if (process.platform === "win32") {
    if (parentExisted) assertWindowsPrivatePathSync(parent, "parent-directory");
    else securePrivateDirectorySync(parent);
    staging = await mkdtemp(join(parent, ".codexc-write-"));
  }
  const sharedWindows = process.platform === "win32" && sharedConfig;
  // ReplaceFile merges inherited ACLs at the replacement's current parent.
  // Keep shared replacements beside the destination, private before any content.
  const temporaryPath = staging && !sharedWindows ? join(staging, "content") : privateTemporaryPath(path);
  let retainStaging = false;
  try {
    if (staging) securePrivateDirectorySync(staging);
    if (sharedWindows) {
      await writeFile(temporaryPath, "", { flag: "wx" });
      securePrivateFileSync(temporaryPath);
      await writeFile(temporaryPath, content, { flag: "r+" });
    } else await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
    if (process.platform === "win32") {
      assertWindowsPrivatePathSync(temporaryPath, "file", "secure");
    } else {
      await chmod(temporaryPath, 0o600);
    }
    if (process.platform === "win32" && sharedConfig) {
      retainStaging = true;
      assertWindowsPrivatePathSync(temporaryPath, "codex-config", "replace-config", {
        destination: resolve(path), recoveryDirectory: resolve(staging),
      });
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

function windowsPrivatePathProcessError(error, status, stdout, path, kind, operation) {
  const context = `（${operation}/${kind}；路径=${JSON.stringify(path).slice(0, 320)}）`;
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
    return new WindowsPrivatePathError(`Windows 私有路径 ACL 检查超过 2 秒，已终止；尚不能判定 ACL 是否有效${context}`);
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
