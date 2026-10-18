import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ModelCatalogPresentationError, projectModelCatalogEntries, projectModelPrompts } from "../runtime/model-catalog-presentation.mjs";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { connectHomePath, providerStorageRoot } from "../runtime/connect-home.mjs";
import { executableInvocation, resolveExecutable } from "../runtime/executable.mjs";
import { ownedProcessInvocation } from "../runtime/owned-process.mjs";
import { assertPrivateDirectoryAccessSync, ensurePrivateDirectorySync, readPrivateFileSync, writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { withPrivateFileLock } from "../runtime/private-file-lock.mjs";
import { registerChildProcessGroup, terminateChildProcess } from "../runtime/process-lifecycle.mjs";
import { supervisedCliInvocation } from "./cli-command-worker.mjs";
import { resolveCodexUserConfigBinary } from "./codex-user-config.mjs";

const maximumBytes = 8 * 1024 * 1024;
const exportTimeoutMs = 30_000;
// Retain ownership after a failed termination; no later cache write may race it.
const activeExports = new Map();
const messages = {
  cache_missing: "Codex 模型缓存不存在，请先通过 Codex 获取模型目录",
  invalid_catalog: "Codex 模型缓存内容无效或不受支持",
  cache_unavailable: "Codex 模型缓存无法安全读取，请检查文件权限并重试",
  stale_revision: "Codex 模型缓存已变化，请重新预览",
  invalid_input: "OpenAI 模型目录修改参数无效",
  write_failed: "Codex 模型缓存保存失败，未确认写入，请重新读取目录",
  export_failed: "Codex CLI 模型目录导出失败或已取消，请重新读取缓存并检查 CLI",
};

export class OfficialModelCatalogError extends Error {
  constructor(code, reason) {
    super(messages[code] ?? messages.cache_unavailable);
    this.name = "OfficialModelCatalogError";
    this.code = code;
    this.reason = reason;
  }
}

export async function loadOpenAiModelCatalog(environment = process.env) {
  return publicCatalog(readCache(environment));
}

export async function loadOpenAiModelPrompts(input, environment = process.env) {
  strictInput(input, ["model", "revision"]);
  if (typeof input.model !== "string") fail("invalid_input");
  const snapshot = readCache(environment);
  assertRevision(input.revision, snapshot);
  if (!snapshot.models.some(model => model.model === input.model)) fail("invalid_input");
  const model = snapshot.document.models.find(model => model.slug === input.model);
  try { return { revision: snapshot.revision, model: input.model, groups: projectModelPrompts(model.model_messages) }; }
  catch (error) { if (error instanceof ModelCatalogPresentationError) fail("invalid_catalog"); throw error; }
}

export async function previewOpenAiModelContext(input, environment = process.env, { signal } = {}) {
  assertActive(signal);
  return contextPlan(input, readCache(environment)).preview;
}

export async function applyOpenAiModelContext(input, environment = process.env, { signal } = {}) {
  assertActive(signal);
  const initial = readCache(environment);
  contextPlan(input, initial);
  return replaceCache(initial, environment, signal, (snapshot) => {
    const { preview, index } = contextPlan(input, snapshot);
    snapshot.document.models[index].context_window = preview.contextWindow;
    return {
      document: snapshot.document,
      result: { model: preview.model, contextWindow: preview.contextWindow },
    };
  });
}

export async function previewOpenAiModelRefresh(input, environment = process.env, { signal } = {}) {
  strictInput(input, ["revision"]);
  assertActive(signal);
  const snapshot = readCache(environment);
  assertRevision(input.revision, snapshot);
  assertEditableSnapshot(snapshot);
  // The configured command may write the cache, so preview only checks the snapshot.
  return { revision: snapshot.revision, scope: snapshot.scope };
}

export async function applyOpenAiModelRefresh(input, environment = process.env, { signal } = {}) {
  strictInput(input, ["revision"]);
  assertActive(signal);
  const initial = readCache(environment);
  assertRevision(input.revision, initial);
  assertEditableSnapshot(initial);
  const directory = prepareTransactionDirectory(environment, initial.scope);
  return withPrivateFileLock(join(directory, "cache"), async () => {
    assertActive(signal);
    assertTransactionDirectory(directory);
    assertSameSnapshot(initial, readCache(environment));
    try { writePrivateFileAtomicSync(join(directory, `${initial.revision}.json`), initial.bytes); }
    catch { fail("write_failed"); }
    assertSameSnapshot(initial, readCache(environment));
    const exported = await readConfiguredCatalog(environment, signal);
    // Upstream owns cache writes and metadata. Stdout may be a static catalog or
    // a fallback after a failed fetch, so never write it over the actual cache.
    const current = readCache(environment);
    if (current.canonicalPath !== initial.canonicalPath || !sameDirectory(current.parent, initial.parent)) fail("write_failed");
    return {
      revision: current.revision, scope: current.scope,
      consistency: "confirmed", backupCreated: true,
      cacheChanged: current.revision !== initial.revision,
      outputMatchesCache: compareModels(exported.models, current.document.models).length === 0,
      differences: compareModels(initial.document.models, current.document.models),
    };
  }, { label: "OpenAI 模型缓存" });
}

function compareModels(before, after) {
  const previous = new Map(projectModels(before, false).map(model => [model.model, model]));
  const next = new Map(projectModels(after, false).map(model => [model.model, model]));
  return [...new Set([...previous.keys(), ...next.keys()])].sort().flatMap(model => {
    const left = previous.get(model) ?? null;
    const right = next.get(model) ?? null;
    return isDeepStrictEqual(left, right) ? [] : [{ model, before: left, after: right }];
  });
}

function contextPlan(input, snapshot) {
  strictInput(input, ["revision", "model", "contextWindow"]);
  assertRevision(input.revision, snapshot);
  if (typeof input.model !== "string" || !Number.isSafeInteger(input.contextWindow) || input.contextWindow <= 0) fail("invalid_input");
  const model = snapshot.models.find(entry => entry.model === input.model);
  if (!model?.editable || input.contextWindow > model.maxContextWindow) fail("invalid_input");
  return {
    index: snapshot.document.models.findIndex(entry => entry.slug === input.model),
    preview: {
      revision: snapshot.revision,
      scope: snapshot.scope,
      model: model.model,
      displayName: model.displayName,
      previousContextWindow: model.contextWindow,
      contextWindow: input.contextWindow,
      maxContextWindow: model.maxContextWindow,
    },
  };
}

/** Only Gateway writers share this lock. Codex does not participate in it. */
async function replaceCache(initial, environment, signal, build) {
  let saved;
  try {
    assertActive(signal);
    const transactionDirectory = prepareTransactionDirectory(environment, initial.scope);
    return await withPrivateFileLock(join(transactionDirectory, "cache"), () => {
      assertActive(signal);
      assertTransactionDirectory(transactionDirectory);
      const snapshot = readCache(environment);
      assertSameSnapshot(initial, snapshot);
      const { document, result } = build(snapshot);
      const content = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
      if (content.length > maximumBytes) fail("invalid_catalog");
      parseCache(content.toString("utf8"));
      const expectedRevision = digest(content);
      assertActive(signal);
      try { writePrivateFileAtomicSync(join(transactionDirectory, `${snapshot.revision}.json`), snapshot.bytes); }
      catch { fail("write_failed"); }
      // Upstream may refresh during backup preparation, so recheck before replacement.
      assertSameSnapshot(snapshot, readCache(environment));
      assertTransactionDirectory(transactionDirectory);
      assertActive(signal);
      let writeFailed = false;
      try { writePrivateFileAtomicSync(snapshot.path, content); }
      catch { writeFailed = true; }
      saved = { revision: null, scope: snapshot.scope, ...result, consistency: "unknown", backupCreated: true };
      try {
        const current = readCache(environment);
        if (current.scope === snapshot.scope && sameDirectory(current.parent, snapshot.parent)
          && current.canonicalPath === snapshot.canonicalPath && current.revision === expectedRevision) {
          saved = { ...saved, revision: current.revision, consistency: "confirmed" };
        } else if (writeFailed && current.revision === snapshot.revision) {
          saved = undefined;
          fail("write_failed");
        }
      } catch (error) {
        if (error instanceof OfficialModelCatalogError && error.code === "write_failed") throw error;
        // A failed read after replacement cannot establish that nothing was saved.
      }
      return saved;
    }, { label: "OpenAI 模型缓存" });
  } catch (error) {
    if (saved) return { ...saved, revision: null, consistency: "unknown" };
    if (error instanceof OfficialModelCatalogError) throw error;
    fail("write_failed");
  }
}

function readCache(environment) {
  const path = join(codexHomePath(environment), "models_cache.json");
  let bytes;
  let parent;
  let canonicalPath;
  let file;
  try {
    parent = cacheParent(path);
    canonicalPath = join(realpathSync(dirname(path)), "models_cache.json");
    if (process.platform === "win32") {
      const before = lstatSync(path);
      if (before.isSymbolicLink() || !before.isFile()) fail("cache_unavailable");
      bytes = Buffer.from(readPrivateFileSync(path, maximumBytes), "utf8");
      if (!sameFile(before, lstatSync(path))) fail("cache_unavailable");
      file = before;
    } else {
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = fstatSync(descriptor);
        // Upstream creates this catalog with the user's umask (commonly 0644).
        // Unlike credential/config files, read access is allowed; foreign writes are not.
        if (!before.isFile() || before.size > maximumBytes || (before.mode & 0o022) !== 0
          || (process.getuid !== undefined && before.uid !== process.getuid())) fail("cache_unavailable");
        const buffer = Buffer.alloc(maximumBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(descriptor, buffer, length, buffer.length - length, null);
          if (count === 0) break;
          length += count;
        }
        if (length > maximumBytes) fail("cache_unavailable");
        const after = fstatSync(descriptor);
        const current = lstatSync(path);
        if (current.isSymbolicLink() || !sameFile(before, after) || !sameFile(before, current)
          || length !== after.size) fail("cache_unavailable");
        bytes = buffer.subarray(0, length);
        file = after;
      } finally { closeSync(descriptor); }
    }
    if (!sameDirectory(parent, cacheParent(path))
      || join(realpathSync(dirname(path)), "models_cache.json") !== canonicalPath) fail("cache_unavailable");
  } catch (error) {
    if (error instanceof OfficialModelCatalogError) throw error;
    if (error?.code === "ENOENT") fail("cache_missing");
    fail("cache_unavailable");
  }
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) fail("invalid_catalog");
  const document = parseCache(content);
  // CLI upgrades must not detach overwrite reminders from the same cache owner.
  const scope = digest(JSON.stringify([canonicalPath, document.identity ?? null]));
  return { path, canonicalPath, parent, file, bytes, document, scope, revision: digest(bytes), models: projectModels(document.models, hasCacheIdentity(document)) };
}

