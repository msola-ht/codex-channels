import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { connectHomePath } from "./connect-home.mjs";
import { ensurePrivateDirectorySync, inspectPrivateDirectoryAccessSync, readPrivateFileSync } from "./private-file.mjs";
import { withPrivateFileLock } from "./private-file-lock.mjs";
import { completeModelMessages } from "./model-template-prompts.mjs";

export const modelBaseMaximumBytes = 2 * 1024 * 1024;
export const modelBaseCommand = "codex debug models";
export const sourceModelIdentity = /^You are Codex, an agent based on [^\r\n]+?\.(?=\s|$)/u;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = text => createHash("sha256").update(text).digest("hex");

function readBundledText(path, maximumBytes = modelBaseMaximumBytes) {
  const before = lstatSync(path);
  if (!before.isFile() || before.size > maximumBytes) throw new ModelBaseSnapshotError("invalid_catalog");
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text) > maximumBytes) throw new ModelBaseSnapshotError("invalid_catalog");
  return text;
}

export class ModelBaseSnapshotError extends Error {
  constructor(code) {
    super(code === "invalid_catalog" ? "公共底座快照内容无效或版本不受支持，请保留文件并检查备份" : "公共底座快照无法安全读取，请检查私有目录和文件权限");
    this.name = "ModelBaseSnapshotError";
    this.code = code;
  }
}

export function modelBaseSnapshotPath(environment = process.env) {
  return join(connectHomePath(environment), "model-templates", "base.json");
}

/** Writers of either the base or a base-derived account snapshot share source ownership. */
export function withModelBaseSnapshotLock(environment, operation) {
  for (const directory of [connectHomePath(environment), join(connectHomePath(environment), "model-templates")]) {
    try { lstatSync(directory); inspectPrivateDirectoryAccessSync(directory); }
    catch (error) { if (error.code !== "ENOENT") throw error; ensurePrivateDirectorySync(directory); }
  }
  return withPrivateFileLock(modelBaseSnapshotPath(environment), operation, { label: "公共底座" });
}

/** Validate the assumptions shared by neutral identity and local-tool projection. */
export function validateModelBaseCatalog(catalog) {
  const model = catalog?.models?.[0];
  if (!object(catalog) || Object.keys(catalog).some(key => key !== "models")
    || !Array.isArray(catalog.models) || catalog.models.length !== 1 || !object(model)
    || typeof model.slug !== "string" || model.slug.trim() !== model.slug || !model.slug || model.slug.length > 200 || /\p{C}/u.test(model.slug)
    || !object(model.model_messages) || typeof model.model_messages.instructions_template !== "string"
    || !sourceModelIdentity.test(model.model_messages.instructions_template)
    || !Array.isArray(model.experimental_supported_tools)
    || model.experimental_supported_tools.some(tool => typeof tool !== "string" || !tool.trim() || /\p{Cc}/u.test(tool))
    || ["send_user_message_async", "clock"].some(tool => !model.experimental_supported_tools.includes(tool))
    || Buffer.byteLength(JSON.stringify(catalog)) > modelBaseMaximumBytes) throw new ModelBaseSnapshotError("invalid_catalog");
  return catalog;
}

export function encodeModelBaseSnapshot(catalog, provenance) {
  validateModelBaseCatalog(catalog);
  const document = { schemaVersion: 1, catalog, provenance };
  validateDocument(document);
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > modelBaseMaximumBytes) throw new ModelBaseSnapshotError("invalid_catalog");
  return bytes;
}

function validateDocument(document) {
  if (!object(document) || Object.keys(document).sort().join(",") !== "catalog,provenance,schemaVersion" || document.schemaVersion !== 1) throw new ModelBaseSnapshotError("invalid_catalog");
  validateModelBaseCatalog(document.catalog);
  const source = document.provenance;
  if (!object(source) || Object.keys(source).sort().join(",") !== "cliVersion,command,model"
    || typeof source.cliVersion !== "string" || !/^codex-cli \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(source.cliVersion)
    || source.command !== modelBaseCommand || source.model !== document.catalog.models[0].slug) throw new ModelBaseSnapshotError("invalid_catalog");
  return document;
}

/** Only absence permits the bundled fallback. Corruption, access errors and links fail closed. */
export function readModelBaseSnapshot(environment = process.env) {
  const path = modelBaseSnapshotPath(environment);
  let sourceRevision;
  try {
    sourceRevision = hash(["model-catalog-deepseek-source.json", "model-catalog-sources.json"].map(name => readBundledText(new URL(`./${name}`, import.meta.url))).join("\0")
      + readBundledText(new URL("../src/codex-protocol/version.json", import.meta.url), 65_536));
    for (const directory of [connectHomePath(environment), join(connectHomePath(environment), "model-templates")]) {
      try { lstatSync(directory); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      inspectPrivateDirectoryAccessSync(directory);
    }
  } catch { throw new ModelBaseSnapshotError("unavailable"); }
  let exists = true;
  try { lstatSync(path); } catch (error) {
    if (error.code === "ENOENT") exists = false;
    else throw new ModelBaseSnapshotError("unavailable");
  }
  let bytes;
  if (exists) {
    try {
      inspectPrivateDirectoryAccessSync(connectHomePath(environment));
      inspectPrivateDirectoryAccessSync(join(connectHomePath(environment), "model-templates"));
      bytes = readPrivateFileSync(path, modelBaseMaximumBytes);
    } catch { throw new ModelBaseSnapshotError("unavailable"); }
    let document;
    try { document = validateDocument(JSON.parse(bytes)); }
    catch { throw new ModelBaseSnapshotError("invalid_catalog"); }
    return { path, bytes, sourceRevision, revision: hash(`saved\0${sourceRevision}\0${bytes}`), source: "saved", ...document };
  }
  try {
    const catalogBytes = readBundledText(new URL("./model-catalog-base.json", import.meta.url));
    const sources = JSON.parse(readBundledText(new URL("./model-catalog-sources.json", import.meta.url)));
    const catalog = JSON.parse(catalogBytes);
    if (sources.official.sha256 !== hash(catalogBytes)) throw new Error("hash");
    const provenance = { model: sources.official.model, cliVersion: sources.official.cliVersion, command: sources.official.command };
    bytes = encodeModelBaseSnapshot(catalog, provenance);
    return { path, bytes, sourceRevision, revision: hash(`bundled\0${sourceRevision}\0${bytes}`), source: "bundled", schemaVersion: 1, catalog, provenance };
  } catch { throw new ModelBaseSnapshotError("invalid_catalog"); }
}

/** Rebuild from the preserved DS source so a new base replaces old inherited prompts. */
export function readDeepseekModelTemplateCatalog(environment = process.env, base = readModelBaseSnapshot(environment).catalog) {
  const path = new URL("./model-catalog-deepseek-source.json", import.meta.url);
  const bytes = readBundledText(path);
  const sources = JSON.parse(readBundledText(new URL("./model-catalog-sources.json", import.meta.url)));
  const raw = JSON.parse(bytes);
  if (sources.deepseek?.sourceSha256 !== hash(bytes) || !object(raw) || !Array.isArray(raw.models) || raw.models.length === 0
    || raw.models.some(model => !object(model) || typeof model.slug !== "string" || !model.slug || !object(model.model_messages))
    || new Set(raw.models.map(model => model.slug)).size !== raw.models.length) throw new ModelBaseSnapshotError("invalid_catalog");
  const result = structuredClone(raw);
  for (const model of result.models) model.model_messages = completeModelMessages(model.model_messages ?? {}, base.models[0].model_messages);
  return result;
}
