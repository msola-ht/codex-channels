import { createHash, randomBytes } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { connectHomePath } from "../runtime/connect-home.mjs";
import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { OwnedCommandRunner } from "../runtime/owned-command-runner.mjs";
import { ensurePrivateDirectorySync, inspectPrivateDirectoryAccessSync, readPrivateFileSync, writePrivateFileAtomicSync, PrivateFileWriteCommittedError } from "../runtime/private-file.mjs";
import { PrivateFileLockReleaseError } from "../runtime/private-file-lock.mjs";
import { ModelBaseSnapshotError, readModelBaseSnapshot, readDeepseekModelTemplateCatalog, encodeModelBaseSnapshot,
  validateModelBaseCatalog, modelBaseCommand, modelBaseMaximumBytes, withModelBaseSnapshotLock } from "../runtime/model-base-snapshot.mjs";
import { resolveCodexUserConfigBinary } from "./codex-user-config.mjs";

const messages = {
  invalid_input: "公共底座更新参数无效",
  invalid_catalog: "公共底座内容无效、身份或本地工具声明不受支持，请审核导出源",
  unavailable: "公共底座无法安全读取，请检查目录、文件权限和仓库快照",
  stale_revision: "公共底座或来源已变化，候选已过期或不可用，请重新导出并对比",
  export_failed: "公共底座导出或 CLI 校验失败、超时或已取消，请检查锁定 CLI 后重新对比",
  write_failed: "公共底座保存未确认，请重新读取并核对修订与保留备份，勿自动重试",
  busy: "公共底座正在处理另一操作或子进程退出尚未确认，请稍后重试",
  login_required: "更新公共底座需要先通过 codex login 登录 ChatGPT；未确认登录，不导出或保存底座，继续使用现有底座（默认随项目附带）",
};
const candidates = new Map();
const maximumCandidateBytes = 16 * 1024 * 1024;
const maximumPreviewBytes = 8 * 1024 * 1024;
const candidateLifetimeMs = 10 * 60 * 1000;
const runner = new OwnedCommandRunner();
const deferredCleanup = new Set();
let operating = false;
let cleanupUnconfirmed = false;
let closing = false;

export class ModelBaseError extends Error {
  constructor(code, reason, options) {
    super(messages[code] ?? messages.unavailable, options);
    this.name = "ModelBaseError";
    this.code = Object.hasOwn(messages, code) ? code : "unavailable";
    this.reason = reason;
  }
}

function fail(code, reason, cause) { throw new ModelBaseError(code, reason, cause === undefined ? undefined : { cause }); }
function read(environment) {
  try { return readModelBaseSnapshot(environment); }
  catch (error) { if (error instanceof ModelBaseSnapshotError) fail(error.code); fail("unavailable"); }
}
function strict(input, keys) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length
    || Object.keys(input).some(key => !keys.includes(key)) || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/u.test(input.revision)) fail("invalid_input");
}
function assertRevision(revision, state) { if (revision !== state.revision) fail("stale_revision"); }
function publicState(state) { return { revision: state.revision, ...state.provenance, source: state.source }; }
function assertActive(signal) {
  if (closing || signal?.aborted) fail("export_failed", "cancelled");
  if (operating || cleanupUnconfirmed) fail("busy");
}

export async function loadModelBase(environment = process.env) { return publicState(read(environment)); }