function parseCache(content) {
  let document;
  try { document = JSON.parse(content); } catch { fail("invalid_catalog"); }
  if (!record(document) || typeof document.fetched_at !== "string" || !Number.isFinite(Date.parse(document.fetched_at))
    || !/^\d{4}-\d{2}-\d{2}T/u.test(document.fetched_at)
    || (document.etag != null && typeof document.etag !== "string")
    || (document.client_version != null && !optionalMetadataText(document.client_version))
    || (document.identity != null && typeof document.identity !== "string")) fail("invalid_catalog");
  projectModels(document.models, hasCacheIdentity(document));
  return document;
}

function projectModels(models, hasIdentity) {
  try { return projectModelCatalogEntries(models, hasIdentity); }
  catch (error) { if (error instanceof ModelCatalogPresentationError) fail("invalid_catalog"); throw error; }
}

function publicCatalog(snapshot) {
  return {
    source: "codex-cache",
    revision: snapshot.revision,
    scope: snapshot.scope,
    fetchedAt: snapshot.document.fetched_at,
    clientVersion: snapshot.document.client_version ?? null,
    models: snapshot.models,
  };
}

function hasCacheIdentity(document) {
  return typeof document.identity === "string" && document.identity.length > 0
    && typeof document.client_version === "string" && document.client_version.length > 0;
}

