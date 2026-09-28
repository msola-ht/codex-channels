import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const dictionaryPath = "webui/src/lib/i18n/messages.ts";
const glossaryPath = "webui/i18n-glossary.json";

// Read dictionary literals as data. Never import or execute a PR's dictionary module.
function readDictionary(source) {
  const file = ts.createSourceFile(dictionaryPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics.length > 0) throw new Error("字典 TypeScript 语法无效");
  const locales = {};
  function flatten(node, prefix, result) {
    if (!ts.isObjectLiteralExpression(node)) throw new Error(`字典只支持对象与字符串字面量：${prefix}`);
    const names = new Set();
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)
        || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        throw new Error(`字典不支持展开、计算属性或方法：${prefix}`);
      }
      const name = property.name.text;
      if (names.has(name)) throw new Error(`重复字典键：${prefix}.${name}`);
      names.add(name);
      if (!/^[a-zA-Z0-9_]+$/u.test(name)) throw new Error(`字典键无效：${name}`);
      const key = prefix ? `${prefix}.${name}` : name;
      if (Object.hasOwn(result, key)) throw new Error(`重复字典键：${key}`);
      const value = property.initializer;
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
        if (!value.text.trim()) throw new Error(`空文案：${key}`);
        result[key] = value.text;
      } else {
        flatten(value, key, result);
      }
    }
  }
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !["zh", "en"].includes(declaration.name.text)) continue;
      const locale = declaration.name.text;
      if (Object.hasOwn(locales, locale)) throw new Error(`重复语言声明：${locale}`);
      const result = Object.create(null);
      if (!declaration.initializer) throw new Error(`缺少字典：${locale}`);
      flatten(declaration.initializer, "", result);
      locales[locale] = result;
    }
  }
  if (!locales.zh || !locales.en) throw new Error("必须声明 zh 和 en 字典");
  return locales;
}

function issuesFor({ zh, en }) {
  const issues = [];
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort().join(",");
  for (const key of Object.keys(zh).sort()) {
    if (!Object.hasOwn(en, key)) issues.push({ key, type: "missing_translation" });
    else if (placeholders(zh[key]) !== placeholders(en[key])) issues.push({ key, type: "placeholder_mismatch" });
  }
  for (const key of Object.keys(en).sort()) {
    if (!Object.hasOwn(zh, key)) issues.push({ key, type: "missing_source" });
  }
  return issues;
}

function readGlossary() {
  const glossary = JSON.parse(readFileSync(glossaryPath, "utf8"));
  if (glossary.sourceLanguage !== "zh-CN" || glossary.targetLanguage !== "en-US"
    || !Array.isArray(glossary.terms) || !Array.isArray(glossary.preserve) || !Array.isArray(glossary.rules)
    || !glossary.terms.every((term) => typeof term.source === "string" && term.source.trim()
      && typeof term.target === "string" && term.target.trim())
    || ![...glossary.preserve, ...glossary.rules].every((value) => typeof value === "string" && value.trim())) {
    throw new Error("翻译术语表结构无效");
  }
  return glossary;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
    console.log("用法：node scripts/webui-i18n.mjs --check | --base <git-ref>\n--check 校验中英文键与占位符；--base 输出相对基线的翻译任务 JSON（不调用翻译服务、不写文件）。");
    return;
  }
  if (!(args.length === 1 && args[0] === "--check") && !(args.length === 2 && args[0] === "--base")) {
    throw new Error("参数无效；使用 --help 查看用法");
  }
  const current = readDictionary(readFileSync(dictionaryPath, "utf8"));
  const glossary = readGlossary();
  const issues = issuesFor(current);
  if (args[0] === "--check") {
    if (issues.length) throw new Error(`i18n 校验失败：${JSON.stringify(issues)}`);
    console.log(`i18n 校验通过：${Object.keys(current.zh).length} 个中文源键，中英文键及占位符一致`);
    return;
  }
  const baseCommit = git(["rev-parse", "--verify", "--end-of-options", `${args[1]}^{commit}`]).trim();
  const exists = git(["ls-tree", "--name-only", baseCommit, "--", dictionaryPath]).trim() !== "";
  const previous = exists ? readDictionary(git(["show", `${baseCommit}:${dictionaryPath}`])) : { zh: Object.create(null), en: Object.create(null) };
  const entries = [];
  for (const key of [...new Set([...Object.keys(current.zh), ...Object.keys(previous.zh)])].sort()) {
    const source = current.zh[key] ?? null;
    const previousSource = previous.zh[key] ?? null;
    const translation = current.en[key] ?? null;
    const previousTranslation = previous.en[key] ?? null;
    if (source === previousSource && translation === previousTranslation && translation !== null) continue;
    const status = source === null ? "removed" : previousSource === null ? "new"
      : source !== previousSource ? "source_changed" : translation === null ? "missing_translation" : "translation_changed";
    entries.push({ key, status, source, previousSource, translation, previousTranslation,
      needsTranslation: source !== null && translation === null,
      needsReview: source !== null && (source !== previousSource || translation !== previousTranslation || translation === null) });
  }
  console.log(JSON.stringify({ baseCommit, dictionaryPath, glossary, issues, entries }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
