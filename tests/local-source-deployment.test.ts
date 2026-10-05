import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { deployLocalSource, packageManifest, recoverLocalSource } from "../scripts/local-source-deployment.mjs";
import type { LocalSourceDeploymentOptions, LocalSourceDeploymentRecovery, PreparedLocalSourcePackage } from "../scripts/local-source-deployment.mjs";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function hash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "codexc-local-deploy-"));
  temporaryDirectories.push(directory);
  const source = join(directory, "source");
  const runner = join(directory, "runner");
  const prefix = join(directory, "global");
  const installed = join(prefix, "lib", "node_modules", "@hegenai", "codexc");
  const database = join(directory, "business.sqlite");
  writeFileSync(database, "old database");
  for (const [target, marker] of [[source, "new"], [runner, "old"], [installed, "old"]] as const) {
    mkdirSync(join(target, "src", "codex-protocol"), { recursive: true });
    mkdirSync(join(target, "bin"), { recursive: true });
    mkdirSync(join(target, "node_modules", "fixture-private-dependency"), { recursive: true });
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "@hegenai/codexc", version: "0.160.0", type: "module", private: true, bin: { codexc: "bin/codexc.mjs" }, files: ["bin", "src", "marker.txt"], dependencies: { "fixture-private-dependency": "^1.0.0" } }));
    writeFileSync(join(target, "src", "codex-protocol", "version.json"), JSON.stringify({ codexCli: "codex-cli 0.160.0" }));
    writeFileSync(join(target, "bin", "codexc.mjs"), "#!/usr/bin/env node\n");
    writeFileSync(join(target, "marker.txt"), marker);
    writeFileSync(join(target, "node_modules", "fixture-private-dependency", "package.json"), JSON.stringify({ name: "fixture-private-dependency", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(target, "node_modules", "fixture-private-dependency", "index.js"), `module.exports = ${JSON.stringify(marker)};`);
  }
  const calls: string[] = [];
  const services = [
    { target: "app-server" as const, running: true, loaded: true, state: "active/running" },
    { target: "gateway" as const, running: true, loaded: true, state: "active/running" },
    { target: "webui" as const, running: true, loaded: true, state: "active/running" },
    { target: "model-relay" as const, running: false, loaded: true, state: "inactive/dead" },
  ];
  let databaseState: "old" | "new" | "unknown" = "old";
  let invocation = "before";
  const packageDirectories = new Map<string, string>();
  const options: LocalSourceDeploymentOptions = {
    jobDirectory: directory,
    sourceDirectory: source,
    runnerDirectory: runner,
    installedDirectory: installed,
    npmPrefix: prefix,
    platform: "linux",
    environment: { ...process.env, CODEX_BINARY: "fixture-codex" },
    executeCommand: () => "codex-cli 0.160.0\n",
    buildCandidate: () => { calls.push("build"); },
    validateContract: () => { calls.push("contract"); },
    inspectPackage: packageDirectory => {
      if (databaseState === "unknown") throw new Error("unrecognized schema");
      const isCandidate = packageDirectory === source;
      const compatible = isCandidate ? databaseState === "new" : databaseState === "old";
      return { config: { configPath: join(directory, "config.toml") }, services: { installed: true }, databases: {
        required: !compatible,
        state: { compatible, exists: true, databasePath: database, schemaVersion: databaseState === "new" ? 6 : 5 },
        metrics: { compatible: true, exists: false }, sessionDisplayCache: { compatible: true, exists: false },
      } };
    },
    inspectServices: () => services.map(service => ({ ...service })),
    inspectInvocationId: () => invocation,
    verifyServiceExecutables: () => undefined,
    serviceAction: (action, publicTarget) => {
      calls.push(`${action}:${publicTarget}`);
      const target = publicTarget === "relay" ? "model-relay" : publicTarget;
      const service = services.find(value => value.target === target);
      if (!service) throw new Error("unknown fixture service");
      service.running = action === "start";
      service.state = action === "start" ? "active/running" : "inactive/dead";
      if (target === "app-server" && action === "start") invocation = "after";
    },
    preparePackage: (_context, packageDirectory, label) => {
      calls.push(`prepare:${label}`);
      const tarball = join(directory, `${label}.tgz`);
      const manifestPath = join(directory, `${label}.manifest.json`);
      writeFileSync(tarball, label);
      const manifest = packageManifest(packageDirectory);
      writeFileSync(manifestPath, JSON.stringify(manifest));
      packageDirectories.set(tarball, packageDirectory);
      return { tarball, manifestPath, sha256: hash(label), manifestSha256: hash(JSON.stringify(manifest)), version: "0.160.0" };
    },
    installPackage: prepared => {
      calls.push(`install:${readFileSync(prepared.tarball, "utf8")}`);
      const packageDirectory = packageDirectories.get(prepared.tarball);
      if (!packageDirectory) throw new Error("missing prepared fixture");
      rmSync(installed, { recursive: true, force: true });
      cpSync(packageDirectory, installed, { recursive: true });
    },
    applyDatabases: () => {
      calls.push("migrate");
      const backupPath = `${database}.v5-backup-fixture`;
      cpSync(database, backupPath);
      writeFileSync(database, "new database");
      databaseState = "new";
      return { backupPath };
    },
  };
  return { directory, source, runner, installed, database, calls, services, options, setDatabaseState: (value: typeof databaseState) => { databaseState = value; } };
}

