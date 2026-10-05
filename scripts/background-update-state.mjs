import { spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants, chmodSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { userDataDir } from "./runtime-config.mjs";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const statuses = new Set(["queued", "running", "succeeded", "failed", "recovery-required"]);
const environmentKeys = new Set([
  "HOME", "PATH", "CODEX_HOME", "CODEX_CONNECT_HOME", "CODEX_CONNECT_CONFIG_FILE", "CODEX_BINARY",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "npm_config_prefix", "NPM_CONFIG_PREFIX",
]);
const maximumDocumentBytes = 64 * 1024;

export function updateRoot(environment = process.env) {
  return join(userDataDir(environment), "maintenance", "updates");
}

export function assertUpdateId(id) {
  if (typeof id !== "string" || !idPattern.test(id)) throw new Error("更新任务 ID 无效");
  return id;
}

export function updateJobDirectory(root, id) {
  return join(resolve(root), assertUpdateId(id));
}

export function createUpdateDirectory(root, id = randomUUID()) {
  ensurePrivateDirectory(root);
  const directory = updateJobDirectory(root, id);
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}

export function writeUpdateJob(root, job) {
  validateJob(job);
  const directory = updateJobDirectory(root, job.id);
  assertPrivateDirectory(directory);
  const path = join(directory, "job.json");
  if (existsSync(path)) throw new Error("更新任务定义已经冻结");
  atomicDocument(path, job);
}

export function readUpdateJob(root, id) {
  const job = readDocument(join(updateJobDirectory(root, id), "job.json"));
  validateJob(job);
  if (job.id !== id) throw new Error("更新任务 ID 不一致");
  return job;
}

export function writeUpdateReceipt(root, id, receipt) {
  validateReceipt(receipt);
  if (receipt.id !== assertUpdateId(id)) throw new Error("更新回执 ID 不一致");
  atomicDocument(join(updateJobDirectory(root, id), "receipt.json"), receipt);
}

export function readUpdateReceipt(root, id) {
  const receipt = readDocument(join(updateJobDirectory(root, id), "receipt.json"));
  validateReceipt(receipt);
  if (receipt.id !== id) throw new Error("更新回执 ID 不一致");
  return receipt;
}

export function listUpdateJobIds(root) {
  if (!existsSync(root)) return [];
  assertPrivateDirectory(root);
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && idPattern.test(entry.name)
      && existsSync(join(root, entry.name, "job.json")) && existsSync(join(root, entry.name, "receipt.json")))
    .map(entry => entry.name);
}

export function readActiveUpdate(root) {
  const path = join(root, "active.json");
  if (!existsSync(path)) return undefined;
  const document = readDocument(path);
  exactKeys(document, ["formatVersion", "id"]);
  if (document.formatVersion !== 1) throw new Error("更新任务占用格式不受支持");
  return assertUpdateId(document.id);
}

// Call under withUpdateLock; the reservation persists between submitter and worker.
export function reserveUpdate(root, id) {
  assertUpdateId(id);
  const active = readActiveUpdate(root);
  if (active) throw new Error(`已有更新任务占用：${active}`);
  atomicDocument(join(root, "active.json"), { formatVersion: 1, id });
}

export function releaseUpdate(root, id) {
  if (readActiveUpdate(root) !== assertUpdateId(id)) throw new Error("不能释放其他更新任务");
  rmSync(join(root, "active.json"));
  syncDirectory(root);
}

export async function withUpdateLock(root, callback) {
  if (process.platform !== "linux") throw new Error("独立后台更新目前仅支持 Linux");
  ensurePrivateDirectory(root);
  const path = join(root, "update.lock");
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    assertPrivateFile(path);
    // flock and this process share one open file description; our fd retains
    // the lock after flock exits, and the kernel releases it on process death.
    const locked = spawnSync("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "73", "3"],
      { stdio: ["ignore", "pipe", "pipe", fd], timeout: 5000 });
    if (locked.error) throw new Error("无法启动更新独占锁", { cause: locked.error });
    if (locked.status !== 0) throw new Error(locked.status === 73 ? "另一个更新操作正在运行" : "更新独占锁启动失败");
    return await callback();
  } finally {
    closeSync(fd);
  }
}

