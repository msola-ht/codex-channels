import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { effectiveCodexBinary, resolveExecutableInvocation } from "../runtime/executable.mjs";
import { completeModelMessages } from "../runtime/model-template-prompts.mjs";
import { packageDir } from "./package-path.mjs";
import { downloadDeepseekCatalog, deepseekSetupScriptUrl } from "./deepseek-setup.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";

const directory = join(packageDir, "runtime");
const maximumBytes = 2 * 1024 * 1024;
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = text => createHash("sha256").update(text).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function readOptional(path) {
  try { return readFileSync(path, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function validateCatalog(catalog) {
  if (!object(catalog) || !Array.isArray(catalog.models) || catalog.models.length === 0) throw new Error("模型目录为空或结构无效");
  const ids = new Set();
  for (const model of catalog.models) {
    if (!object(model) || typeof model.slug !== "string" || !model.slug || ids.has(model.slug)
      || !object(model.model_messages)) throw new Error("模型目录包含无效或重复模型，或缺少提示词对象");
    ids.add(model.slug);
  }
}

function completeDeepseek(raw, base) {
  const completed = structuredClone(raw);
  for (const model of completed.models) {
    model.model_messages = completeModelMessages(model.model_messages, base.model_messages);
  }
  return completed;
}

function differences(before, after, path = "", result = []) {
  if (isDeepStrictEqual(before, after)) return result;
  if (object(before) && object(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      differences(before[key], after[key], path ? `${path}.${key}` : key, result);
    }
  } else if (path === "models" && Array.isArray(before) && Array.isArray(after)) {
    const left = Object.fromEntries(before.map(model => [model.slug, model]));
    const right = Object.fromEntries(after.map(model => [model.slug, model]));
    differences(left, right, path, result);
  } else result.push(`${before === undefined ? "新增" : after === undefined ? "删除" : "修改"} ${path || "整个文件"}`);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("用法：node scripts/update-model-templates.mjs [--update-base] [--write]\n默认下载 DS 官方目录，用已保存公共底座补全并显示差异，不刷新底座。\n--update-base 从锁定 CLI 内置目录按原始顺序提取第一个模型作为底座，并用已保存 DS 原始目录重新补全，不下载 DS。\n两种操作默认只对比；--write 在校验后保存所选更新。不会更新账户目录。");
    return;
  }
  if (args.some(arg => arg !== "--update-base" && arg !== "--write") || new Set(args).size !== args.length) {
    throw new Error("仅支持 --update-base、--write 或单独 --help；默认只对比");
  }
  const updateBase = args.includes("--update-base");
  const names = ["model-catalog-base.json", "model-catalog-deepseek-source.json", "model-catalog-deepseek.json", "model-catalog-sources.json"];
  const previous = new Map(names.map(name => [name, readOptional(join(directory, name))]));
  const saved = name => {
    const content = previous.get(name);
    if (content === undefined) throw new Error(`仓库模板缺失：${name}，请先恢复已保存快照`);
    return JSON.parse(content);
  };
  const sources = saved(names[3]);
  if (!object(sources) || !object(sources.official) || !object(sources.deepseek)) throw new Error("仓库模板来源记录无效");
  let base, source;
  if (updateBase) {
    source = saved(names[1]);
    if (sources.deepseek.sourceSha256 !== hash(previous.get(names[1]))) throw new Error("DS 原始目录与来源哈希不一致，请先检查仓库快照");
    validateCatalog(source);
  } else {
    base = saved(names[0]);
    validateCatalog(base);
    if (base.models.length !== 1) throw new Error("公共底座必须仅包含一个模型");
    if (sources.official.model !== base.models[0].slug || sources.official.sha256 !== hash(previous.get(names[0]))) throw new Error("公共底座与来源记录不一致，请先检查仓库快照");
  }
  const codexBinary = effectiveCodexBinary("codex", process.env);
  const temporary = mkdtempSync(join(tmpdir(), "codexc-template-export-"));
  let cliVersion;
  try {
    const environment = { ...process.env, CODEX_HOME: temporary };
    const run = args => {
      const invocation = resolveExecutableInvocation(codexBinary, args, environment);
      const result = spawnSync(invocation.file, invocation.args, { cwd: temporary, env: environment,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments, encoding: "utf8", timeout: 30_000,
        maxBuffer: 16 * maximumBytes, stdio: ["ignore", "pipe", "pipe"] });
      if (result.error || result.status !== 0) throw new Error("Codex 模板导出失败，请确认锁定 CLI 可运行");
      return result.stdout;
    };
    cliVersion = run(["--version"]).trim();
    const expected = JSON.parse(readFileSync(join(packageDir, "src/codex-protocol/version.json"), "utf8")).codexCli;
    if (cliVersion !== expected) throw new Error(`CLI 版本与项目基线不一致：需要 ${expected}，实际 ${cliVersion}`);
    if (updateBase) {
      const bundled = JSON.parse(run(["debug", "models", "--bundled"]));
      if (!Array.isArray(bundled.models) || bundled.models.length === 0) throw new Error("内置目录缺少第一个模型");
      base = { models: [bundled.models[0]] };
      validateCatalog(base);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const contents = new Map(previous);
  if (updateBase) {
    contents.set(names[0], encode(base));
    sources.official = { cliVersion, model: base.models[0].slug, command: "codex debug models --bundled", sha256: hash(contents.get(names[0])) };
  } else {
    const downloaded = await downloadDeepseekCatalog(globalThis.fetch);
    source = downloaded.catalog;
    validateCatalog(source);
    contents.set(names[1], encode(source));
    sources.deepseek = { url: deepseekSetupScriptUrl, scriptSha256: downloaded.sha256, sourceSha256: hash(contents.get(names[1])) };
  }
  const completed = completeDeepseek(source, base.models[0]);
  contents.set(names[2], encode(completed));
  sources.deepseek.completedSha256 = hash(contents.get(names[2]));
  contents.set(names[3], encode(sources));
  for (const [name, content] of contents) {
    if (Buffer.byteLength(content) > maximumBytes) throw new Error(`${name} 超过 2 MiB`);
    const changes = differences(previous.get(name) === undefined ? undefined : JSON.parse(previous.get(name)), JSON.parse(content));
    console.log(`${name}: ${changes.length ? changes.join("；") : "无变化"}`);
  }
  for (const catalog of [base, source, completed]) await validateModelCatalogWithCodex(catalog, process.env, codexBinary);
  console.log("三份目录已通过 Codex 加载校验。");
  if (!args.includes("--write")) { console.log(`仅对比，未写入。确认差异后使用${updateBase ? " --update-base" : ""} --write 更新。`); return; }

  const lock = join(directory, ".model-catalog-update.lock");
  writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  const written = [];
  const staging = join(directory, `.model-catalog-update-${randomUUID()}.tmp`);
  let stagingOwned = false;
  try {
    for (const name of names) if (readOptional(join(directory, name)) !== previous.get(name)) throw new Error(`对比期间文件已变化：${name}，请重新运行`);
    for (const [name, content] of contents) {
      if (content === previous.get(name)) continue;
      writeFileSync(staging, content, { flag: "wx" });
      stagingOwned = true;
      renameSync(staging, join(directory, name));
      stagingOwned = false;
      written.push(name);
    }
  } catch (error) {
    // These are repository snapshots, never live provider files. Do not overwrite concurrent edits.
    for (const name of written.reverse()) {
      const path = join(directory, name);
      if (readOptional(path) !== contents.get(name)) throw new Error(`更新中断且文件再次变化：${name}；请用 git diff 检查模板快照`, { cause: error });
      if (previous.get(name) === undefined) unlinkSync(path);
      else writeFileSync(path, previous.get(name));
    }
    throw error;
  } finally {
    if (stagingOwned) unlinkSync(staging);
    unlinkSync(lock);
  }
  console.log("仓库模板已更新；账户目录与服务未修改。请审查 git diff 后提交。");
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
