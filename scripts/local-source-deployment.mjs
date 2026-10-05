import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveExecutableInvocation, resolveOptionalExecutable } from "../runtime/executable.mjs";
import { serviceCommandTarget } from "../runtime/service-targets.mjs";
import { inspectManagedServiceStatus } from "./service-status.mjs";
import { assertCodexVersion, buildCheckout, codexVersion, isGatewayVersionCompatible, packageVersion, validateCodexContract } from "./source-update.mjs";

const stateFilename = "deployment-state.json";
const packageName = "@hegenai/codexc";
const stoppedStates = new Set(["inactive", "inactive/dead", "not-found", "missing", "not-loaded", "stopped", "disabled", "ready"]);
const stopOrder = ["webui", "model-relay", "gateway", "app-server"];
const startOrder = ["app-server", "gateway", "model-relay", "webui"];
const serviceEntries = { "app-server": "service-app-server", gateway: "gateway", "model-relay": "service-model-relay", webui: "webui" };

/** Execute a frozen local source deployment from a supervisor-independent worker. */
export async function deployLocalSource(options) {
  const context = deploymentContext(options);
  const state = { schemaVersion: 1, stage: "validate-candidate", stopStarted: false, migrationStarted: false, backupPaths: [], restoredServices: [] };
  if (existsSync(context.statePath)) throw new Error("本机部署执行状态已存在，拒绝重复执行；请使用恢复入口");
  try {
    await stage(context, state, "validate-candidate", async () => {
      state.version = packageVersion(context.sourceDirectory);
      state.previousVersion = packageVersion(context.runnerDirectory);
      const expected = codexVersion(context.sourceDirectory);
      if (!isGatewayVersionCompatible(state.version, expected)) throw new Error("候选 Gateway 与 Codex CLI 基础版本不匹配");
      assertCodexVersion(expected, context.environment, context.captureCommand);
    });
    await stage(context, state, "build-candidate", () => (options.buildCandidate ?? buildCheckout)(context.sourceDirectory, context.environment, {
      runCommand: context.runCommand,
    }));
    await stage(context, state, "validate-codex-contract", () => (options.validateContract ?? validateCodexContract)(context.sourceDirectory, context.environment, {
      captureCommand: context.captureCommand,
    }));
    await stage(context, state, "inspect-candidate", async () => {
      state.candidateInspection = await inspectPackage(context, context.sourceDirectory);
      state.previousInspection = await inspectPackage(context, context.runnerDirectory);
      if (!state.candidateInspection.services.installed) throw new Error("本机源码后台部署要求已完整安装 systemd 核心服务");
      state.services = await inspectServices(context);
      if (!state.services.some(service => service.target === "gateway") || !state.services.some(service => service.target === "app-server")) throw new Error("部署前核心服务状态不完整");
      await verifyServiceExecutables(context, state.services);
      for (const service of state.services) {
        if (!service.running && !stoppedStates.has(service.state)) throw new Error(`无法确认部署前 ${service.target} 的运行状态`);
      }
      if (state.services.find(service => service.target === "app-server")?.running) {
        state.appServerInvocationId = await invocationId(context);
        if (!state.appServerInvocationId) throw new Error("无法确认部署前 App Server systemd InvocationID");
      }
    });
    await stage(context, state, "prepare-packages", async () => {
      state.packages = {};
      for (const [label, directory] of [["previous", context.runnerDirectory], ["candidate", context.sourceDirectory]]) {
        const prepared = await (options.preparePackage ?? preparePackage)(context, directory, label);
        assertPreparedPackage(context, prepared);
        state.packages[label] = prepared;
      }
      state.originalInstallationSha256 = hashJson(packageManifest(context.installedDirectory));
      state.databasePaths = [...new Set([...databasePaths(state.previousInspection.databases), ...databasePaths(state.candidateInspection.databases)])].sort();
    });
    // The durable state and caller's receipt must both succeed before any stop.
    await stage(context, state, "stop-services", async () => {
      state.stopStarted = true;
      saveState(context, state);
      await stopServices(context, state);
      state.stoppedDatabaseFingerprint = fingerprintPaths(state.databasePaths);
    });
    await stage(context, state, "install-package", async () => {
      state.installStarted = true;
      saveState(context, state);
      await installPackage(context, state.packages.candidate);
      assertInstalledPackage(context, state.packages.candidate);
    });
    await stage(context, state, "upgrade-databases", async () => {
      state.migrationStarted = true;
      saveState(context, state);
      const before = backupFiles(state.candidateInspection.databases);
      try {
        const migration = await applyDatabases(context);
        state.backupPaths = [...new Set([...state.backupPaths, ...resultBackupPaths(migration)])];
      } finally {
        state.backupPaths = [...new Set([...state.backupPaths, ...backupFiles(state.candidateInspection.databases).filter(path => !before.includes(path))])];
        saveState(context, state);
      }
      const inspection = await inspectPackage(context, context.sourceDirectory);
      if (!databasesReady(inspection.databases)) throw new Error("候选数据库升级后结构尚未就绪；保持服务停止");
      state.databaseUpdatesCompleted = true;
    });
    await stage(context, state, "restore-services", () => restoreServices(context, state, context.installedDirectory));
    await stage(context, state, "verify-deployment", async () => {
      assertInstalledPackage(context, state.packages.candidate);
      await verifyServices(context, state, true);
    });
    state.completed = true;
    saveState(context, state);
    return deploymentResult(state);
  } catch (error) {
    let recovery = { status: "not-needed", restoredServices: [], errors: [] };
    if (state.stopStarted) {
      try {
        recovery = await recoverState(context, state);
      } catch (recoveryError) {
        recovery = { status: "failed", restoredServices: [...state.restoredServices], errors: [message(recoveryError)] };
      }
    }
    throw failure(error, state, recovery);
  }
}

