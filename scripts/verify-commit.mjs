import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { serviceDefinitions } from "../runtime/service-targets.mjs";
import { serviceStopTimeoutSeconds } from "../runtime/shutdown-budget.mjs";
import { changedFiles, parseChangedFiles } from "./verification-scope.mjs";

const checkTypes = { name: "类型与版本", command: "npm", args: ["run", "check"] };
const rootLint = { name: "Lint", command: "npm", args: ["run", "lint"] };
const webuiBuild = { name: "WebUI 构建", command: "npm", args: ["run", "build"], cwd: "webui" };
const webuiLint = { name: "WebUI Lint", command: "npm", args: ["run", "lint"], cwd: "webui" };
const dictionary = { name: "WebUI 翻译字典", command: "npm", args: ["run", "i18n:check"] };
const docs = { name: "文档与索引", command: "npm", args: ["run", "docs:check"] };
// Emission follows the full source type check. Standalone builds retain their
// independent type checking.
const gatewayBuild = { name: "Gateway 构建", command: "npm", args: ["run", "build", "--", "--noCheck"] };
const shell = ["install.sh", "scripts/launchd-control.sh", "scripts/systemd-control.sh"]
  .map(path => ({ name: `Shell 语法 ${path}`, command: "bash", args: ["-n", path] }));
const templates = serviceDefinitions.map(service => ({
  name: `launchd 模板 ${service.target}`, command: "plutil", args: ["-lint", "--", "-"],
  templatePath: `launchd/${service.launchd}.plist.template`,
}));

