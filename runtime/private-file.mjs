import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  chmodSync,
  fstatSync,
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
import { dirname } from "node:path";

const defaultMaximumPrivateFileBytes = 1_048_576;

export function readPrivateFileSync(
  path,
  maximumBytes = defaultMaximumPrivateFileBytes,
) {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const metadata = fstatSync(descriptor);
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile()
      || metadata.size > maximumBytes
      || (metadata.mode & 0o077) !== 0
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = privateTemporaryPath(path);
  try {
    writeFileSync(temporaryPath, content, { mode: 0o600, flag: "wx" });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export async function writePrivateFileAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = privateTemporaryPath(path);
  try {
    await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function privateTemporaryPath(path) {
  return `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}