/** Recover only package/database combinations proved compatible, without database rollback. */
export async function recoverLocalSource(options) {
  const context = deploymentContext(options);
  if (!existsSync(context.statePath)) return { recovery: { status: "not-needed", restoredServices: [], errors: [] }, backupPaths: [] };
  const state = JSON.parse(readFileSync(context.statePath, "utf8"));
  if (state.schemaVersion !== 1 || !Array.isArray(state.backupPaths) || !Array.isArray(state.restoredServices)) throw new Error("本机部署恢复状态格式不受支持");
  if (!state.stopStarted || state.completed) return { ...deploymentResult(state), recovery: { status: "not-needed", restoredServices: [...state.restoredServices], errors: [] } };
  const recovery = await recoverState(context, state);
  if (recovery.status === "failed" || recovery.status === "stopped") throw failure(new Error("本机部署恢复未完成"), state, recovery);
  return { ...deploymentResult(state), recovery };
}

function deploymentContext(options) {
  if ((options.platform ?? process.platform) !== "linux") throw new Error("本机源码后台部署仅支持 Linux/systemd");
  const nodeBinary = options.nodeBinary ?? process.execPath;
  const environment = { ...(options.environment ?? process.env) };
  environment.PATH = `${dirname(nodeBinary)}:${environment.PATH ?? ""}`;
  const context = {
    ...options,
    jobDirectory: resolve(options.jobDirectory),
    sourceDirectory: resolve(options.sourceDirectory),
    runnerDirectory: resolve(options.runnerDirectory),
    installedDirectory: resolve(options.installedDirectory),
    npmPrefix: resolve(options.npmPrefix),
    nodeBinary,
    environment,
  };
  if (context.installedDirectory !== join(context.npmPrefix, "lib", "node_modules", packageName)) throw new Error("本机部署目标与指定 npm 全局目录不一致");
  context.statePath = join(context.jobDirectory, stateFilename);
  context.cacheDirectory = join(context.jobDirectory, "npm-cache");
  mkdirSync(context.cacheDirectory, { recursive: true, mode: 0o700 });
  environment.npm_config_cache = context.cacheDirectory;
  environment.npm_config_update_notifier = "false";
  context.captureCommand = (command, args, commandOptions) => execute(context, command, args, commandOptions);
  context.runCommand = (command, args, commandOptions) => { execute(context, command, args, commandOptions); };
  return context;
}