function assertEditableSnapshot(snapshot) {
  if (!hasCacheIdentity(snapshot.document)) fail("invalid_input");
}

function cacheParent(path) {
  const metadata = lstatSync(dirname(path));
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("cache_unavailable");
  if (process.platform !== "win32" && ((metadata.mode & 0o022) !== 0
    || (process.getuid !== undefined && metadata.uid !== process.getuid()))) fail("cache_unavailable");
  return metadata;
}

function prepareTransactionDirectory(environment, scope) {
  for (const path of [connectHomePath(environment), providerStorageRoot(environment), join(providerStorageRoot(environment), "openai-cache")]) {
    preparePrivateDirectory(path);
  }
  const path = join(providerStorageRoot(environment), "openai-cache", scope);
  preparePrivateDirectory(path);
  return path;
}

function preparePrivateDirectory(path) {
  try { lstatSync(path); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    ensurePrivateDirectorySync(path);
  }
  assertTransactionDirectory(path);
}

function assertTransactionDirectory(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || (process.platform !== "win32" && ((metadata.mode & 0o077) !== 0
      || (process.getuid !== undefined && metadata.uid !== process.getuid())))) fail("write_failed");
  assertPrivateDirectoryAccessSync(path);
}

function assertSameSnapshot(expected, actual) {
  if (expected.revision !== actual.revision || expected.scope !== actual.scope
    || expected.canonicalPath !== actual.canonicalPath || !sameDirectory(expected.parent, actual.parent)
    || !sameFile(expected.file, actual.file)) fail("stale_revision");
}

