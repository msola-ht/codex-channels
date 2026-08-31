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
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveExecutableInvocation } from "./executable.mjs";

const defaultMaximumPrivateFileBytes = 1_048_576;

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
  const script = join(dirname(fileURLToPath(import.meta.url)), "windows-private-acl.ps1");
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw new Error("私有路径不能是符号链接");
  let invocation;
  try {
    invocation = resolveExecutableInvocation(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
      ],
    );
  } catch {
    throw new Error("Windows 私有路径 ACL 检查需要 PowerShell 7（pwsh）");
  }
  const result = spawnSync(
    invocation.file,
    invocation.args,
    {
      input: JSON.stringify({ operation, kind, path }),
      encoding: "utf8",
      maxBuffer: 1_048_576,
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

function privateTemporaryPath(path) {
  return `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}