function recovery(error: unknown): LocalSourceDeploymentRecovery {
  return (error as Error & { localDeploymentFailure: { recovery: LocalSourceDeploymentRecovery } }).localDeploymentFailure.recovery;
}

describe("本机源码后台部署", () => {
  it("hashes complete files across multiple one-MiB chunks and the final partial chunk", () => {
    const test = fixture();
    const content = Buffer.alloc(2 * 1024 * 1024 + 37, 0x67);
    content[1024 * 1024 - 1] = 0x41;
    content[1024 * 1024] = 0x42;
    content[2 * 1024 * 1024] = 0x43;
    content[content.length - 1] = 0x44;
    writeFileSync(join(test.installed, "large-artifact.bin"), content);
    const entry = packageManifest(test.installed).find(value => value.path === "large-artifact.bin");
    expect(entry).toMatchObject({ kind: "file", sha256: hash(content) });
  });

  it("prepares both complete packages before stopping and restores only running targets including WebUI", async () => {
    const test = fixture();
    const result = await deployLocalSource(test.options);
    expect(test.calls).toEqual(["build", "contract", "prepare:previous", "prepare:candidate", "stop:webui", "stop:relay", "stop:gateway", "stop:app-server", "install:candidate", "migrate", "start:app-server", "start:gateway", "start:webui"]);
    expect(result.backupPaths).toEqual([`${test.database}.v5-backup-fixture`]);
    expect(readFileSync(join(test.installed, "marker.txt"), "utf8")).toBe("new");
    expect(result.restoredServices).toEqual(["app-server", "gateway", "webui"]);
    const before = [...test.calls];
    expect((await recoverLocalSource(test.options)).recovery?.status).toBe("not-needed");
    expect(test.calls).toEqual(before);
  });

  it("awaits receipt persistence before stop and aborts on persistence failure", async () => {
    const test = fixture();
    test.options.onProgress = async (stage, details) => {
      await Promise.resolve();
      if (stage === "stop-services" && details.status === "started") throw new Error("receipt write failed");
    };
    const error: unknown = await deployLocalSource(test.options).catch(value => value);
    expect((error as Error).message).toContain("receipt write failed");
    expect(recovery(error).status).toBe("not-needed");
    expect(test.calls.some(call => call.startsWith("stop:"))).toBe(false);
    expect(test.services.every(service => service.target === "model-relay" || service.running)).toBe(true);
  });

  it.each(["version", "build", "contract", "prepare"])("does not interrupt services on %s preflight failure", async scenario => {
    const test = fixture();
    if (scenario === "version") test.options.executeCommand = () => "codex-cli 0.159.0\n";
    if (scenario === "build") test.options.buildCandidate = () => { throw new Error("build failed"); };
    if (scenario === "contract") test.options.validateContract = () => { throw new Error("contract failed"); };
    if (scenario === "prepare") test.options.preparePackage = () => { throw new Error("offline package failed"); };
    await expect(deployLocalSource(test.options)).rejects.toThrow();
    expect(test.calls.some(call => call.startsWith("stop:") || call.startsWith("install:"))).toBe(false);
  });

  it("finishes independent stop attempts and restores the unchanged original after stop failure", async () => {
    const test = fixture();
    const original = test.options.serviceAction!;
    test.options.serviceAction = (...args) => {
      if (args[0] === "stop" && args[1] === "webui") { test.calls.push("stop:webui"); throw new Error("webui stop failed"); }
      return original(...args);
    };
    const error: unknown = await deployLocalSource(test.options).catch(value => value);
    expect(recovery(error).status).toBe("restored");
    expect(test.calls).toContain("stop:app-server");
    expect(test.calls.some(call => call.startsWith("install:"))).toBe(false);
    expect(test.services.find(service => service.target === "webui")?.running).toBe(true);
  });

  it("restores the prepared old package after interrupted installation with proved unchanged old databases", async () => {
    const test = fixture();
    const install = test.options.installPackage!;
    test.options.installPackage = (...args) => {
      if (readFileSync(args[0].tarball, "utf8") === "candidate") { rmSync(test.installed, { recursive: true }); throw new Error("npm install interrupted"); }
      return install(...args);
    };
    const error: unknown = await deployLocalSource(test.options).catch(value => value);
    expect(recovery(error)).toMatchObject({ status: "restored", package: "previous" });
    expect(test.calls).toContain("install:previous");
    expect(test.calls).not.toContain("migrate");
    expect(readFileSync(test.database, "utf8")).toBe("old database");
  });

  it("keeps a complete new package when migration completes but reports an error", async () => {
    const test = fixture();
    const migrate = test.options.applyDatabases!;
    test.options.applyDatabases = async (...args) => { await migrate(...args); throw new Error("post-migration failure"); };
    const error: unknown = await deployLocalSource(test.options).catch(value => value);
    expect(recovery(error)).toMatchObject({ status: "restored", package: "candidate" });
    expect(test.calls).not.toContain("install:previous");
    expect(readFileSync(test.database, "utf8")).toBe("new database");
    expect((error as Error & { localDeploymentFailure: { backupPaths: string[] } }).localDeploymentFailure.backupPaths).toEqual([`${test.database}.v5-backup-fixture`]);
  });

  it("does not restore old databases or start writers after an unproved partial migration", async () => {
    const test = fixture();
    test.options.applyDatabases = () => { writeFileSync(test.database, "partial changes with old schema"); throw new Error("partial migration failed"); };
    const error: unknown = await deployLocalSource(test.options).catch(value => value);
    expect(recovery(error).status).toBe("stopped");
    expect(test.calls.some(call => call.startsWith("start:"))).toBe(false);
    expect(readFileSync(test.database, "utf8")).toBe("partial changes with old schema");
    await expect(recoverLocalSource(test.options)).rejects.toThrow("恢复未完成");
  });

  it("detects dependency tampering anywhere in the complete installation manifest", async () => {
    const test = fixture();
    const install = test.options.installPackage!;
    test.options.installPackage = async (...args) => {
      await install(...args);
      if (readFileSync(args[0].tarball, "utf8") === "candidate") writeFileSync(join(test.installed, "node_modules", "fixture-private-dependency", "index.js"), "tampered");
    };
    const error: unknown = await deployLocalSource(test.options).catch(value => value);
    expect((error as Error).message).toContain("完整安装内容");
    expect(recovery(error)).toMatchObject({ status: "restored", package: "previous" });
    expect(test.calls).not.toContain("migrate");
  });

  it("attempts independent service restoration even if one service cannot start", async () => {
    const test = fixture();
    const action = test.options.serviceAction!;
    test.options.serviceAction = (...args) => {
      if (args[0] === "start" && args[1] === "gateway") { test.calls.push("start:gateway"); throw new Error("gateway start failed"); }
      return action(...args);
    };
    const error: unknown = await deployLocalSource(test.options).catch(value => value);
    expect(recovery(error).status).toBe("failed");
    expect(test.calls).toContain("start:webui");
    expect(recovery(error).errors.join(" ")).toContain("gateway start failed");
  });

  it("rejects success when App Server InvocationID did not change", async () => {
    const test = fixture();
    test.options.inspectInvocationId = () => "unchanged";
    const error: unknown = await deployLocalSource(test.options).catch(value => value);
    expect((error as Error).message).toContain("InvocationID");
    expect(recovery(error).status).toBe("restored");
  });

  it("recovers a crashed worker from durable state after all services stopped", async () => {
    const test = fixture();
    await deployLocalSource(test.options);
    const path = join(test.directory, "deployment-state.json");
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    state.completed = false;
    state.stage = "upgrade-databases";
    writeFileSync(path, JSON.stringify(state));
    for (const service of test.services) { service.running = false; service.state = "inactive/dead"; }
    const result = await recoverLocalSource(test.options);
    expect(result.recovery).toMatchObject({ status: "restored", package: "candidate" });
    expect(test.services.find(service => service.target === "webui")?.running).toBe(true);
    expect(readFileSync(test.database, "utf8")).toBe("new database");
  });

  it("rejects unsupported platforms and mismatched npm targets before invoking commands", async () => {
    const test = fixture();
    await expect(deployLocalSource({ ...test.options, platform: "darwin" })).rejects.toThrow("Linux/systemd");
    await expect(deployLocalSource({ ...test.options, installedDirectory: join(test.directory, "wrong") })).rejects.toThrow("npm 全局目录不一致");
    expect(test.calls).toEqual([]);
  });

  it("validates each loaded systemd service against the exact installed CLI and Node.js executable", async () => {
    const test = fixture();
    delete test.options.verifyServiceExecutables;
    const entryByTarget: Record<string, string> = { "app-server": "service-app-server", gateway: "gateway", "model-relay": "service-model-relay", webui: "webui" };
    test.options.executeCommand = (command, args) => {
      if (command === "fixture-codex") return "codex-cli 0.160.0\n";
      const target = args[2]?.slice("codex-connect-".length, -".service".length) ?? "";
      return `{ path=${process.execPath} ; argv[]=${process.execPath} --disable-warning=ExperimentalWarning ${join(test.installed, "bin", "codexc.mjs")} ${entryByTarget[target]} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n`;
    };
    await expect(deployLocalSource(test.options)).resolves.toHaveProperty("version", "0.160.0");
  });

  it.each(["gateway", "app-server", "webui", "model-relay"])("rejects a %s service running from a different installation before stopping", async target => {
    const test = fixture();
    delete test.options.verifyServiceExecutables;
    const entryByTarget: Record<string, string> = { "app-server": "service-app-server", gateway: "gateway", "model-relay": "service-model-relay", webui: "webui" };
    test.options.executeCommand = (command, args) => {
      if (command === "fixture-codex") return "codex-cli 0.160.0\n";
      const current = args[2]?.slice("codex-connect-".length, -".service".length) ?? "";
      const installed = current === target ? test.source : test.installed;
      return `{ path=${process.execPath} ; argv[]=${process.execPath} --disable-warning=ExperimentalWarning ${join(installed, "bin", "codexc.mjs")} ${entryByTarget[current]} ; ignore_errors=no ; start_time=[n/a] ; pid=0 }\n`;
    };
    await expect(deployLocalSource(test.options)).rejects.toThrow("ExecStart");
    expect(test.calls.some(call => call.startsWith("stop:"))).toBe(false);
  });

  it("stops partially restored services before repairing a corrupted candidate installation", async () => {
    const test = fixture();
    await deployLocalSource(test.options);
    const path = join(test.directory, "deployment-state.json");
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    state.completed = false;
    writeFileSync(path, JSON.stringify(state));
    writeFileSync(join(test.installed, "marker.txt"), "corrupted");
    const install = test.options.installPackage!;
    test.options.installPackage = (...args) => {
      expect(test.services.some(service => service.running)).toBe(false);
      return install(...args);
    };
    const result = await recoverLocalSource(test.options);
    expect(result.recovery).toMatchObject({ status: "restored", package: "candidate" });
    expect(readFileSync(join(test.installed, "marker.txt"), "utf8")).toBe("new");
  });

  it("provides only controlled CLI-version or stage summaries for worker logs", async () => {
    const test = fixture();
    test.options.executeCommand = () => "codex-cli 0.159.0\n";
    const error: unknown = await deployLocalSource(test.options).catch(value => value);
    expect((error as Error & { localDeploymentFailure: { summary: string } }).localDeploymentFailure.summary).toBe("Codex CLI 版本不匹配：需要 0.160.0，当前 0.159.0");
  });

  it("executes candidate-owned inspection and migration in real isolated Node.js processes", async () => {
    const test = fixture();
    delete test.options.inspectPackage;
    delete test.options.applyDatabases;
    test.options.environment = { ...test.options.environment, FIXTURE_DATABASE: test.database };
    for (const [directory, expected] of [[test.source, "new database"], [test.runner, "old database"]] as const) {
      mkdirSync(join(directory, "scripts"));
      writeFileSync(join(directory, "scripts", "local-installation.mjs"), `import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
export function inspectGatewayConfiguration() { return { configPath: 'fixture-config' }; }
export function inspectCoreServiceInstallation() { return { installed: true }; }
export function inspectDatabaseUpdates(environment) { const compatible = readFileSync(environment.FIXTURE_DATABASE, 'utf8') === ${JSON.stringify(expected)}; return { required: !compatible, state: { exists: true, compatible, databasePath: environment.FIXTURE_DATABASE }, metrics: { exists: false, compatible: true }, sessionDisplayCache: { exists: false, compatible: true } }; }
export function applyDatabaseUpdates(environment) { const backupPath = environment.FIXTURE_DATABASE + '.migration.bak'; copyFileSync(environment.FIXTURE_DATABASE, backupPath); writeFileSync(environment.FIXTURE_DATABASE, 'new database'); console.log('fixture migration diagnostic'); return { backupPath }; }
`);
    }
    test.options.executeCommand = (command, args, commandOptions) => command === "fixture-codex" ? "codex-cli 0.160.0\n" : execFileSync(command, args, { cwd: commandOptions.cwd, env: commandOptions.environment, encoding: "utf8", timeout: 30_000 });
    const result = await deployLocalSource(test.options);
    expect(result.backupPaths).toEqual([`${test.database}.migration.bak`]);
    expect(readFileSync(test.database, "utf8")).toBe("new database");
  });

  it("bundles exact production dependencies and installs both prepared packages offline in disposable prefixes", async () => {
    const test = fixture();
    delete test.options.preparePackage;
    delete test.options.installPackage;
    const commands: string[][] = [];
    test.options.executeCommand = (command, args, commandOptions) => {
      if (command === "fixture-codex") return "codex-cli 0.160.0\n";
      commands.push([command, ...args]);
      return execFileSync(command, args, { cwd: commandOptions.cwd, env: commandOptions.environment, encoding: "utf8", timeout: 30_000 });
    };
    const result = await deployLocalSource(test.options);
    expect(result.packageSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(readFileSync(join(test.installed, "node_modules", "fixture-private-dependency", "index.js"), "utf8")).toContain('"new"');
    const installations = commands.filter(command => command[0] === "npm" && command[1] === "install");
    expect(installations).toHaveLength(3);
    expect(installations.every(command => command.includes("--offline") && command.includes("--ignore-scripts"))).toBe(true);
    expect(existsSync(join(test.directory, "package-previous", "prepared"))).toBe(true);
    const receipt = JSON.parse(readFileSync(join(test.directory, "deployment-state.json"), "utf8")) as { packages: { previous: PreparedLocalSourcePackage } };
    expect(readFileSync(receipt.packages.previous.manifestPath, "utf8")).toContain("node_modules/fixture-private-dependency/index.js");
    expect(dirname(receipt.packages.previous.tarball)).toBe(join(test.directory, "package-previous", "prepared"));
  }, 60_000);
});