function sameDirectory(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameFile(left, right) { return sameDirectory(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function strictInput(input, fields) {
  if (!record(input) || Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key))) fail("invalid_input");
}
function assertRevision(value, snapshot) {
  if (!revisionText(value)) fail("invalid_input");
  if (value !== snapshot.revision) fail("stale_revision");
}
function revisionText(value) { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function fail(code, reason) { throw new OfficialModelCatalogError(code, reason); }
function assertActive(signal) {
  if (signal?.aborted) fail("export_failed", "cancelled");
  if (activeExports.size) fail("export_failed", "termination-unconfirmed");
}

export async function closeOpenAiModelExports() {
  const results = await Promise.allSettled([...activeExports.keys()].map(child => terminateChildProcess(child)));
  if (activeExports.size || results.some(result => result.status === "rejected")) {
    fail("export_failed", "termination-unconfirmed");
  }
}

export async function waitForOpenAiModelExportsExit() {
  await Promise.all([...activeExports.values()]);
}
function hasControlCharacters(value) { return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }
function optionalMetadataText(value) { return typeof value === "string" && value.length > 0 && value.length <= 256 && !hasControlCharacters(value); }

async function readConfiguredCatalog(environment, signal) {
  assertActive(signal);
  let child;
  try {
    const binary = resolveCodexUserConfigBinary(environment);
    const invocation = supervisedCliInvocation(ownedProcessInvocation(executableInvocation(
      resolveExecutable(binary, environment), ["debug", "models"], environment,
    ), environment));
    child = spawn(invocation.file, invocation.args, {
      env: environment,
      cwd: codexHomePath(environment),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  } catch { fail("export_failed", "launch"); }
  if (process.platform !== "win32") registerChildProcessGroup(child);
  let failure;
  let stopping;
  let stopped;
  const stopFinished = new Promise(resolve => { stopped = resolve; });
  const stop = (reason) => {
    failure ??= reason;
    stopping ??= terminateChildProcess(child)
      .catch(() => { failure = "termination-unconfirmed"; })
      .finally(() => stopped(null));
  };
  let bytes = 0;
  const chunks = [];
  const collect = (chunk, keep) => {
    bytes += chunk.length;
    if (bytes > maximumBytes) stop("output-limit");
    else if (keep && !failure) chunks.push(chunk);
  };
  child.stdout.on("data", chunk => collect(chunk, true));
  child.stderr.on("data", chunk => collect(chunk, false));
  child.once("error", () => { failure ??= "launch"; });
  const closed = new Promise(resolve => child.once("close", (code, exitSignal) => {
    activeExports.delete(child);
    resolve({ code, exitSignal });
  }));
  activeExports.set(child, closed);
  const timer = setTimeout(() => stop("timeout"), exportTimeoutMs);
  const abort = () => stop("cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const result = await Promise.race([closed, stopFinished]);
    await stopping;
    if (result === null) fail("export_failed", activeExports.has(child) ? "termination-unconfirmed" : failure);
    const { code, exitSignal } = result;
    if (failure || code !== 0 || exitSignal) fail("export_failed", failure ?? "exit");
    try {
      const content = Buffer.concat(chunks);
      const text = content.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(content)) fail("export_failed", "decode");
      const catalog = JSON.parse(text);
      if (!record(catalog) || Object.keys(catalog).length !== 1) fail("export_failed", "decode");
      projectModels(catalog.models, true);
      return catalog;
    } catch { fail("export_failed", "decode"); }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    chunks.length = 0;
  }
}