export function snapshotLocalSource(source, destination) {
  const sourcePath = resolve(source);
  assertNoSymlinkPath(sourcePath);
  if (!statSync(sourcePath).isDirectory()) throw new Error("本机源码必须为目录");
  assertOutside(sourcePath, destination);
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: sourcePath, encoding: "utf8" }).trim();
  if (realpathSync(top) !== sourcePath) throw new Error("本机源码必须指定 Git 工作树根目录");
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourcePath, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("源码提交标识无效");
  const entries = sourceEntries(sourcePath);
  ensureNewPrivateDirectory(destination);
  const hash = createHash("sha256");
  const fileModes = new Map();
  for (const entry of entries) {
    const parts = entry.split("/");
    if (isAbsolute(entry) || parts.some(part => !part || part === "." || part === "..")) {
      throw new Error("源码文件路径无效");
    }
    if (parts.some(part => [".git", "node_modules", "dist"].includes(part))) continue;
    const original = join(sourcePath, entry);
    // Deleted tracked files are intentionally absent from the snapshot.
    if (!existsSync(original)) {
      try { lstatSync(original); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    }
    assertNoSymlinkPath(original);
    const info = lstatSync(original);
    if (!info.isFile()) throw new Error("源码包含不受支持的文件类型或子模块");
    fileModes.set(entry, info.mode & 0o777);
    const target = join(destination, entry);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const sourceFd = openSync(original, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = readFileSync(sourceFd);
      writeFileSync(target, bytes, { flag: "wx", mode: info.mode & 0o111 ? 0o700 : 0o600 });
      hash.update(entry).update("\0").update(String(info.mode & 0o111)).update("\0");
      hash.update(String(bytes.length)).update("\0").update(bytes);
    } finally { closeSync(sourceFd); }
  }
  if (JSON.stringify(sourceEntries(sourcePath)) !== JSON.stringify(entries)
    || execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourcePath, encoding: "utf8" }).trim() !== sourceCommit) {
    throw new Error("源码在快照期间发生变化，请重试");
  }
  for (const entry of entries) {
    if (entry.split("/").some(part => [".git", "node_modules", "dist"].includes(part))) continue;
    const original = join(sourcePath, entry);
    const target = join(destination, entry);
    if (!existsSync(original) && !existsSync(target)) continue;
    assertNoSymlinkPath(original);
    if (!existsSync(target) || !lstatSync(original).isFile()
      || (lstatSync(original).mode & 0o777) !== fileModes.get(entry)
      || !readFileSync(original).equals(readFileSync(target))) throw new Error("源码在快照期间发生变化，请重试");
  }
  return { sourcePath, sourceCommit, snapshotSha256: hash.digest("hex") };
}

function sourceEntries(sourcePath) {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: sourcePath, maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(output.toString("utf8").split("\0").filter(Boolean))].sort();
}

export function copyUpdateRunner(installedPackage, destination) {
  const source = resolve(installedPackage);
  assertNoSymlinkPath(source);
  assertOutside(source, destination);
  if (!lstatSync(source).isDirectory()) throw new Error("已安装程序目录无效");
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (manifest.name !== "@hegenai/codexc" || !existsSync(join(source, "node_modules"))) {
    throw new Error("独立更新需要含完整依赖的已安装 Gateway 包");
  }
  inspectRunnerEntries(source, source);
  ensureNewPrivateDirectory(destination);
  cpSync(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true,
    errorOnExist: true, force: false });
  chmodSync(destination, 0o700);
  return destination;
}

function inspectRunnerEntries(root, directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const link = readlinkSync(path);
      if (isAbsolute(link) || !isWithin(root, realpathSync(path))) throw new Error("已安装包包含外部符号链接");
    } else if (entry.isDirectory()) inspectRunnerEntries(root, path);
    else if (!entry.isFile()) throw new Error("已安装包包含特殊文件");
  }
}

function validateJob(job) {
  exactKeys(job, ["formatVersion", "id", "createdAt", "originalSourceDirectory", "sourceCommit", "snapshotSha256",
    "installedDirectory", "npmPrefix", "nodeBinary", "environment", "unitName"]);
  if (job.formatVersion !== 1) throw new Error("更新任务格式不受支持");
  assertUpdateId(job.id);
  timestamp(job.createdAt);
  for (const key of ["originalSourceDirectory", "installedDirectory", "npmPrefix", "nodeBinary"]) {
    if (!string(job[key]) || !isAbsolute(job[key])) throw new Error("更新任务路径无效");
  }
  if (!/^[0-9a-f]{40}$/u.test(job.sourceCommit) || !digestPattern.test(job.snapshotSha256)) throw new Error("更新源码身份无效");
  if (job.unitName !== `codexc-update-${job.id}`) throw new Error("更新任务单元名称无效");
  if (!record(job.environment)) throw new Error("更新任务环境无效");
  for (const [key, value] of Object.entries(job.environment)) {
    if (!environmentKeys.has(key) || !string(value)) throw new Error("更新任务包含不支持的环境变量");
  }
}