export async function prepareModelBaseUpdate(input, environment = process.env, { signal } = {}) {
  strict(input, ["revision"]);
  assertActive(signal);
  const state = read(environment);
  assertRevision(input.revision, state);
  operating = true;
  const budget = globalThis.AbortSignal.timeout(40_000);
  const operationSignal = signal ? globalThis.AbortSignal.any([signal, budget]) : budget;
  let phase = "resolve-cli";
  try {
    const binary = resolveCodexUserConfigBinary(environment);
    const cliVersion = (await run(binary, ["--version"], environment, operationSignal, process.cwd(), 65_536)).trim();
    phase = "read-cli-baseline";
    const expected = JSON.parse(readFileSync(new URL("../src/codex-protocol/version.json", import.meta.url), "utf8")).codexCli;
    if (cliVersion !== expected) fail("export_failed", "version-mismatch");
    await assertModelBaseLogin(binary, environment, operationSignal);
    let catalog;
    try {
      const exported = JSON.parse(await run(binary, ["debug", "models"], environment, operationSignal, process.cwd(), 32 * modelBaseMaximumBytes));
      catalog = validateModelBaseCatalog({ models: [exported?.models?.[0]] });
    } catch (error) { if (error instanceof ModelBaseError) throw error; fail("invalid_catalog"); }
    const provenance = { model: catalog.models[0].slug, cliVersion, command: modelBaseCommand };
    phase = "encode-snapshot";
    const bytes = encodeModelBaseSnapshot(catalog, provenance);
    phase = "complete-deepseek";
    const beforeDeepseek = readDeepseekModelTemplateCatalog(environment, state.catalog);
    const afterDeepseek = readDeepseekModelTemplateCatalog(environment, catalog);
    phase = "validate-base";
    await validateCatalog(binary, catalog, environment, operationSignal);
    phase = "validate-deepseek";
    await validateCatalog(binary, afterDeepseek, environment, operationSignal);
    await assertModelBaseLogin(binary, environment, operationSignal);
    if (operationSignal.aborted) fail("export_failed", "cancelled");
    assertRevision(state.revision, read(environment));
    phase = "compare";
    const changes = differences({ base: { catalog: state.catalog, provenance: state.provenance }, deepseek: beforeDeepseek },
      { base: { catalog, provenance }, deepseek: afterDeepseek });
    const preview = { revision: state.revision, candidateToken: randomBytes(32).toString("hex"),
      expiresAt: Date.now() + candidateLifetimeMs, changed: changes.length > 0,
      before: { ...state.provenance }, after: provenance, changes };
    const size = Buffer.byteLength(JSON.stringify(preview)) + Buffer.byteLength(bytes);
    if (Buffer.byteLength(JSON.stringify(preview)) > maximumPreviewBytes || size > maximumCandidateBytes) fail("invalid_catalog", "preview-limit");
    prune();
    let retained = [...candidates.values()].reduce((total, candidate) => total + candidate.size, 0);
    while (candidates.size >= 8 || retained + size > maximumCandidateBytes) {
      const oldest = candidates.keys().next().value;
      retained -= candidates.get(oldest).size;
      candidates.delete(oldest);
    }
    candidates.set(preview.candidateToken, { path: state.path, preview, bytes, size });
    return structuredClone(preview);
  } catch (error) {
    if (error instanceof ModelBaseError) throw error;
    if (error instanceof ModelBaseSnapshotError) fail(error.code);
    fail("export_failed", operationSignal.aborted ? "cancelled" : phase, error);
  } finally { operating = false; }
}

function candidateFor(input, environment) {
  strict(input, ["revision", "candidateToken"]);
  if (typeof input.candidateToken !== "string" || !/^[a-f0-9]{64}$/u.test(input.candidateToken)) fail("invalid_input");
  prune();
  const state = read(environment);
  assertRevision(input.revision, state);
  const candidate = candidates.get(input.candidateToken);
  if (!candidate || candidate.path !== state.path || candidate.preview.revision !== state.revision) fail("stale_revision");
  return { candidate, state };
}

export async function getModelBaseUpdatePreview(input, environment = process.env) {
  return structuredClone(candidateFor(input, environment).candidate.preview);
}