function execute(context, command, args, options = {}) {
  if (context.executeCommand) return context.executeCommand(command, args, { cwd: options.cwd ?? context.jobDirectory, environment: context.environment, timeoutMs: options.timeoutMs ?? 300_000 });
  let actualCommand = command;
  let actualArgs = args;
  if (command === "npm") {
    const npm = resolveOptionalExecutable("npm", context.environment);
    if (!npm) throw new Error("无法找到当前 Node.js 环境中的 npm");
    actualCommand = context.nodeBinary;
    actualArgs = [realpathSync(npm), ...args];
  } else if (command === process.execPath) {
    actualCommand = context.nodeBinary;
  }
  const invocation = resolveExecutableInvocation(actualCommand, actualArgs, context.environment);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: options.cwd ?? context.jobDirectory,
    env: context.environment,
    encoding: "utf8",
    timeout: options.timeoutMs ?? (args.includes("ci") || args.includes("build") || args.includes("check") ? 1_200_000 : 300_000),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${basename(command)} 执行失败：exit=${result.status ?? "signal"}`);
  }
  return result.stdout;
}

async function stage(context, state, name, action) {
  state.stage = name;
  saveState(context, state);
  await context.onProgress?.(name, { status: "started", ...progressDetails(state) });
  const result = await action();
  saveState(context, state);
  await context.onProgress?.(name, { status: "completed", ...progressDetails(state) });
  return result;
}

function saveState(context, state) {
  writeJson(context.statePath, state);
}

function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(file, `${JSON.stringify(value)}\n`);
    fsyncSync(file);
  } finally { closeSync(file); }
  renameSync(temporary, path);
  const parent = openSync(dirname(path), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

function progressDetails(state) {
  return { version: state.version, previousVersion: state.previousVersion, backupPaths: [...state.backupPaths], restoredServices: [...state.restoredServices] };
}

async function inspectPackage(context, directory) {
  if (context.inspectPackage) return context.inspectPackage(directory, context.environment);
  return childModule(context, directory, "local-installation.mjs", "const config = candidate.inspectGatewayConfiguration(process.env); const databases = candidate.inspectDatabaseUpdates(process.env); const services = candidate.inspectCoreServiceInstallation(process.env, 'linux'); return { config, databases, services };");
}

function childModule(context, directory, script, body) {
  const marker = "CODEXC_DEPLOYMENT_RESULT=";
  const output = execute(context, context.nodeBinary, [
    "--input-type=module", "--eval",
    `const candidate = await import(process.argv[1]); const result = await (async () => { ${body} })(); process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(result ?? null) + '\\n');`,
    pathToFileURL(join(directory, "scripts", script)).href,
  ], { cwd: directory });
  const line = output.split(/\r?\n/u).findLast(value => value.startsWith(marker));
  if (!line) throw new Error("候选部署入口未返回结构化结果");
  return JSON.parse(line.slice(marker.length));
}

async function applyDatabases(context) {
  if (context.applyDatabases) return context.applyDatabases(context.sourceDirectory, context.environment);
  return childModule(context, context.sourceDirectory, "local-installation.mjs", "return await candidate.applyDatabaseUpdates(process.env);");
}

async function inspectServices(context) {
  if (context.inspectServices) return context.inspectServices(context.environment);
  const run = (command, args, options) => spawnSync(command, args, { ...options, timeout: 30_000 });
  const shared = { environment: context.environment, platform: "linux", run };
  return [...inspectManagedServiceStatus({ ...shared, target: "all" }).services, ...inspectManagedServiceStatus({ ...shared, target: "webui" }).services];
}

async function invocationId(context) {
  if (context.inspectInvocationId) return context.inspectInvocationId(context.environment);
  const value = execute(context, context.environment.SYSTEMCTL_BINARY?.trim() || "systemctl", ["--user", "show", "codex-connect-app-server.service", "--property=InvocationID", "--value", "--no-pager"], { timeoutMs: 30_000 }).trim();
  if (!/^[0-9a-f]{32}$/u.test(value)) throw new Error("App Server InvocationID 无效");
  return value;
}

async function verifyServiceExecutables(context, services) {
  if (context.verifyServiceExecutables) return context.verifyServiceExecutables(services, context.installedDirectory, context.nodeBinary, context.environment);
  for (const service of services.filter(value => value.loaded)) {
    const identifier = service.target === "model-relay" ? "codex-connect-model-relay.service" : `codex-connect-${service.target}.service`;
    const output = execute(context, context.environment.SYSTEMCTL_BINARY?.trim() || "systemctl", ["--user", "show", identifier, "--property=ExecStart", "--value", "--no-pager"], { timeoutMs: 30_000 }).trim();
    const match = /^\{ path=([^;]+?) ; argv\[\]=(.*?) ; ignore_errors=(?:yes|no) ;[^{}]*\}$/u.exec(output);
    const executable = match?.[1];
    const expectedArguments = executable ? `${executable} --disable-warning=ExperimentalWarning ${join(context.installedDirectory, "bin", "codexc.mjs")} ${serviceEntries[service.target]}` : undefined;
    if (!executable || realpathSync(executable) !== realpathSync(context.nodeBinary) || match?.[2] !== expectedArguments) throw new Error(`${service.target} systemd ExecStart 与部署 Node.js 和全局 Gateway 入口不一致`);
  }
}

async function serviceAction(context, directory, action, target) {
  if (context.serviceAction) return context.serviceAction(action, serviceCommandTarget(target), directory, context.environment);
  execute(context, context.nodeBinary, [join(directory, "bin", "codexc.mjs"), "service", action, serviceCommandTarget(target)], { cwd: directory });
}

async function stopServices(context, state) {
  const errors = [];
  for (const target of stopOrder) {
    const previous = state.services.find(service => service.target === target);
    if (!previous?.loaded && !previous?.running) continue;
    try { await serviceAction(context, context.runnerDirectory, "stop", target); } catch (error) { errors.push(error); }
  }
  try {
    const current = await inspectServices(context);
    if (current.some(service => service.running || !stoppedStates.has(service.state))) errors.push(new Error("无法确认全部部署服务已停止"));
  } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "部署服务停止失败");
}

async function restoreServices(context, state, directory) {
  const errors = [];
  state.restoredServices = [];
  for (const target of startOrder) {
    if (!state.services.find(service => service.target === target)?.running) continue;
    try {
      // The canonical CLI start performs core and enabled-Relay readiness checks.
      await serviceAction(context, directory, "start", target);
      state.restoredServices.push(target);
      saveState(context, state);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "部分部署服务未能恢复", { cause: errors[0] });
}

async function verifyServices(context, state, requireRestart = false) {
  const current = await inspectServices(context);
  const errors = [];
  for (const previous of state.services.filter(service => service.running)) {
    if (!current.find(service => service.target === previous.target)?.running) errors.push(new Error(`${previous.target} 未恢复运行`));
  }
  if (requireRestart && state.appServerInvocationId) {
    try {
      const currentInvocation = await invocationId(context);
      if (!currentInvocation || currentInvocation === state.appServerInvocationId) errors.push(new Error("App Server InvocationID 未改变，未证实完整重启"));
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "部署服务最终验证失败");
}

function pack(context, directory, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const report = JSON.parse(execute(context, "npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], { cwd: directory }));
  const filename = Array.isArray(report) && report.length === 1 ? report[0]?.filename : undefined;
  if (typeof filename !== "string" || basename(filename) !== filename || !filename.endsWith(".tgz")) throw new Error("npm pack 未返回唯一且安全的包名");
  return join(destination, filename);
}

function preparePackage(context, directory, label) {
  const work = join(context.jobDirectory, `package-${label}`);
  const raw = pack(context, directory, join(work, "raw"));
  const expanded = join(work, "expanded");
  mkdirSync(expanded, { recursive: true, mode: 0o700 });
  execute(context, "tar", ["-xzf", raw, "-C", expanded]);
  const expandedPackage = join(expanded, "package");
  const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (metadata.name !== packageName) throw new Error("部署包名称与 Gateway 不一致");
  const dependencies = Object.keys(metadata.dependencies ?? {});
  if (dependencies.length) {
    if (!existsSync(join(directory, "node_modules"))) throw new Error("部署包缺少已准备的完整依赖");
    execute(context, "cp", ["-a", "--", join(directory, "node_modules"), join(expandedPackage, "node_modules")]);
  }
  // npm creates bundle metadata; source and immutable runner remain unchanged.
  execute(context, "npm", ["pkg", "set", `bundleDependencies=${JSON.stringify(dependencies)}`, "--json"], { cwd: expandedPackage });
  const tarball = pack(context, expandedPackage, join(work, "prepared"));
  const prefix = join(work, "installation");
  installTarball(context, tarball, prefix);
  const installed = join(prefix, "lib", "node_modules", packageName);
  const manifestPath = join(work, "package-manifest.json");
  const manifest = packageManifest(installed);
  writeJson(manifestPath, manifest);
  return { tarball, sha256: hashFile(tarball), manifestPath, manifestSha256: hashJson(manifest), version: metadata.version };
}

function installTarball(context, tarball, prefix) {
  execute(context, "npm", ["install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", tarball]);
}

async function installPackage(context, prepared) {
  assertPreparedPackage(context, prepared);
  if (context.installPackage) return context.installPackage(prepared, context.installedDirectory, context.environment);
  installTarball(context, prepared.tarball, context.npmPrefix);
}

function assertPreparedPackage(context, prepared) {
  for (const path of [prepared.tarball, prepared.manifestPath]) {
    const relative = resolve(path).slice(context.jobDirectory.length);
    if (!resolve(path).startsWith(`${context.jobDirectory}/`) || !relative || lstatSync(path).isSymbolicLink()) throw new Error("部署包证据不在私有任务目录内");
  }
  if (hashFile(prepared.tarball) !== prepared.sha256) throw new Error("部署 tarball SHA256 已改变");
  const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8"));
  if (hashJson(manifest) !== prepared.manifestSha256 || !Array.isArray(manifest)) throw new Error("部署完整性清单 SHA256 已改变");
}

function assertInstalledPackage(context, prepared) {
  assertPreparedPackage(context, prepared);
  if (packageVersion(context.installedDirectory) !== prepared.version || hashJson(packageManifest(context.installedDirectory)) !== prepared.manifestSha256) throw new Error("全局 Gateway 完整安装内容与预备包不一致");
  const binary = join(context.npmPrefix, "bin", "codexc");
  if (!context.installPackage && realpathSync(binary) !== join(context.installedDirectory, "bin", "codexc.mjs")) throw new Error("npm 全局 codexc 命令指向与部署包不一致");
}

export function packageManifest(directory) {
  const entries = [];
  const visit = (relative) => {
    const path = join(directory, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) entries.push({ path: relative, kind: "link", target: readlinkSync(path) });
    else if (stat.isDirectory()) {
      entries.push({ path: relative, kind: "directory" });
      for (const name of readdirSync(path).sort()) visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) entries.push({ path: relative, kind: "file", sha256: hashFile(path), executable: (stat.mode & 0o111) !== 0 });
    else throw new Error("部署包包含不受支持的文件类型");
  };
  visit("");
  return entries;
}

function hashFile(path) {
  const file = openSync(path, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = readSync(file, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, bytesRead));
    return digest.digest("hex");
  } finally { closeSync(file); }
}
function hashJson(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function databasePaths(databases) {
  const paths = [];
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (typeof value.databasePath === "string") paths.push(value.databasePath);
    for (const [key, child] of Object.entries(value)) if (key !== "databasePath" && typeof child === "object") visit(child);
  };
  visit(databases);
  return [...new Set(paths)].sort();
}

function fingerprintPaths(paths) {
  return paths.flatMap(path => [path, `${path}-wal`].map(file => ({ path: file, sha256: existsSync(file) ? hashFile(file) : null })));
}

function backupFiles(databases) {
  return databasePaths(databases).flatMap(path => existsSync(dirname(path)) ? readdirSync(dirname(path)).filter(name => name.startsWith(`${basename(path)}.`) && (name.includes("backup") || name.endsWith(".bak"))).map(name => join(dirname(path), name)) : []).sort();
}

function resultBackupPaths(result) {
  if (!result || typeof result !== "object") return [];
  return Object.entries(result).flatMap(([key, value]) => key === "backupPath" && typeof value === "string" ? [value] : value && typeof value === "object" ? resultBackupPaths(value) : []);
}

function databasesReady(databases) {
  if (!databases || databases.required !== false) return false;
  const visit = value => {
    if (!value || typeof value !== "object") return true;
    if (Object.hasOwn(value, "exists") && value.exists === true && value.compatible !== true) return false;
    return Object.values(value).every(child => typeof child !== "object" || visit(child));
  };
  return visit(databases);
}

async function recoverState(context, state) {
  const result = { status: "stopped", restoredServices: [], errors: [] };
  const failedStage = state.stage;
  state.recoveryAttempted = true;
  saveState(context, state);
  await context.onProgress?.("recover-deployment", { status: "started", failedStage, ...progressDetails(state) });
  let selected;
  let originalInstalled = false;
  let candidate;
  try { candidate = await inspectPackage(context, context.sourceDirectory); } catch (error) { result.errors.push(message(error)); }
  let candidateInstalled = false;
  try { assertInstalledPackage(context, state.packages.candidate); candidateInstalled = true; } catch { /* The installation may have been interrupted. */ }
  if ((candidateInstalled || state.migrationStarted) && databasesReady(candidate?.databases)) selected = "candidate";
  if (!selected) {
    try {
      const previous = await inspectPackage(context, context.runnerDirectory);
      originalInstalled = !state.installStarted && hashJson(packageManifest(context.installedDirectory)) === state.originalInstallationSha256;
      const unchanged = Array.isArray(state.stoppedDatabaseFingerprint) && Array.isArray(state.databasePaths) && hashJson(fingerprintPaths(state.databasePaths)) === hashJson(state.stoppedDatabaseFingerprint);
      if ((unchanged || originalInstalled) && databasesReady(previous.databases)) selected = "previous";
    } catch (error) { result.errors.push(message(error)); }
  }
  if (selected) {
    try {
      const prepared = state.packages[selected];
      assertPreparedPackage(context, prepared);
      let installed = selected === "previous" && originalInstalled;
      if (!installed) {
        try { assertInstalledPackage(context, prepared); installed = true; } catch { /* Restore from the immutable prepared tarball. */ }
      }
      if (!installed) {
        await stopServices(context, state);
        await installPackage(context, prepared);
        assertInstalledPackage(context, prepared);
      }
      await restoreServices(context, state, context.installedDirectory);
      await verifyServices(context, state);
      result.status = "restored";
      result.package = selected;
      result.restoredServices = [...state.restoredServices];
    } catch (error) {
      result.status = "failed";
      result.errors.push(message(error));
      result.restoredServices = [...state.restoredServices];
    }
  } else {
    // Do not allow any writers to run with an unproved package/database pairing.
    try { await stopServices(context, state); } catch (error) { result.errors.push(message(error)); }
    result.errors.push("无法证明全局包与数据库一致，服务保持停止；未还原任何业务数据库");
  }
  state.stage = failedStage;
  state.recovery = result;
  saveState(context, state);
  await context.onProgress?.("recover-deployment", { status: "completed", failedStage, recovery: result, ...progressDetails(state) });
  return result;
}

function deploymentResult(state) {
  return { version: state.version, previousVersion: state.previousVersion, packageSha256: state.packages?.candidate?.sha256, backupPaths: [...state.backupPaths], restoredServices: [...state.restoredServices] };
}

function failure(error, state, recovery) {
  const result = new Error(`本机源码部署失败（${state.stage}）：${message(error)}`, { cause: error });
  const versionMismatch = /^Codex CLI 版本不匹配：需要 (\d+\.\d+\.\d+)，当前 (\d+\.\d+\.\d+|未知)$/u.exec(message(error));
  const summary = versionMismatch ? `Codex CLI 版本不匹配：需要 ${versionMismatch[1]}，当前 ${versionMismatch[2]}` : `本机源码部署失败（${state.stage}）`;
  result.localDeploymentFailure = { stage: state.stage, summary, recovery, backupPaths: [...state.backupPaths], errors: [message(error), ...recovery.errors] };
  return result;
}

function message(error) {
  if (error instanceof AggregateError) return `${error.message}：${error.errors.map(message).join("；")}`;
  return error instanceof Error ? error.message : String(error);
}