function validateReceipt(receipt) {
  exactKeys(receipt, ["formatVersion", "id", "updatedAt", "status", "stage"], ["result", "error"]);
  if (receipt.formatVersion !== 1) throw new Error("更新回执格式不受支持");
  assertUpdateId(receipt.id);
  timestamp(receipt.updatedAt);
  if (!statuses.has(receipt.status) || typeof receipt.stage !== "string" || !/^[a-z][a-z0-9-]{0,79}$/u.test(receipt.stage)) {
    throw new Error("更新回执状态无效");
  }
  if (receipt.error !== undefined && (!string(receipt.error) || receipt.error.length > 1024)) throw new Error("更新错误摘要无效");
  if (receipt.result !== undefined) {
    exactKeys(receipt.result, [], ["version", "previousVersion", "packageSha256", "restoredServices", "recovery"]);
    const result = receipt.result;
    if (result.version !== undefined && !string(result.version)) throw new Error("更新结果版本无效");
    if (result.previousVersion !== undefined && !string(result.previousVersion)) throw new Error("更新结果原版本无效");
    if (result.packageSha256 !== undefined && !digestPattern.test(result.packageSha256)) throw new Error("更新包摘要无效");
    if (result.recovery !== undefined) {
      exactKeys(result.recovery, ["status", "restoredServices", "errors"], ["package"]);
      if (!["not-needed", "restored", "failed", "stopped"].includes(result.recovery.status)
        || !Array.isArray(result.recovery.restoredServices) || !result.recovery.restoredServices.every(string)
        || !Array.isArray(result.recovery.errors) || !result.recovery.errors.every(string)
        || result.recovery.package !== undefined && !["candidate", "previous"].includes(result.recovery.package)) {
        throw new Error("更新恢复结果无效");
      }
    }
    if (result.restoredServices !== undefined && (!Array.isArray(result.restoredServices)
      || result.restoredServices.length > 32 || !result.restoredServices.every(string))) {
      throw new Error("更新结果列表无效");
    }
  }
}

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function string(value) { return typeof value === "string" && value.length > 0 && value.length <= 8192 && !value.includes("\0"); }
function exactKeys(value, required, optional = []) {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("更新任务文档字段无效");
}
function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("更新任务时间无效");
}
function isWithin(root, path) {
  const suffix = relative(root, path);
  return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
function assertOutside(source, destination) {
  if (isWithin(source, resolve(destination))) throw new Error("更新任务目录不能位于源码或已安装包内部");
}
function assertNoSymlinkPath(path) {
  let current = resolve(path);
  for (;;) {
    if (lstatSync(current).isSymbolicLink()) throw new Error("更新路径不允许符号链接");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function assertOwnedPrivate(path, directory) {
  assertNoSymlinkPath(path);
  const info = lstatSync(path);
  if ((directory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o077) !== 0
    || typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("更新任务文件权限不安全");
}
function assertPrivateDirectory(path) { assertOwnedPrivate(path, true); }
function assertPrivateFile(path) { assertOwnedPrivate(path, false); }
function ensurePrivateDirectory(path) {
  if (!existsSync(path)) {
    let existing = resolve(path);
    while (!existsSync(existing)) {
      try {
        if (lstatSync(existing).isSymbolicLink()) throw new Error("更新路径不允许符号链接");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      existing = dirname(existing);
    }
    assertNoSymlinkPath(existing);
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  assertPrivateDirectory(path);
}
function ensureNewPrivateDirectory(path) {
  assertNoSymlinkPath(dirname(resolve(path)));
  mkdirSync(path, { mode: 0o700 });
}
function readDocument(path) {
  assertPrivateDirectory(dirname(path));
  assertPrivateFile(path);
  if (statSync(path).size > maximumDocumentBytes) throw new Error("更新任务文档过大");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
}
function atomicDocument(path, value) {
  assertPrivateDirectory(dirname(path));
  if (existsSync(path)) assertPrivateFile(path);
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) > maximumDocumentBytes) throw new Error("更新任务文档过大");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); syncDirectory(dirname(path)); }
  finally { rmSync(temporary, { force: true }); }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