export async function applyModelBaseUpdate(input, environment = process.env, { signal } = {}) {
  assertActive(signal);
  const initial = candidateFor(input, environment);
  operating = true;
  let savedResult;
  try {
    await assertModelBaseLogin(resolveCodexUserConfigBinary(environment), environment, signal);
    candidateFor(input, environment);
    if (!initial.candidate.preview.changed) {
      candidates.delete(input.candidateToken);
      return { status: "unchanged", model: initial.state.provenance.model, revision: initial.state.revision, consistency: "confirmed" };
    }
    const directory = dirname(initial.state.path);
    ensureDirectory(connectHomePath(environment));
    ensureDirectory(directory);
    return await withModelBaseSnapshotLock(environment, async () => {
      if (signal?.aborted) fail("export_failed", "cancelled");
      inspectPrivateDirectoryAccessSync(directory);
      await assertModelBaseLogin(resolveCodexUserConfigBinary(environment), environment, signal);
      const { state, candidate } = candidateFor(input, environment);
      if (candidate !== initial.candidate) fail("stale_revision");
      const backups = join(directory, "backups");
      ensureDirectory(backups);
      const backupPath = join(backups, `${state.revision}.json`);
      let previousBackup;
      try { previousBackup = readPrivateFileSync(backupPath, modelBaseMaximumBytes); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (previousBackup !== undefined && previousBackup !== state.bytes) fail("write_failed", "backup-conflict");
      if (previousBackup === undefined) writePrivateFileAtomicSync(backupPath, state.bytes);
      assertRevision(state.revision, read(environment));
      if (signal?.aborted) fail("export_failed", "cancelled");
      try { writePrivateFileAtomicSync(state.path, candidate.bytes); }
      catch (error) { if (!(error instanceof PrivateFileWriteCommittedError)) throw error; }
      // Once replaced, cancellation and readback failures cannot undo the saved fact.
      const revision = createHash("sha256").update(`saved\0${state.sourceRevision}\0${candidate.bytes}`).digest("hex");
      savedResult = { status: "updated", model: candidate.preview.after.model, revision, backupPath, consistency: "unconfirmed" };
      candidates.delete(input.candidateToken);
      try {
        const current = read(environment);
        if (current.source === "saved" && current.bytes === candidate.bytes && current.revision === revision) savedResult.consistency = "confirmed";
      } catch { /* Report the saved result with an unconfirmed consistency. */ }
      return savedResult;
    });
  } catch (error) {
    if (error instanceof PrivateFileLockReleaseError && error.result) return { ...error.result, consistency: "unconfirmed" };
    if (savedResult) return { ...savedResult, consistency: "unconfirmed" };
    if (error instanceof ModelBaseError) throw error;
    if (error?.cause?.code === "EEXIST") fail("busy");
    fail("write_failed");
  } finally { operating = false; }
}

function ensureDirectory(path) {
  try { lstatSync(path); inspectPrivateDirectoryAccessSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; ensurePrivateDirectorySync(path); }
}
function prune() { for (const [token, candidate] of candidates) if (candidate.preview.expiresAt <= Date.now()) candidates.delete(token); }
function differences(before, after, field = "", result = [], beforePresent = true, afterPresent = true) {
  if (beforePresent === afterPresent && isDeepStrictEqual(before, after)) return result;
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  if (record(before) && record(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) differences(before[key], after[key], field ? `${field}.${key}` : key,
      result, Object.hasOwn(before, key), Object.hasOwn(after, key));
  } else if (field.endsWith(".models") && Array.isArray(before) && Array.isArray(after)) {
    differences(Object.fromEntries(before.map(model => [model.slug, model])), Object.fromEntries(after.map(model => [model.slug, model])), field, result);
  } else result.push({ field, before: beforePresent ? { present: true, value: before } : { present: false },
    after: afterPresent ? { present: true, value: after } : { present: false } });
  return result;
}
export async function assertModelBaseLogin(binary, environment = process.env, signal) {
  await run(binary, ["login", "status"], environment, signal, process.cwd(), 65_536, true);
}

async function run(binary, args, environment, signal, cwd, maxOutputBytes, login = false) {
  try {
    const result = await runner.run(resolveExecutableInvocation(binary, args, environment), { timeoutMs: login ? 5_000 : 30_000, maxOutputBytes, environment, signal, cwd, strictUtf8: true });
    if (login) {
      if (result.status !== 0 || !result.stderr.split(/\r?\n/u).includes("Logged in using ChatGPT")) fail("login_required");
      return "";
    }
    if (result.status !== 0) fail("export_failed", "exit");
    return result.stdout;
  } catch (error) {
    if (error.reason === "cleanup-unconfirmed") {
      cleanupUnconfirmed = true;
      void runner.waitForExit().then(() => { cleanupUnconfirmed = false; });
    }
    if (error instanceof ModelBaseError) throw error;
    const allowed = ["cancelled", "timeout", "output-limit", "spawn", "decode", "cleanup-unconfirmed"];
    fail("export_failed", allowed.includes(error.reason) ? error.reason : "command");
  }
}
async function validateCatalog(binary, catalog, environment, signal) {
  const directory = await mkdtemp(join(tmpdir(), "codexc-base-catalog-"));
  try {
    ensurePrivateDirectorySync(directory);
    const path = join(directory, "models.json");
    const content = `${JSON.stringify(catalog, null, 2)}\n`;
    if (Buffer.byteLength(content) > modelBaseMaximumBytes) fail("invalid_catalog", "catalog-limit");
    writePrivateFileAtomicSync(path, content);
    await run(binary, ["-c", `model_catalog_json=${JSON.stringify(path)}`, "debug", "models"],
      { ...environment, CODEX_HOME: directory }, signal, directory, 8 * modelBaseMaximumBytes);
  } finally {
    if (cleanupUnconfirmed) {
      const cleanup = runner.waitForExit().then(() => rm(directory, { recursive: true, force: true }));
      deferredCleanup.add(cleanup);
      void cleanup.then(() => deferredCleanup.delete(cleanup), () => undefined);
    } else await rm(directory, { recursive: true, force: true });
  }
}

export async function closeModelBaseExports() {
  closing = true;
  candidates.clear();
  try { await runner.close(); await Promise.all(deferredCleanup); }
  catch { fail("export_failed", "cleanup-unconfirmed"); }
}
export async function waitForModelBaseExportsExit() { await runner.waitForExit(); await Promise.all(deferredCleanup); }
