import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  chmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveExecutableInvocation } from "./executable.mjs";

const defaultMaximumPrivateFileBytes = 1_048_576;

/** Read current configuration without repairing permissions or caching ACL results. */
export async function readPrivateConfigFile(path, { signal } = {}) {
  signal?.throwIfAborted();
  if (process.platform === "win32") {
    const invocation = windowsPrivatePathInvocation();
    const result = await new Promise((resolve, reject) => {
      const child = execFile(invocation.file, invocation.args, {
        encoding: "utf8", maxBuffer: 8 * defaultMaximumPrivateFileBytes,
        timeout: 2000, killSignal: "SIGKILL", windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      }, (error, stdout) => {
        signal?.removeEventListener("abort", cancel);
        if (error) reject(new Error("Windows 私有配置读取失败"));
        else resolve(stdout);
      });
      const cancel = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      // A failed spawn may close stdin before this request is written.
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ operation: "read-config", kind: "file", path }));
    });
    signal?.throwIfAborted();
    let response;
    try { response = JSON.parse(result); } catch { throw new Error("Windows 私有配置读取结果无效"); }
    if (response?.ok !== true || typeof response.content !== "string"
      || Buffer.byteLength(response.content, "utf8") > defaultMaximumPrivateFileBytes) {
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
    if (!before.isFile() || before.size > defaultMaximumPrivateFileBytes
      || (before.mode & 0o077) !== 0
      || (process.getuid !== undefined && before.uid !== process.getuid())) {
      throw new Error("私有配置权限、类型或大小无效");
    }
    const buffer = Buffer.alloc(defaultMaximumPrivateFileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await descriptor.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > defaultMaximumPrivateFileBytes) throw new Error("私有配置超过读取上限");
    const content = buffer.subarray(0, length).toString("utf8");
    const after = await descriptor.stat();
    const current = await lstat(path);
    const currentParent = await validateParent();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
      || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino
      || Buffer.byteLength(content, "utf8") > defaultMaximumPrivateFileBytes) {
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
    assertWindowsPrivatePathSync(path, "file");
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

export function writePrivateFileAtomicSync(path, content) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    securePrivateDirectorySync(parent);
  }
  const temporaryPath = privateTemporaryPath(path);
  try {
    writeFileSync(temporaryPath, content, { mode: 0o600, flag: "wx" });
    securePrivateFileSync(temporaryPath);
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export async function writePrivateFileAtomic(path, content) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    securePrivateDirectorySync(parent);
  }
  const temporaryPath = privateTemporaryPath(path);
  try {
    await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
    if (process.platform === "win32") {
      assertWindowsPrivatePathSync(temporaryPath, "file", "secure");
    } else {
      await chmod(temporaryPath, 0o600);
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
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

function assertWindowsPrivatePathSync(path, kind, operation = "verify") {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw new Error("私有路径不能是符号链接");
  const invocation = windowsPrivatePathInvocation();
  const result = spawnSync(
    invocation.file,
    invocation.args,
    {
      input: JSON.stringify({ operation, kind, path }),
      encoding: "utf8",
      maxBuffer: 1_048_576,
      timeout: 2000,
      killSignal: "SIGKILL",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Windows 私有路径 ACL 无效");
  }
  let response;
  try {
    response = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Windows 私有路径 ACL 检查返回无效");
  }
  if (response?.ok !== true) throw new Error("Windows 私有路径 ACL 无效");
}

function windowsPrivatePathInvocation() {
  try {
    return resolveExecutableInvocation("pwsh", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      join(dirname(fileURLToPath(import.meta.url)), "windows-private-acl.ps1"),
    ]);
  } catch {
    throw new Error("Windows 私有路径 ACL 检查需要 PowerShell 7（pwsh）");
  }
}

function privateTemporaryPath(path) {
  return `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}
