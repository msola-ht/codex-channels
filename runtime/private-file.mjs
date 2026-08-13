import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
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