export function createVerificationPlan(changes, { ci = false, root = process.cwd(), platform = process.platform } = {}) {
  if (ci) return { reason: "PR 静态检查与构建", checks: [
    checkTypes, rootLint, webuiBuild, webuiLint, dictionary, docs, gatewayBuild,
    ...(platform === "win32" ? [] : shell), ...(platform === "darwin" ? templates : []),
  ] };

  const paths = changes.map(change => change.path);
  const code = paths.filter(path => !path.endsWith(".md"));
  const lintFiles = code.filter(path => /^(?:src|bin|runtime|scripts)\/.*\.(?:ts|mjs)$/u.test(path)
    && !path.startsWith("src/codex-protocol/generated/") && existsSync(join(root, path)));
  const checks = code.length ? [checkTypes] : [];
  const fullLint = code.some(path => /^(?:package(?:-lock)?\.json|eslint\.config\.mjs)$/u.test(path));
  if (fullLint) checks.push(rootLint);
  else if (lintFiles.length) checks.push({ name: "变更文件 Lint", command: process.execPath,
    args: ["node_modules/eslint/bin/eslint.js", ...lintFiles] });
  if (paths.some(path => path.endsWith(".md")) || code.some(path => /^(?:src|scripts|bin|runtime|\.github)\//u.test(path))) checks.push(docs);
  const webui = code.some(path => path.startsWith("webui/"));
  const sharedBuild = code.some(path => /^(?:package(?:-lock)?\.json|tsconfig(?:\.build)?\.json|scripts\/(?:verify-commit|verification-scope|prepare-package)\.mjs)$/u.test(path));
  const sharedInputs = !webui && !sharedBuild && code.length > 0 ? webuiInputFiles(root) : new Set();
  const webuiShared = code.some(path => sharedInputs.has(path));
  if (webui || webuiShared || sharedBuild) checks.push(webuiBuild, webuiLint, dictionary);
  else if (code.includes("scripts/webui-i18n.mjs")) checks.push(dictionary);
  if (code.some(path => /\.(?:sh|ps1)$/u.test(path) || /^(?:launchd|systemd)\//u.test(path)
    || /^(?:runtime\/(?:shutdown-budget|service-targets)|scripts\/(?:service-install-management|verify-commit))\.mjs$/u.test(path))) {
    if (platform !== "win32") checks.push(...shell);
    if (platform === "darwin") checks.push(...templates);
  }

  const reason = code.length ? "按变更范围执行静态检查与构建" : "仅文档变更，检查文档与索引";
  if (code.length) {
    checks.push(gatewayBuild);
  }
  return { reason, checks };
}

function webuiInputFiles(root) {
  const inputs = new Set();
  const configurations = new Set();
  visitConfiguration(join(root, "webui/tsconfig.json"));
  return inputs;

  function visitConfiguration(path) {
    if (configurations.has(path)) return;
    configurations.add(path);
    const config = ts.getParsedCommandLineOfConfigFile(path, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
    });
    if (config.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(config.errors, {
      getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => "\n",
    }));
    for (const file of config.fileNames) visitSource(file, config.options);
    for (const reference of config.projectReferences ?? []) visitConfiguration(ts.resolveProjectReferencePath(reference));
  }

  function visitSource(file, options) {
    const path = relative(root, file).replaceAll("\\", "/");
    if (isAbsolute(path) || path.startsWith("../") || path.split("/").includes("node_modules") || inputs.has(path)) return;
    inputs.add(path);
    if (!/\.(?:[cm]?ts|tsx|[cm]?js)$/u.test(file)) return;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
    visit(source);

    function visit(node) {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined;
      if (specifier && ts.isStringLiteralLike(specifier)
        && (specifier.text.startsWith(".") || specifier.text.startsWith("@/"))) {
        const resolved = ts.resolveModuleName(specifier.text, file, options, ts.sys).resolvedModule;
        const asset = resolve(dirname(file), specifier.text);
        if (!resolved && !(specifier.text.startsWith(".") && existsSync(asset))) {
          throw new Error(`无法确定 WebUI 依赖：${path} -> ${specifier.text}`);
        }
        visitSource(resolved?.resolvedFileName ?? asset, options);
        // Declaration resolution alone cannot observe changes to browser-loaded JS.
        const typeOnly = source.isDeclarationFile || ts.isImportTypeNode(node)
          || (ts.isImportDeclaration(node) && (node.importClause?.isTypeOnly
            || (!node.importClause?.name && node.importClause?.namedBindings
              && ts.isNamedImports(node.importClause.namedBindings)
              && node.importClause.namedBindings.elements.length > 0
              && node.importClause.namedBindings.elements.every(element => element.isTypeOnly))))
          || (ts.isExportDeclaration(node) && (node.isTypeOnly
            || (node.exportClause && ts.isNamedExports(node.exportClause)
              && node.exportClause.elements.length > 0
              && node.exportClause.elements.every(element => element.isTypeOnly))));
        if (!typeOnly && /\.mjs$/u.test(specifier.text)) {
          const implementation = resolve(dirname(file), specifier.text);
          if (!existsSync(implementation)) throw new Error(`WebUI 运行时依赖不存在：${path} -> ${specifier.text}`);
          visitSource(implementation, options);
        }
      }
      ts.forEachChild(node, visit);
    }
  }
}

function runChecks(checks) {
  const verificationStartedAt = performance.now();
  for (const check of checks) {
    console.log(`\n[提交检查] ${check.name}`);
    const checkStartedAt = performance.now();
    const invocation = resolveExecutableInvocation(check.command, check.args);
    const result = spawnSync(invocation.file, invocation.args, {
      cwd: check.cwd === undefined ? process.cwd() : join(process.cwd(), check.cwd),
      env: { ...process.env, ...check.environment },
      stdio: check.templatePath ? ["pipe", "inherit", "inherit"] : "inherit",
      ...(check.templatePath ? { input: readFileSync(check.templatePath, "utf8")
        .replaceAll("__STOP_TIMEOUT_SECONDS__", String(serviceStopTimeoutSeconds)) } : {}),
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const checkDuration = formatDuration(performance.now() - checkStartedAt);
    const cumulativeDuration = formatDuration(performance.now() - verificationStartedAt);
    if (result.error) {
      console.error(
        `[提交检查] ${check.name} 失败（本阶段 ${checkDuration}，累计耗时 ${cumulativeDuration}）`,
      );
      throw result.error;
    }
    if (result.status !== 0) {
      console.error(
        `[提交检查] ${check.name} 失败（本阶段 ${checkDuration}，累计耗时 ${cumulativeDuration}）`,
      );
      process.exit(result.status ?? 1);
    }
    console.log(
      `[提交检查] ${check.name} 通过（本阶段 ${checkDuration}，累计耗时 ${cumulativeDuration}）`,
    );
  }
  console.log(
    `\n验证全部通过。总耗时 ${formatDuration(performance.now() - verificationStartedAt)}`,
  );
}

function main() {
  const args = process.argv.slice(2);
  const ci = args.length === 1 && args[0] === "--ci";
  const changesFile = args.length === 2 && args[0] === "--changes-file" ? args[1] : undefined;
  if (args.length && !ci && !changesFile) throw new Error("用法：verify-commit.mjs [--ci|--changes-file <path>]");
  let changes = [];
  let diffArgs = ["diff", "--check", "HEAD^", "HEAD"];
  if (!ci && changesFile) changes = parseChangedFiles(readFileSync(changesFile, "utf8"));
  else if (!ci) {
    changes = changedFiles(["--cached"]);
    diffArgs = ["diff", "--cached", "--check"];
    if (!changes.length) {
      changes = changedFiles([]);
      diffArgs = ["diff", "--check"];
      for (const path of execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)) {
        changes.push({ status: "A", path });
      }
    }
  }
  const plan = createVerificationPlan(changes, { ci });
  console.log(`[验证范围] ${plan.reason}`);
  runChecks([
    // The hook already checked the actual commit index before clearing Git env.
    ...(!changesFile ? [{ name: "Git 差异格式", command: "git", args: diffArgs }] : []),
    ...plan.checks,
  ]);
}

function formatDuration(milliseconds) {
  const seconds = milliseconds / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 2 : 1)} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${(seconds % 60).toFixed(1)} 秒`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
