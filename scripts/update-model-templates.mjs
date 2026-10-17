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

const baseModel = "gpt-6.1-sol";
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
    console.log("用法：node scripts/update-model-templates.mjs [--write]\n默认导出当前锁定 CLI 的内置 Sol 模板、下载 DS 官方目录、校验并显示字段差异；--write 更新仓库快照。不会更新账户目录。");
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--write")) throw new Error("仅支持 --write 或 --help；默认只对比");
  const names = ["model-catalog-base.json", "model-catalog-deepseek-source.json", "model-catalog-deepseek.json", "model-catalog-sources.json"];
  const previous = new Map(names.map(name => [name, readOptional(join(directory, name))]));
  const temporary = mkdtempSync(join(tmpdir(), "codexc-template-export-"));
  let base, cliVersion;
  try {
    const environment = { ...process.env, CODEX_HOME: temporary };
    const run = args => {
      const invocation = resolveExecutableInvocation(effectiveCodexBinary("codex", environment), args, environment);
      const result = spawnSync(invocation.file, invocation.args, { cwd: temporary, env: environment,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments, encoding: "utf8", timeout: 30_000,
        maxBuffer: 16 * maximumBytes, stdio: ["ignore", "pipe", "pipe"] });
      if (result.error || result.status !== 0) throw new Error("Codex 模板导出失败，请确认锁定 CLI 可运行");
      return result.stdout;
    };
    cliVersion = run(["--version"]).trim();
    const expected = JSON.parse(readFileSync(join(packageDir, "src/codex-protocol/version.json"), "utf8")).codexCli;
    if (cliVersion !== expected) throw new Error(`CLI 版本与项目基线不一致：需要 ${expected}，实际 ${cliVersion}`);
    const bundled = JSON.parse(run(["debug", "models", "--bundled"]));
    const matches = bundled.models?.filter(model => model.slug === baseModel);
    if (matches?.length !== 1) throw new Error(`内置目录必须包含唯一的 ${baseModel}`);
    base = { models: [matches[0]] };
    validateCatalog(base);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const downloaded = await downloadDeepseekCatalog(globalThis.fetch);
  validateCatalog(downloaded.catalog);
  const completed = completeDeepseek(downloaded.catalog, base.models[0]);
  const contents = new Map([
    [names[0], encode(base)], [names[1], encode(downloaded.catalog)], [names[2], encode(completed)],
  ]);
  contents.set(names[3], encode({
    official: { cliVersion, model: baseModel, command: "codex debug models --bundled", sha256: hash(contents.get(names[0])) },
    deepseek: { url: deepseekSetupScriptUrl, scriptSha256: downloaded.sha256, sourceSha256: hash(contents.get(names[1])), completedSha256: hash(contents.get(names[2])) },
  }));
  for (const [name, content] of contents) {
    if (Buffer.byteLength(content) > maximumBytes) throw new Error(`${name} 超过 2 MiB`);
    const changes = differences(previous.get(name) === undefined ? undefined : JSON.parse(previous.get(name)), JSON.parse(content));
    console.log(`${name}: ${changes.length ? changes.join("；") : "无变化"}`);
  }
  for (const catalog of [base, downloaded.catalog, completed]) await validateModelCatalogWithCodex(catalog);
  console.log("三份目录已通过 Codex 加载校验。");
  if (!args.includes("--write")) { console.log("仅对比，未写入。确认差异后使用 --write 更新。"); return; }

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
