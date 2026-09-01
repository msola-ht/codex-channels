import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync as rawMkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { stringify } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  AppServerSupervisorOwner,
  ensureAppServerProvider,
  inspectAppServerSupervisor,
  releaseAppServerProvider,
} from "../runtime/app-server-supervisor.mjs";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { gatewayOwnerIsActive, GatewayOwner } from "../runtime/gateway-owner.mjs";
import {
  deepseekProviderDefinition,
  opencodeGoProviderDefinition,
  type ModelProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import {
  writeCustomPrimaryProviderSwitchingProfile,
  writeThirdPartyModelProviderRoleConfig,
} from "../runtime/model-provider-runtime.mjs";
import {
  acknowledgeConfigEvents,
  configEventQueuePath,
  matchingWorkspaceConfigEvents,
  readConfigEvents,
} from "../runtime/config-event-queue.mjs";
import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { readWorkspaceConfig } from "../scripts/workspace-config.mjs";
import {
  modelRequestMetricsSchemaVersion,
  requestMetricsDatabasePath,
  SqliteModelRequestMetricsStore,
  type ModelRequestMetricSample,
} from "../src/observability/index.js";
import {
  EncryptedFileWeixinCredentialStore,
  EncryptedFileWeixinReplyContextPersistence,
  FileWeixinUpdatesCursorStore,
} from "../src/surfaces/weixin/index.js";
import { secureTestDirectory } from "./support/windows-fixtures.js";

const temporaryDirectories: string[] = [];
const cli = resolve("bin/codexc.mjs");
const execFileAsync = promisify(execFile);
const linuxIt = process.platform === "linux" ? it : it.skip;
const unixSocketTmpdir = process.platform === "darwin" ? "/tmp" : tmpdir();

function mkdtempSync(prefix: string): string {
  const root = rawMkdtempSync(prefix);
  if (process.platform === "win32") secureTestDirectory(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

export type CodexcCliTestShard =
  | "basics"
  | "workspace"
  | "remote"
  | "remote-profile"
  | "provider"
  | "supervision"
  | "errors"
  | "syntax"
  | "diagnostics"
  | "services"
  | "doctor";

export function registerCodexcCliTests(shard: CodexcCliTestShard): void {
  describe("codexc CLI", { timeout: 15_000 }, () => {
    if (shard === "basics") {
  it.skipIf(process.platform === "win32")("suppresses only Node experimental warnings at the executable boundary", () => {
    expect(readFileSync(cli, "utf8").split("\n", 1)[0]).toBe(
      "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning",
    );
  });

  it.skipIf(process.platform === "win32")("keeps SQLite-backed child command output free of experimental warnings", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-warning-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_CONNECT_SERVICE_ROLE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });
    const store = new SqliteModelRequestMetricsStore(
      requestMetricsDatabasePath(join(home, "data", "gateway.sqlite3")),
    );
    store.close();

    const result = spawnSync(cli, ["metrics", "status"], {
      cwd: workspace,
      encoding: "utf8",
      env: environment,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Schema：${modelRequestMetricsSchemaVersion}`);
    expect(result.stderr).toBe("");

    const jsonResult = spawnSync(cli, ["metrics", "status", "--json"], {
      cwd: workspace,
      encoding: "utf8",
      env: environment,
    });
    expect(jsonResult.status, jsonResult.stderr).toBe(0);
    expect(JSON.parse(jsonResult.stdout)).toEqual({
      databasePath: expect.any(String),
      exists: true,
      schemaVersion: modelRequestMetricsSchemaVersion,
      compatible: true,
      count: 0,
    });
    expect(jsonResult.stderr).toBe("");
  });

  it("shows scoped help for every public command without requiring configuration", async () => {
    const cases = [
      [["init", "-h"], "用法：codexc init"],
      [["setup", "--help"], "用法：codexc setup"],
      [["start", "-h"], "用法：codexc start"],
      [["remote", "-h"], "用法：codexc remote"],
      [["work", "-h"], "用法：codexc work"],
      [["work", "list", "--help"], "用法：codexc work list"],
      [["work", "add", "-h"], "用法：codexc work add"],
      [["work", "remove", "--help"], "用法：codexc work remove"],
      [["service", "-h"], "用法：codexc service"],
      [["service", "install", "-h"], "用法：codexc service install"],
      [["service", "uninstall", "--help"], "用法：codexc service uninstall"],
      [["service", "start", "-h"], "用法：codexc service start"],
      [["service", "stop", "--help"], "用法：codexc service stop"],
      [["service", "reload", "-h"], "用法：codexc service reload"],
      [["service", "restart", "-h"], "用法：codexc service restart"],
      [["service", "status", "--help"], "用法：codexc service status"],
      [["service", "logs", "--help"], "用法：codexc service logs"],
      [["config", "-h"], "用法：codexc config"],
      [["doctor", "--help"], "用法：codexc doctor"],
      [["rules", "-h"], "用法：codexc rules"],
      [["rules", "init", "-h"], "用法：codexc rules init"],
      [["rules", "check", "--help"], "用法：codexc rules check"],
      [["agents", "-h"], "用法：codexc agents"],
      [["agents", "status", "--help"], "用法：codexc agents status"],
      [["agents", "configure", "-h"], "用法：codexc agents configure"],
      [["agents", "disable", "--help"], "用法：codexc agents disable"],
      [["primary-provider", "-h"], "用法：codexc primary-provider"],
      [["opencode-go", "-h"], "用法：codexc opencode-go"],
      [["opencode-go", "account", "--help"], "用法：codexc opencode-go account"],
      [["opencode-go", "account", "add", "-h"], "用法：codexc opencode-go account add"],
      [["opencode-go", "account", "list", "--help"], "用法：codexc opencode-go account list"],
      [["opencode-go", "account", "remove", "-h"], "用法：codexc opencode-go account remove"],
      [["opencode-go", "account", "default", "--help"], "用法：codexc opencode-go account default"],
      [["opencode-go", "account", "stop", "-h"], "用法：codexc opencode-go account stop"],
      [["update", "--help"], "用法：codexc update"],
      [["uninstall", "--help"], "用法：codexc uninstall"],
      [["state", "-h"], "用法：codexc state upgrade"],
      [["state", "upgrade", "--help"], "用法：codexc state upgrade"],
      [["metrics", "-h"], "用法：codexc metrics"],
      [["metrics", "status", "--help"], "用法：codexc metrics status"],
      [["metrics", "upgrade", "--help"], "用法：codexc metrics upgrade"],
      [["metrics", "run", "--help"], "用法：codexc metrics run"],
      [["metrics", "turns", "--help"], "用法：codexc metrics turns"],
      [["metrics", "threads", "--help"], "用法：codexc metrics threads"],
      [["metrics", "reset", "-h"], "用法：codexc metrics reset"],
      [["metrics", "sync-reset", "--help"], "用法：codexc metrics sync-reset"],
      [["metrics", "cleanup", "--help"], "用法：codexc metrics cleanup"],
      [["metrics", "prune", "--help"], "用法：codexc metrics prune"],
      [["metrics", "report", "-h"], "用法：codexc metrics report"],
      [["metrics", "export", "--help"], "用法：codexc metrics export"],
      [["metrics", "quota", "--help"], "用法：codexc metrics quota"],
      [["channel", "-h"], "用法：codexc channel"],
      [["channel", "send-image", "--help"], "用法：codexc channel send-image"],
      [["webui", "-h"], "用法：codexc webui"],
      [["center", "-h"], "用法：codexc center"],
      [["center", "info", "--help"], "用法：codexc center info"],
      [["center", "config", "-h"], "用法：codexc center config"],
      [["version", "-h"], "用法：codexc version"],
    ] as const;

    await forEachWithConcurrency(cases, 8, async ([args, expected]) => {
      const result = await runCliProcess(args);
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(expected);
      expect(result.stderr).toBe("");
    });

    const detailedCases = [
      {
        args: ["config", "--help"],
        includes: ["codexc config [--json]", "脱敏配置总览", "网络代理", "Thread 分区管理员"],
        excludes: ["工作区设置（沙箱、审批策略、权限 Profile）"],
      },
      {
        args: ["setup", "--help"],
        includes: [
          "Codex 新会话默认值 → 配置核心默认值 / 默认模型与思考等级 / Fast 默认状态 / 计划清单工具 / 沙盒、审批与网络",
          "OpenAI 官方 → 登录并恢复官方",
          "受管 Provider 模型设置 / 共享第三方子代理 / 直接 API Provider（预留）",
        ],
      },
      { args: ["work", "--help"], includes: ["权限"] },
      { args: ["work", "add", "--help"], includes: ["--cwd 指定的目录"] },
      { args: ["rules", "--help"], includes: ["codexc rules check [--json]"] },
      ...["run", "turns", "threads", "report", "export"].map((subcommand) => ({
        args: ["metrics", subcommand, "--help"],
        includes: ["--stdout"],
      })),
      {
        args: ["service", "--help"],
        includes: [
          "all 只包含 App Server 与 Gateway",
          "status [目标] [--json]",
          "生成全部后台服务定义，并启动 App Server 与 Gateway",
          "卸载全部后台服务并保留用户数据",
        ],
      },
      {
        args: ["remote", "--help"],
        includes: ["sf-opencode-go-<账户>", "sf-custom-<Provider ID>"],
      },
      {
        args: ["channel", "--help"],
        includes: ["渠道图片能力", "Thread 绑定渠道的机器人凭据"],
        excludes: ["图片等媒体"],
      },
      {
        args: ["update", "--help"],
        includes: ["更新失败也会尝试恢复已停止的核心服务"],
      },
      { args: ["doctor", "--help"], includes: ["codexc doctor [--json]"] },
      {
        args: ["--help"],
        includes: [
          "version, -v, --version",
          "center                       启动或配置多设备指标中心",
        ],
      },
    ];
    await forEachWithConcurrency(detailedCases, 8, async ({ args, includes, excludes = [] }) => {
      const result = await runCliProcess(args);
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
      for (const expected of includes) expect(result.stdout).toContain(expected);
      for (const excluded of excludes) expect(result.stdout).not.toContain(excluded);
    });
  }, 180_000);

  it("keeps top-level help as a complete first-level command index", () => {
    const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    for (const command of [
      "init",
      "setup",
      "config",
      "doctor",
      "remote",
      "work",
      "rules",
      "agents",
      "primary-provider",
      "opencode-go",
      "metrics",
      "channel",
      "webui",
      "center",
      "start",
      "service",
      "update",
      "state",
      "version",
    ]) {
      expect(result.stdout).toContain(`\n  ${command}`);
    }
    expect(result.stdout).not.toContain("\n  service install");
    expect(result.stdout).not.toContain("\n  service restart");
    expect(result.stderr).toBe("");
  });

  it("keeps service-template entrypoints hidden from public help while retaining scoped diagnostics", () => {
    const main = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    expect(main.stdout).not.toContain("\n  gateway");
    expect(main.stdout).not.toContain("\n  service-app-server");
    for (const [command, expected] of [
      ["gateway", "用法：codexc gateway"],
      ["service-app-server", "用法：codexc service-app-server"],
    ] as const) {
      const result = spawnSync(process.execPath, [cli, command, "--help"], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(expected);
    }
  });

  it.skipIf(process.platform === "win32")("writes large metrics exports completely without overwriting same-second files", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-metrics-export-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });
    const store = new SqliteModelRequestMetricsStore(
      requestMetricsDatabasePath(join(home, "data", "gateway.sqlite3")),
    );
    for (let index = 0; index < 1_800; index += 1) {
      store.record(metricsSample(index));
    }
    store.close();

    const first = spawnSync(process.execPath, [
      cli,
      "metrics",
      "export",
      "--range",
      "24h",
      "--format",
      "json",
    ], { cwd: workspace, env: environment, encoding: "utf8" });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("[成功] 指标导出完成。");
    const firstPath = exportedMetricsPath(first.stdout);
    expect(statSync(firstPath).size).toBeGreaterThan(1_048_576);
    expect(JSON.parse(readFileSync(firstPath, "utf8")).records).toHaveLength(1_800);

    const second = spawnSync(process.execPath, [
      cli,
      "metrics",
      "export",
      "--range",
      "24h",
      "--format",
      "json",
    ], { cwd: workspace, env: environment, encoding: "utf8" });
    expect(second.status, second.stderr).toBe(0);
    const secondPath = exportedMetricsPath(second.stdout);
    expect(secondPath).not.toBe(firstPath);
    expect(existsSync(firstPath)).toBe(true);
    expect(existsSync(secondPath)).toBe(true);

    const dated = spawnSync(process.execPath, [
      cli,
      "metrics",
      "export",
      "--from",
      "2000-01-01",
      "--to",
      "2099-12-31",
      "--format",
      "json",
    ], { cwd: workspace, env: environment, encoding: "utf8" });
    expect(dated.status, dated.stderr).toBe(0);
    expect(exportedMetricsPath(dated.stdout)).toMatch(
      /\/export-\d{8}-\d{6}(?:-\d+)?\.json$/u,
    );
  }, 20_000);

  it.skipIf(process.platform === "win32")("preserves provider, errors, and CNY costs in machine-readable reports", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-metrics-report-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.display).price_currency = "cny";
    });
    writeFileSync(join(home, "data", "exchange-rate.json"), JSON.stringify({
      version: 1,
      source: "open-er-api",
      effectiveAtMs: Date.now(),
      usdToCny: 7,
    }));
    const store = new SqliteModelRequestMetricsStore(
      requestMetricsDatabasePath(join(home, "data", "gateway.sqlite3")),
    );
    const pricing = {
      billingMode: "api" as const,
      currency: "USD",
      source: "test-catalog",
      effectiveAtMs: Date.now(),
      uncachedInputPricePerMillionNanos: 2_000_000_000,
      cachedInputPricePerMillionNanos: 1_000_000_000,
      outputPricePerMillionNanos: 3_000_000_000,
    };
    store.record({
      ...metricsSample(1),
      provider: "openai",
      model: "shared-model",
      pricing,
    });
    store.record({
      ...metricsSample(2),
      provider: "deepseek",
      model: "shared-model",
      pricing,
    });
    store.record({
      ...metricsSample(3),
      provider: "deepseek",
      model: "shared-model",
      status: "failed",
      httpStatus: 429,
      errorType: "rate_limit",
      pricing,
    });
    store.close();

    const jsonOutput = execFileSync(process.execPath, [
      cli,
      "metrics",
      "report",
      "--range",
      "24h",
      "--group",
      "models",
      "--format",
      "json",
      "--stdout",
    ], { cwd: workspace, env: environment, encoding: "utf8" });
    const report = JSON.parse(jsonOutput);
    expect(report.report.aggregate.totalCostCnyNanos).toBeGreaterThan(0);
    expect(report.report.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "deepseek",
        model: "shared-model",
        aggregate: expect.objectContaining({ totalCostCnyNanos: expect.any(Number) }),
      }),
      expect.objectContaining({
        provider: "openai",
        model: "shared-model",
        aggregate: expect.objectContaining({ totalCostCnyNanos: expect.any(Number) }),
      }),
    ]));
    expect(report.errors.groups).toEqual([
      expect.objectContaining({ provider: "deepseek", errorType: "rate_limit" }),
    ]);

    const csvOutput = execFileSync(process.execPath, [
      cli,
      "metrics",
      "report",
      "--range",
      "24h",
      "--group",
      "models",
      "--format",
      "csv",
      "--stdout",
    ], { cwd: workspace, env: environment, encoding: "utf8" });
    const [header, ...rows] = csvOutput.trim().split("\n");
    expect(header).toContain("type,provider,model");
    expect(header).toContain("totalCostCnyNanos");
    expect(header).toContain("errorType");
    expect(header).toContain("lastOccurredAtMs");
    expect(rows).toEqual(expect.arrayContaining([
      expect.stringMatching(/^group,deepseek,shared-model,/u),
      expect.stringMatching(/^group,openai,shared-model,/u),
      expect.stringMatching(/^error,deepseek,shared-model,/u),
    ]));
  });

  it("does not infer one aggregate provider from truncated report groups", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-metrics-groups-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });
    writeFileSync(join(home, "data", "exchange-rate.json"), JSON.stringify({
      version: 1,
      source: "open-er-api",
      effectiveAtMs: Date.now(),
      usdToCny: 7,
    }));
    const store = new SqliteModelRequestMetricsStore(
      requestMetricsDatabasePath(join(home, "data", "gateway.sqlite3")),
    );
    const pricing = {
      billingMode: "api" as const,
      currency: "USD",
      source: "test-catalog",
      effectiveAtMs: Date.now(),
      uncachedInputPricePerMillionNanos: 2_000_000_000,
      cachedInputPricePerMillionNanos: 1_000_000_000,
      outputPricePerMillionNanos: 3_000_000_000,
    };
    for (let model = 0; model < 20; model += 1) {
      store.record({
        ...metricsSample(model * 2),
        model: `deepseek-model-${model}`,
        pricing,
      });
      store.record({
        ...metricsSample((model * 2) + 1),
        model: `deepseek-model-${model}`,
        pricing,
      });
    }
    store.record({
      ...metricsSample(100),
      provider: "openai",
      model: "openai-hidden-model",
      pricing,
    });
    store.close();

    const output = execFileSync(process.execPath, [
      cli,
      "metrics",
      "report",
      "--range",
      "24h",
      "--group",
      "models",
      "--format",
      "json",
      "--stdout",
    ], { cwd: workspace, env: environment, encoding: "utf8" });
    const report = JSON.parse(output).report;

    expect(report.totalGroupCount).toBe(21);
    expect(report.groups).toHaveLength(20);
    expect(report.groups.every((group: { provider: string }) =>
      group.provider === "deepseek"
    )).toBe(true);
    expect(report.aggregate.totalCostCnyNanos).not.toBeNull();
  });

  it("generates conservative Codex rules for the current project", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-rules-"));
    temporaryDirectories.push(root);
    const project = join(root, "Project");
    const nested = join(project, "src", "nested");
    const fakeCodex = join(root, "fake-codex.mjs");
    const capturePath = join(root, "capture.json");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({
      scripts: {
        build: "tsc",
        lint: "eslint .",
        test: "vitest run",
        dev: "vite",
        "hooks:install": "node install-hooks.mjs",
      },
    }));
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CODEX_RULES_CAPTURE, JSON.stringify(process.argv.slice(2)));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);

    const output = execFileSync(process.execPath, [cli, "rules", "init"], {
      cwd: nested,
      env: {
        ...process.env,
        CODEX_BINARY: fakeCodex,
        CODEX_RULES_CAPTURE: capturePath,
      },
      encoding: "utf8",
    });
    const realProject = realpathSync(project);
    const rulesPath = join(realProject, ".codex", "rules", "default.rules");
    const rules = readFileSync(rulesPath, "utf8");

    expect(output).toContain(`项目目录：${realProject}`);
    expect(output).toContain(`规则文件：${rulesPath}`);
    expect(rules).toContain('pattern = ["git", ["status", "diff", "log"]]');
    expect(rules).toContain('"npm test"');
    expect(rules).toContain('"build"');
    expect(rules).toContain('"lint"');
    expect(rules).not.toContain('"dev"');
    expect(rules).not.toContain('"hooks:install"');
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toContain("execpolicy");
    expect(output).toContain("项目 Codex 规则检查通过");
  });

  it("checks the current project's rules with the configured Codex CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-rules-check-"));
    temporaryDirectories.push(root);
    const project = join(root, "Project");
    const rulesPath = join(project, ".codex", "rules", "default.rules");
    const fakeCodex = join(root, "fake-codex.mjs");
    const capturePath = join(root, "capture.json");
    mkdirSync(dirname(rulesPath), { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(rulesPath, 'prefix_rule(pattern = ["git", "status"], decision = "allow")\n');
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CODEX_RULES_CAPTURE, JSON.stringify(process.argv.slice(2)));",
      "process.stdout.write('底层规则检查输出\\n');",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);

    const output = execFileSync(process.execPath, [cli, "rules", "check"], {
      cwd: project,
      env: {
        ...process.env,
        CODEX_BINARY: fakeCodex,
        CODEX_RULES_CAPTURE: capturePath,
      },
      encoding: "utf8",
    });

    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual([
      "execpolicy",
      "check",
      "--pretty",
      "--rules",
      realpathSync(rulesPath),
      "--",
      "git",
      "status",
      "-sb",
    ]);
    expect(output).toContain("底层规则检查输出");
    expect(output).toContain("项目 Codex 规则检查通过");

    const jsonOutput = execFileSync(
      process.execPath,
      [cli, "rules", "check", "--json"],
      {
        cwd: project,
        env: {
          ...process.env,
          CODEX_BINARY: fakeCodex,
          CODEX_RULES_CAPTURE: capturePath,
        },
        encoding: "utf8",
      },
    );
    expect(JSON.parse(jsonOutput)).toEqual({
      valid: true,
      projectRoot: realpathSync(project),
      rulesPath: realpathSync(rulesPath),
      error: null,
    });
  });

  it.skipIf(process.platform === "win32")("reports a signaled project-rules check without terminating the CLI host", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-rules-signal-"));
    temporaryDirectories.push(root);
    const project = join(root, "Project");
    const rulesPath = join(project, ".codex", "rules", "default.rules");
    const fakeCodex = join(root, "fake-codex");
    mkdirSync(dirname(rulesPath), { recursive: true });
    mkdirSync(join(project, ".git"));
    writeFileSync(rulesPath, 'prefix_rule(pattern = ["git", "status"], decision = "allow")\n');
    writeFileSync(fakeCodex, "#!/bin/sh\nkill -TERM $$\n");
    chmodSync(fakeCodex, 0o700);

    const result = spawnSync(process.execPath, [cli, "rules", "check"], {
      cwd: project,
      env: { ...process.env, CODEX_BINARY: fakeCodex },
      encoding: "utf8",
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("项目 Codex 规则检查被信号终止：SIGTERM");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);

    const jsonResult = spawnSync(
      process.execPath,
      [cli, "rules", "check", "--json"],
      {
        cwd: project,
        env: { ...process.env, CODEX_BINARY: fakeCodex },
        encoding: "utf8",
      },
    );
    expect(jsonResult.signal).toBeNull();
    expect(jsonResult.status).toBe(1);
    expect(JSON.parse(jsonResult.stdout)).toEqual({
      valid: false,
      projectRoot: null,
      rulesPath: null,
      error: {
        code: "check-signaled",
        message: "项目 Codex 规则检查被信号终止：SIGTERM",
      },
    });
    expect(jsonResult.stderr).toBe("");
  });

  it.each(["check", "init"])(
    "uses config.toml Codex binary when running project rules %s",
    (subcommand) => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-rules-config-binary-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const project = join(root, "Project");
    const rulesPath = join(project, ".codex", "rules", "default.rules");
    const fakeCodex = join(root, "fake-codex.mjs");
    const capturePath = join(root, "capture.json");
    if (subcommand === "check") {
      mkdirSync(dirname(rulesPath), { recursive: true });
      writeFileSync(
        rulesPath,
        'prefix_rule(pattern = ["git", "status"], decision = "allow")\n',
      );
    }
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CODEX_RULES_CAPTURE, JSON.stringify(process.argv.slice(2)));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_BINARY: "",
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_RULES_CAPTURE: capturePath,
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: project,
      env: environment,
    });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      table(document.codex).binary = fakeCodex;
    });

    execFileSync(process.execPath, [cli, "rules", subcommand], {
      cwd: project,
      env: environment,
    });

    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toContain("execpolicy");
  });

  it("rejects an invalid existing config when checking project rules", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-rules-invalid-config-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const project = join(root, "Project");
    const rulesPath = join(project, ".codex", "rules", "default.rules");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(dirname(rulesPath), { recursive: true });
    mkdirSync(join(project, ".git"));
    writeFileSync(rulesPath, 'prefix_rule(pattern = ["git", "status"], decision = "allow")\n');
    writeFileSync(fakeCodex, "#!/usr/bin/env node\n");
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_BINARY: fakeCodex,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: project,
      env: environment,
    });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      table(document.codex).unknown = true;
    });

    const result = spawnSync(process.execPath, [cli, "rules", "check"], {
      cwd: project,
      env: environment,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[codex]");
    expect(result.stderr).toContain("unknown");
  });

  it("does not overwrite project rules unless force is explicit", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-rules-force-"));
    temporaryDirectories.push(root);
    const project = join(root, "Project");
    const rulesPath = join(project, ".codex", "rules", "default.rules");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(dirname(rulesPath), { recursive: true });
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
    }));
    writeFileSync(rulesPath, "custom rules\n");
    writeFileSync(fakeCodex, "#!/usr/bin/env node\n");
    chmodSync(fakeCodex, 0o700);
    const environment = { ...process.env, CODEX_BINARY: fakeCodex };

    const rejected = spawnSync(process.execPath, [cli, "rules", "init"], {
      cwd: project,
      env: environment,
      encoding: "utf8",
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("[失败]");
    expect(rejected.stderr).toContain("项目规则已存在");
    expect(readFileSync(rulesPath, "utf8")).toBe("custom rules\n");

    const replaced = execFileSync(process.execPath, [cli, "rules", "init", "--force"], {
      cwd: project,
      env: environment,
      encoding: "utf8",
    });
    expect(replaced).toContain("项目 Codex 规则已重新生成");
    expect(replaced).toContain("[成功]");
    expect(readFileSync(rulesPath, "utf8")).toContain('pattern = ["npm", "test"]');
  });

  it("fails clearly when checking a project without generated rules", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-rules-missing-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, ".git"));

    const result = spawnSync(process.execPath, [cli, "rules", "check"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("尚未生成项目规则");
    expect(result.stderr).toContain("codexc rules init");

    const jsonResult = spawnSync(process.execPath, [cli, "rules", "check", "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(jsonResult.status).toBe(1);
    expect(JSON.parse(jsonResult.stdout)).toEqual({
      valid: false,
      projectRoot: null,
      rulesPath: null,
      error: {
        code: "missing",
        message: expect.stringContaining("尚未生成项目规则"),
      },
    });
    expect(jsonResult.stderr).toBe("");
  });

    }

    if (shard === "workspace") {
  it("initializes an isolated user directory and registers another workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const first = join(root, "First Project");
    const second = join(root, "Second Project");
    mkdirSync(first);
    mkdirSync(second);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };

    const initialized = execFileSync(process.execPath, [cli, "init"], {
      cwd: first,
      env: environment,
      encoding: "utf8",
    });
    const firstAdded = execFileSync(process.execPath, [cli, "work", "add", "--cwd", first], {
      cwd: first,
      env: environment,
      encoding: "utf8",
    });
    const added = execFileSync(process.execPath, [cli, "work", "add", "--cwd", second], {
      cwd: second,
      env: environment,
      encoding: "utf8",
    });
    const listed = execFileSync(process.execPath, [cli, "work"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });

    const configPath = join(home, "config.toml");
    const eventQueuePath = configEventQueuePath(home);
    const parsed = readGatewayConfig(configPath);
    const config = readWorkspaceConfig(parsed);
    expect(initialized).toContain("Codex Connect 已初始化");
    expect(firstAdded).toContain("Workspace 已添加");
    expect(added).toContain("Workspace 已添加");
    expect(added).toContain("Gateway 会自动重新读取配置");
    expect(initialized).toContain(`默认 Workspace：${realpathSync(join(home, "workspace"))}`);
    expect(listed).toContain(".codex-connect/workspace · codex-connect ← 默认");
    expect(listed).toContain("First Project · first-project");
    expect(listed).toContain("Second Project · second-project");
    expect(config.workspaces.map((workspace: { cwd: string }) => workspace.cwd)).toEqual([
      realpathSync(join(home, "workspace")),
      realpathSync(first),
      realpathSync(second),
    ]);
    expect(readConfigEvents(eventQueuePath)).toMatchObject([
      { workspace: { id: "first-project", cwd: realpathSync(first) } },
      { workspace: { id: "second-project", cwd: realpathSync(second) } },
    ]);
    expect(parsed.codex).toMatchObject({ socket_path: "runtime/codex-app-server.sock" });
    expect(parsed.storage).toMatchObject({ database_path: "data/gateway.sqlite3" });
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "workspace")).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("registers the current directory with an explicit Workspace name", () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-cli-ws-add-name-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const project = join(root, "Data Analysis");
    mkdirSync(project);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };

    execFileSync(process.execPath, [cli, "init"], {
      cwd: project,
      env: environment,
      encoding: "utf8",
    });
    const created = execFileSync(
      process.execPath,
      [cli, "work", "add", "--name", "Data Analysis"],
      {
        cwd: project,
        env: environment,
        encoding: "utf8",
      },
    );

    const configPath = join(home, "config.toml");
    const eventQueuePath = configEventQueuePath(home);
    const parsed = readGatewayConfig(configPath);
    const config = readWorkspaceConfig(parsed);
    const directory = realpathSync(project);
    expect(created).toContain("Workspace 已添加");
    expect(created).toContain("data-analysis");
    expect(config.workspaces.some((workspace: { id: string; name: string; cwd: string }) =>
      workspace.id === "data-analysis"
      && workspace.name === "Data Analysis"
      && workspace.cwd === directory)).toBe(true);
    expect(readConfigEvents(eventQueuePath)).toMatchObject([
      { workspace: { id: "data-analysis", cwd: directory } },
    ]);
  });

  it("recovers from a missing default Workspace only with explicit pruning", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const current = join(root, "Current Project");
    mkdirSync(current);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: current,
      env: environment,
    });
    rmSync(join(home, "workspace"), { recursive: true });

    const rejected = spawnSync(process.execPath, [cli, "work", "add", "--cwd", current], {
      cwd: current,
      env: environment,
      encoding: "utf8",
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("codexc work add --prune-missing");
    expect(rejected.stderr).not.toContain("ENOENT");

    const repaired = execFileSync(
      process.execPath,
      [cli, "work", "add", "--cwd", current, "--prune-missing"],
      {
        cwd: current,
        env: environment,
        encoding: "utf8",
      },
    );
    const configPath = join(home, "config.toml");
    const config = readWorkspaceConfig(readGatewayConfig(configPath));

    expect(repaired).toContain("已清理失效 Workspace");
    expect(repaired).not.toContain("默认 Workspace 已切换为：Current Project");
    expect(config.workspaces.map((workspace: { cwd: string }) => workspace.cwd)).toEqual([
      realpathSync(join(home, "workspace")),
      realpathSync(current),
    ]);
    expect(config.defaultWorkspace).toMatchObject({
      id: "codex-connect",
      cwd: realpathSync(join(home, "workspace")),
    });

  });

  it("lists and removes a missing Workspace registration", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const project = join(root, "Temporary Project");
    mkdirSync(project);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: root, env: environment });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", project], { cwd: project, env: environment });
    rmSync(project, { recursive: true });

    const listed = execFileSync(process.execPath, [cli, "work"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    const removed = execFileSync(process.execPath, [cli, "work", "remove", "temporary-project"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    const relisted = execFileSync(process.execPath, [cli, "work"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    const rejected = spawnSync(process.execPath, [cli, "work", "remove", "1"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });

    expect(listed).toContain("Temporary Project · temporary-project · 目录不存在");
    expect(removed).toContain("Workspace 注册已删除：Temporary Project (temporary-project)");
    expect(removed).toContain("磁盘目录未删除");
    expect(relisted).not.toContain("temporary-project");
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("固定默认 Workspace 不能删除");
    expect(readConfigEvents(configEventQueuePath(home))).toEqual([]);
  });

  it("preserves a re-added Workspace notification when config changes coalesce", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const project = join(root, "Project");
    mkdirSync(project);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: root, env: environment });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", project], { cwd: project, env: environment });
    const queuePath = configEventQueuePath(home);
    acknowledgeConfigEvents(
      queuePath,
      readConfigEvents(queuePath).map((event) => event.id),
    );
    const before = readFileSync(join(home, "config.toml"), "utf8");

    execFileSync(process.execPath, [cli, "work", "remove", "project"], {
      cwd: root,
      env: environment,
    });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", project], {
      cwd: project,
      env: environment,
    });

    const after = readFileSync(join(home, "config.toml"), "utf8");
    const config = readWorkspaceConfig(readGatewayConfig(join(home, "config.toml")));
    const events = readConfigEvents(queuePath);
    expect(after).toBe(before);
    expect(events).toHaveLength(1);
    expect(matchingWorkspaceConfigEvents(events, config.workspaces)).toMatchObject([
      { type: "workspace-added", workspace: { id: "project", cwd: realpathSync(project) } },
    ]);
  });

    }

    if (shard === "remote") {
  if (process.platform === "win32") {
    it.skip("Windows 远程 TUI 使用 .cmd 包装器合同测试；Unix 可执行夹具不适用", () => undefined);
    return;
  }

  it("runs remote with the current or explicitly selected Workspace permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const first = join(root, "First Project");
    const second = join(root, "Second Project");
    const nestedWorkspace = join(first, "Nested Project");
    const nestedWorkdir = join(nestedWorkspace, "src");
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(nestedWorkdir, { recursive: true });
    const fakeCodex = join(root, "fake-codex.mjs");
    writeFileSync(
      fakeCodex,
      "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n",
    );
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: first, env: environment });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", first], { cwd: first, env: environment });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      table(document.codex).binary = fakeCodex;
    });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", second], { cwd: second, env: environment });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", nestedWorkspace], {
      cwd: nestedWorkspace,
      env: environment,
    });
    updateGatewayConfig(configPath, (document) => {
      const configuredWorkspaces = document.workspaces as Array<Record<string, unknown>>;
      const firstWorkspace = configuredWorkspaces.find(
        (candidate) => candidate.cwd === realpathSync(first),
      );
      const secondWorkspace = configuredWorkspaces.find(
        (candidate) => candidate.cwd === realpathSync(second),
      );
      const configuredNestedWorkspace = configuredWorkspaces.find(
        (candidate) => candidate.cwd === realpathSync(nestedWorkspace),
      );
      if (!firstWorkspace || !secondWorkspace || !configuredNestedWorkspace) {
        throw new Error("测试 Workspace 未注册");
      }
      firstWorkspace.permissions = ":workspace";
      firstWorkspace.approval_policy = "on-request";
      secondWorkspace.sandbox = "read-only";
      secondWorkspace.approval_policy = "never";
      configuredNestedWorkspace.sandbox = "danger-full-access";
      configuredNestedWorkspace.approval_policy = "on-request";
    });

    const currentCapture = join(root, "current.json");
    execFileSync(process.execPath, [cli, "remote", "resume"], {
      cwd: first,
      env: { ...environment, CODEX_TEST_CAPTURE: currentCapture },
    });
    const explicitCapture = join(root, "explicit.json");
    execFileSync(process.execPath, [cli, "remote", "--workspace", "second-project", "resume"], {
      cwd: first,
      env: { ...environment, CODEX_TEST_CAPTURE: explicitCapture },
    });
    const overriddenCapture = join(root, "overridden.json");
    execFileSync(process.execPath, [
      cli,
      "remote",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "on-request",
      "resume",
    ], {
      cwd: first,
      env: { ...environment, CODEX_TEST_CAPTURE: overriddenCapture },
    });
    const personalProfileCapture = join(root, "personal-profile.json");
    execFileSync(process.execPath, [cli, "remote", "--profile", "personal", "resume"], {
      cwd: first,
      env: { ...environment, CODEX_TEST_CAPTURE: personalProfileCapture },
    });
    const nestedCapture = join(root, "nested.json");
    execFileSync(process.execPath, [cli, "remote", "resume"], {
      cwd: nestedWorkdir,
      env: { ...environment, CODEX_TEST_CAPTURE: nestedCapture },
    });
    const workspaceWriteModifierCapture = join(root, "workspace-write-modifier.json");
    execFileSync(process.execPath, [
      cli,
      "remote",
      "--workspace",
      "second-project",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "resume",
    ], {
      cwd: first,
      env: { ...environment, CODEX_TEST_CAPTURE: workspaceWriteModifierCapture },
    });

    expect(JSON.parse(readFileSync(currentCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(first),
      "-c",
      'default_permissions=":workspace"',
      "--ask-for-approval",
      "on-request",
      "resume",
    ]);
    expect(JSON.parse(readFileSync(explicitCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(second),
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "resume",
    ]);
    expect(JSON.parse(readFileSync(overriddenCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(first),
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "on-request",
      "resume",
    ]);
    expect(JSON.parse(readFileSync(personalProfileCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(first),
      "-c",
      'default_permissions=":workspace"',
      "--ask-for-approval",
      "on-request",
      "--profile",
      "personal",
      "resume",
    ]);
    expect(JSON.parse(readFileSync(nestedCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(nestedWorkdir),
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "on-request",
      "resume",
    ]);
    expect(JSON.parse(readFileSync(workspaceWriteModifierCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(second),
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "resume",
    ]);
  });

  it("fails closed when a remote Workspace uses the retired untrusted CLI policy", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-remote-approval-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const capture = join(root, "capture.json");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    writeFileSync(
      fakeCodex,
      "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n",
    );
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_TEST_CAPTURE: capture,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", workspace], {
      cwd: workspace,
      env: environment,
    });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
      const configuredWorkspace = (document.workspaces as Array<Record<string, unknown>>).find(
        (candidate) => candidate.cwd === realpathSync(workspace),
      );
      if (!configuredWorkspace) throw new Error("测试 Workspace 未注册");
      configuredWorkspace.approval_policy = "untrusted";
    });

    const rejected = spawnSync(process.execPath, [cli, "remote"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("Workspace 审批策略 untrusted 不能传给 Codex CLI 0.150.1");
    expect(existsSync(capture)).toBe(false);

    execFileSync(process.execPath, [
      cli,
      "remote",
      "--ask-for-approval",
      "on-request",
    ], { cwd: workspace, env: environment });
    expect(JSON.parse(readFileSync(capture, "utf8"))).toContain("on-request");
  });

  it("reports an invalid remote Workspace exactly once without a Node stack", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-remote-error-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });

    const result = spawnSync(
      process.execPath,
      [cli, "remote", "--workspace", "missing-workspace"],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("找不到 Workspace：missing-workspace");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
    expect(result.stderr).not.toContain("Node.js v");
    expect(result.stderr).not.toContain("file://");
  });

  it("propagates the signal that terminates the remote Codex process", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-remote-signal-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    writeFileSync(
      fakeCodex,
      "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGTERM');\n",
    );
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const result = spawnSync(process.execPath, [cli, "remote"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.stderr).toBe("");
  });

  it("reports a silent non-zero remote Codex exit exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-remote-exit-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nprocess.exit(7);\n");
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const result = spawnSync(process.execPath, [cli, "remote"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(result.status).toBe(7);
    expect(result.stderr).toContain("Codex TUI 已退出：exit=7");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
  });

    }

    if (shard === "remote-profile") {
  if (process.platform === "win32") {
    it.skip("Windows 远程 Profile 使用服务合同测试；Unix 可执行夹具不适用", () => undefined);
    return;
  }

  it("routes the DeepSeek profile to its isolated remote App Server and authenticates the TUI", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-remote-profile-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    const fakeCodex = join(root, "fake-codex.mjs");
    writeFileSync(
      fakeCodex,
      "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n",
    );
    chmodSync(fakeCodex, 0o700);
    writeManagedProviderFixture(
      codexHome,
      home,
      deepseekProviderDefinition,
      "switching",
      "sk-test-secret",
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const primarySocketPath = join(home, "runtime", "codex-app-server.sock");
    const supervisor = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: ["deepseek"],
      socketPaths: [
        primarySocketPath,
        join(home, "runtime", "codex-app-server-deepseek.sock"),
      ],
    }, { ensureProvider: async () => undefined });
    await supervisor.start();
    try {
      for (const [index, args] of [
        ["--profile", "sf-deepseek"],
        ["--profile=sf-deepseek"],
        ["-p", "sf-deepseek"],
        ["-p=sf-deepseek"],
        ["-psf-deepseek"],
      ].entries()) {
        const capturePath = join(root, `capture-${index}.json`);
        await execFileAsync(process.execPath, [cli, "remote", ...args, "resume"], {
          cwd: workspace,
          env: { ...environment, CODEX_TEST_CAPTURE: capturePath },
          encoding: "utf8",
        });

        expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual([
          "--remote",
          `unix://${join(home, "runtime", "codex-app-server-deepseek.sock")}`,
          "-C",
          realpathSync(workspace),
          "--profile",
          "sf-deepseek",
          "resume",
        ]);
      }
    } finally {
      await supervisor.close();
    }

    const passthroughCapture = join(root, "capture-passthrough.json");
    const passthrough = spawnSync(
      process.execPath,
      [cli, "remote", "resume", "--", "--profile", "deepseek", "--workspace", "external"],
      {
        cwd: workspace,
        env: { ...environment, CODEX_TEST_CAPTURE: passthroughCapture },
        encoding: "utf8",
      },
    );
    expect(passthrough.status, passthrough.stderr).toBe(0);
    expect(JSON.parse(readFileSync(passthroughCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(workspace),
      "resume",
      "--",
      "--profile",
      "deepseek",
      "--workspace",
      "external",
    ]);
  }, 30_000);

  it("uses the native custom Profile without dropping the current Workspace permissions", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-remote-custom-profile-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    const fakeCodex = join(root, "fake-codex.mjs");
    writeFileSync(
      fakeCodex,
      "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n",
    );
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", workspace], {
      cwd: workspace,
      env: environment,
    });
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "codeproxy-dev",
      model: "gpt-5.6-sol",
      name: "CodeProxy Dev",
      baseUrl: "https://proxy.example.test/v1",
      apiKey: "sk-test-secret",
    }, environment);
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
      const configuredWorkspace = (document.workspaces as Array<Record<string, unknown>>)
        .find((candidate) => candidate.cwd === realpathSync(workspace));
      if (!configuredWorkspace) throw new Error("测试 Workspace 未注册");
      configuredWorkspace.sandbox = "read-only";
      configuredWorkspace.approval_policy = "never";
    });

    const primarySocketPath = join(home, "runtime", "codex-app-server.sock");
    const customSocketPath = join(home, "runtime", "codex-app-server-codeproxy-dev.sock");
    const supervisor = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: ["codeproxy-dev"],
      socketPaths: [primarySocketPath, customSocketPath],
    }, { ensureProvider: async () => undefined });
    await supervisor.start();
    try {
      const capturePath = join(root, "capture.json");
      await execFileAsync(
        process.execPath,
        [cli, "remote", "--profile", "sf-custom-codeproxy-dev", "resume"],
        {
          cwd: workspace,
          env: { ...environment, CODEX_TEST_CAPTURE: capturePath },
          encoding: "utf8",
        },
      );

      expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual([
        "--remote",
        `unix://${customSocketPath}`,
        "-C",
        realpathSync(workspace),
        "--profile",
        "sf-custom-codeproxy-dev",
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
        "resume",
      ]);
    } finally {
      await supervisor.close();
    }

    const oldProfile = spawnSync(
      process.execPath,
      [cli, "remote", "--profile", "custom-codeproxy-dev"],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );
    expect(oldProfile.status).toBe(1);
    expect(oldProfile.stderr).toContain(
      "Profile custom-codeproxy-dev 不是该 Provider 的规范名称；请使用 --profile sf-custom-codeproxy-dev",
    );

    const providerId = spawnSync(
      process.execPath,
      [cli, "remote", "--profile", "codeproxy-dev"],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );
    expect(providerId.status).toBe(1);
    expect(providerId.stderr).toContain(
      "codeproxy-dev 是 Provider ID；请使用 --profile sf-custom-codeproxy-dev",
    );
  }, 30_000);

    }

    if (shard === "provider") {
  if (process.platform === "win32") {
    it.skip("Windows 使用独立服务合同测试覆盖 Provider；Unix 套接字集成夹具不适用", () => undefined);
    return;
  }
  it("starts the App Server with effective proxy settings and the official path allowlist", () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-entry-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const capturePath = join(root, "capture.json");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const baseUrlArgument = args.find((value) => value.startsWith('openai_base_url='));",
      "const openAiApiPathStatus = baseUrlArgument === undefined ? null : (await fetch(`${JSON.parse(baseUrlArgument.slice('openai_base_url='.length))}/alpha/search`, { method: 'POST' })).status;",
      "writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify({",
      "  args,",
      "  openAiApiPathStatus,",
      "  cwd: process.cwd(),",
      "  httpsProxy: process.env.HTTPS_PROXY,",
      "  lowerHttpsProxy: process.env.https_proxy,",
      "  serviceRole: process.env.CODEX_CONNECT_SERVICE_ROLE,",
      "}));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    writeFileSync(
      join(codexHome, "config.toml"),
      'openai_base_url = "http://127.0.0.1:1/v1"\n',
      { mode: 0o600 },
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
      CODEX_TEST_CAPTURE: capturePath,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      table(document.codex).binary = fakeCodex;
      table(document.network).https_proxy = "http://127.0.0.1:8899";
    });

    execFileSync(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: environment,
    });

    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      args: string[];
      openAiApiPathStatus: number;
      cwd: string;
      httpsProxy: string;
      lowerHttpsProxy: string;
      serviceRole: string;
    };
    expect(captured.args).toEqual([
      "-c",
      expect.stringMatching(/^openai_base_url="http:\/\/127\.0\.0\.1:\d+"$/u),
      "app-server",
      "--listen",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
    ]);
    expect(captured).toMatchObject({
      openAiApiPathStatus: 502,
      cwd: realpathSync(join(home, "workspace")),
      httpsProxy: "http://127.0.0.1:8899",
      lowerHttpsProxy: "http://127.0.0.1:8899",
      serviceRole: "app-server",
    });
  });

  it("finishes service shutdown when an App Server ignores graceful termination", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-shutdown-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const capturePath = join(root, "capture.json");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "let signals = 0;",
      "const capture = () => writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify({ pid: process.pid, signals }));",
      "process.on('SIGTERM', () => { signals += 1; capture(); });",
      "capture();",
      "setInterval(() => undefined, 1000);",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
      CODEX_TEST_CAPTURE: capturePath,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });
    const service = spawn(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<void>((resolveExit) => service.once("exit", () => resolveExit()));

    let exitedWithinLimit = false;
    let captured: { pid?: number; signals?: number };
    try {
      await waitForCondition(() => existsSync(capturePath), 2_000);
      await expect(inspectAppServerSupervisor(
        join(home, "runtime", "codex-app-server.sock"),
      )).resolves.toBeDefined();
      service.kill("SIGTERM");
      exitedWithinLimit = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 8_000)),
      ]);
    } finally {
      captured = existsSync(capturePath)
        ? JSON.parse(readFileSync(capturePath, "utf8")) as { pid?: number }
        : {};
      if (!exitedWithinLimit) {
        if (service.exitCode === null && service.signalCode === null) service.kill("SIGKILL");
        if (typeof captured.pid === "number") {
          signalTestProcess(captured.pid, "SIGKILL");
        }
        await exited;
      }
    }
    expect(exitedWithinLimit).toBe(true);
    expect(captured.signals).toBeGreaterThanOrEqual(1);
  });

  it("starts a selected custom Responses Provider and its shared role through one metrics proxy", () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-custom-provider-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const capturePath = join(root, "capture.json");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify({",
      "  args: process.argv.slice(2),",
      "  customKeys: Object.keys(process.env).filter((key) => key.startsWith('CODEX_CONNECT_CUSTOM_')),",
      "}));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
      CODEX_TEST_CAPTURE: capturePath,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const roleConfigPath = join(codexHome, "sf-agent.config.toml");
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.6-terra"',
      'model_reasoning_effort = "medium"',
      "",
      "[model_providers.thirdparty]",
      'name = "Third-party Responses"',
      'base_url = "https://proxy.example.test/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "supports_websockets = false",
      'experimental_bearer_token = "custom-fixed-secret"',
      "",
      "[agents.external]",
      `config_file = ${JSON.stringify(roleConfigPath)}`,
      "",
    ].join("\n"), { mode: 0o600 });
    writeThirdPartyModelProviderRoleConfig(environment, { provider: "thirdparty" });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    execFileSync(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: environment,
    });

    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({
      args: [
        "-c",
        'model_provider="thirdparty"',
        "-c",
        expect.stringMatching(/^model_providers\.thirdparty\.base_url="http:\/\/127\.0\.0\.1:\d+"$/u),
        "-c",
        "model_providers.thirdparty.request_max_retries=1",
        "-c",
        "model_providers.thirdparty.stream_max_retries=0",
        "app-server",
        "--listen",
        `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      ],
      customKeys: ["CODEX_CONNECT_CUSTOM_74686972647061727479_API_KEY"],
    });
    const roleContent = readFileSync(roleConfigPath, "utf8");
    expect(roleContent).toMatch(/base_url = "http:\/\/127\.0\.0\.1:\d+\/role\/external"/u);
    expect(roleContent).not.toContain("custom-fixed-secret");
  });

  it("starts the DeepSeek proxy for subagents without eagerly starting its App Server", () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-provider-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const capturePath = join(root, "capture.json");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify({",
      "  args: process.argv.slice(2),",
      "  hasDeepseekApiKey: process.env.CODEX_CONNECT_DEEPSEEK_API_KEY !== undefined,",
      "  hasOpenCodeApiKey: process.env.CODEX_CONNECT_OPENCODE_GO_API_KEY !== undefined,",
      "}) + '\\n');",
      "await new Promise((resolve) => setTimeout(resolve, 100));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    writeManagedProviderFixture(
      codexHome,
      home,
      deepseekProviderDefinition,
      "switching",
      "sk-service-secret",
    );
    writeManagedProviderFixture(
      codexHome,
      home,
      opencodeGoProviderDefinition,
      "switching",
      "sk-opencode-secret",
    );
    writeFileSync(
      join(codexHome, "sf-agent.config.toml"),
      'model = "deepseek-v4-flash"\nmodel_provider = "deepseek"\nmodel_reasoning_effort = "high"\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "config.toml"),
      `[agents.external]\nconfig_file = ${JSON.stringify(
        join(codexHome, "sf-agent.config.toml"),
      )}\n`,
      { mode: 0o600 },
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
      CODEX_TEST_CAPTURE: capturePath,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    execFileSync(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: environment,
    });

    const captures = readFileSync(capturePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(captures).toHaveLength(1);
    const openAiCapture = captures.find(({ args }) =>
      args.some((value: string) => value.startsWith("openai_base_url="))
    );
    const deepseekCapture = captures.find(({ args }) =>
      args.includes('model_provider="deepseek"')
    );
    expect(openAiCapture?.args).toEqual([
      "-c",
      expect.stringMatching(/^openai_base_url="http:\/\/127\.0\.0\.1:\d+"$/u),
      "app-server",
      "--listen",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
    ]);
    expect(deepseekCapture).toBeUndefined();
    expect(openAiCapture).toMatchObject({
      hasDeepseekApiKey: true,
      hasOpenCodeApiKey: false,
    });
    expect(JSON.stringify(captures.map(({ args }) => args))).not.toContain("sk-service-secret");
    expect(JSON.stringify(captures.map(({ args }) => args))).not.toContain("sk-opencode-secret");
    const roleConfigPath = join(codexHome, "sf-agent.config.toml");
    expect(readFileSync(roleConfigPath, "utf8")).toMatch(
      /base_url = "http:\/\/127\.0\.0\.1:\d+\/role\/external"/u,
    );
  });

  it("starts a custom Provider proxy for subagents and injects only its isolated API key", () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-custom-role-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const capturePath = join(root, "capture.json");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify({",
      "  args: process.argv.slice(2),",
      "  customKeys: Object.keys(process.env).filter((key) => key.startsWith('CODEX_CONNECT_CUSTOM_')),",
      "}));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
      CODEX_TEST_CAPTURE: capturePath,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "codeproxy-dev",
      model: "gpt-5.6-sol",
      name: "CodeProxy Dev",
      baseUrl: "https://proxy.example.test/v1",
      apiKey: "custom-agent-secret",
    }, environment);
    const roleConfigPath = join(codexHome, "sf-agent.config.toml");
    writeFileSync(
      roleConfigPath,
      'model = "gpt-5.6-sol"\nmodel_provider = "codeproxy-dev"\nmodel_reasoning_effort = "medium"\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "config.toml"),
      `model_provider = "openai"\n[agents.external]\nconfig_file = ${JSON.stringify(roleConfigPath)}\n`,
      { mode: 0o600 },
    );
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    execFileSync(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: environment,
    });

    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    expect(capture.args).toEqual([
      "-c",
      expect.stringMatching(/^openai_base_url="http:\/\/127\.0\.0\.1:\d+"$/u),
      "app-server",
      "--listen",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
    ]);
    expect(capture.customKeys).toEqual([
      "CODEX_CONNECT_CUSTOM_636F646570726F78792D646576_API_KEY",
    ]);
    const roleContent = readFileSync(roleConfigPath, "utf8");
    expect(roleContent).toMatch(/base_url = "http:\/\/127\.0\.0\.1:\d+\/role\/external"/u);
    expect(roleContent).not.toContain("custom-agent-secret");
  });

  it("keeps the shared GO proxy running when releasing the role account App Server", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-role-release-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { createServer } from 'node:http';",
      `const { WebSocketServer } = await import(${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)});`,
      "const listenUrl = process.argv.at(-1);",
      "const socketPath = listenUrl?.startsWith('unix://') ? listenUrl.slice('unix://'.length) : undefined;",
      "if (!socketPath) process.exit(2);",
      "const server = createServer();",
      "const webSocketServer = new WebSocketServer({ server });",
      "server.listen(socketPath);",
      "const stop = () => {",
      "  for (const client of webSocketServer.clients) client.terminate();",
      "  webSocketServer.close(() => server.close(() => process.exit(0)));",
      "};",
      "process.once('SIGTERM', stop);",
      "process.once('SIGINT', stop);",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    writeManagedProviderFixture(
      codexHome,
      home,
      opencodeGoProviderDefinition,
      "switching",
      "sk-opencode-secret",
    );
    const roleConfigPath = join(codexHome, "sf-agent.config.toml");
    writeFileSync(
      roleConfigPath,
      'model = "deepseek-v4-flash"\nmodel_provider = "opencode-go"\nmodel_reasoning_effort = "high"\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "config.toml"),
      `[agents.external]\nconfig_file = ${JSON.stringify(roleConfigPath)}\n`,
      { mode: 0o600 },
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const service = spawn(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    service.stdout.setEncoding("utf8");
    service.stderr.setEncoding("utf8");
    let stderr = "";
    service.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const primarySocketPath = join(home, "runtime", "codex-app-server.sock");
    const exited = new Promise<void>((resolveExit) => service.once("exit", () => resolveExit()));

    try {
      await waitForCondition(
        () => existsSync(primarySocketPath),
        5_000,
        () => service.exitCode === null
          ? undefined
          : new Error(`App Server 服务提前退出：${stderr}`),
      );
      await ensureAppServerProvider(primarySocketPath, "opencode-go");
      const beforeRelease = readFileSync(roleConfigPath, "utf8");
      const roleBaseUrl = /base_url = "([^"]+)"/u.exec(beforeRelease)?.[1];
      expect(roleBaseUrl).toBeDefined();
      if (!roleBaseUrl) throw new Error("第三方子代理角色缺少本地代理地址");
      await expect(fetch(new URL("/health", roleBaseUrl)).then((response) => response.status))
        .resolves.toBe(404);

      await expect(releaseAppServerProvider(primarySocketPath, "opencode-go"))
        .resolves.toEqual({ released: true, reason: "released" });

      expect(readFileSync(roleConfigPath, "utf8")).toBe(beforeRelease);
      await expect(fetch(new URL("/health", roleBaseUrl)).then((response) => response.status))
        .resolves.toBe(404);
    } finally {
      if (service.exitCode === null && service.signalCode === null) service.kill("SIGTERM");
      await exited;
    }
  }, 15_000);

  it("fails closed when the managed subagent role cannot be refreshed", () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-role-write-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    const faultInjection = join(root, "fail-role-write.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(fakeCodex, 0o700);
    writeFileSync(faultInjection, [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      "const renameSync = fs.renameSync;",
      "fs.renameSync = (source, target) => {",
      "  if (String(target).endsWith('sf-agent.config.toml')) {",
      "    const error = new Error('injected role config write failure');",
      "    error.code = 'EACCES';",
      "    throw error;",
      "  }",
      "  return renameSync(source, target);",
      "};",
      "syncBuiltinESMExports();",
    ].join("\n"));
    writeManagedProviderFixture(
      codexHome,
      home,
      deepseekProviderDefinition,
      "switching",
      "sk-service-secret",
    );
    writeFileSync(
      join(codexHome, "sf-agent.config.toml"),
      'model = "deepseek-v4-flash"\nmodel_provider = "deepseek"\nmodel_reasoning_effort = "high"\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "config.toml"),
      `[agents.external]\nconfig_file = ${JSON.stringify(
        join(codexHome, "sf-agent.config.toml"),
      )}\n`,
      { mode: 0o600 },
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const result = spawnSync(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: {
        ...environment,
        NODE_OPTIONS: `--import=${pathToFileURL(faultInjection).href}`,
      },
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("第三方子代理角色配置生成失败");
  });

    }

    if (shard === "supervision") {
  if (process.platform === "win32") {
    it.skip("Windows 进程监督由计划任务与服务合同测试覆盖；Unix 进程夹具不适用", () => undefined);
    return;
  }
  it("does not start an on-demand Provider proxy before that Provider is used", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-proxy-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const capturePath = join(root, "capture.json");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "import { get } from 'node:http';",
      "const baseUrlArg = process.argv.slice(2).find((value) => value.startsWith('model_providers.opencode-go.base_url='));",
      "if (!baseUrlArg) { await new Promise((resolve) => setTimeout(resolve, 500)); process.exit(0); }",
      "const baseUrl = JSON.parse(baseUrlArg.slice(baseUrlArg.indexOf('=') + 1));",
      "const status = await new Promise((resolve) => {",
      "  const request = get(new URL('/health', baseUrl), (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });",
      "  request.on('error', () => resolve(0));",
      "});",
      "writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify({ baseUrl, status }));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    writeManagedProviderFixture(
      codexHome,
      home,
      opencodeGoProviderDefinition,
      "switching",
      "sk-service-secret",
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
      CODEX_TEST_CAPTURE: capturePath,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    execFileSync(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: environment,
    });

    expect(existsSync(capturePath)).toBe(false);
  });

  it("starts an exclusive DeepSeek Gateway and reclaims ownership after forced shutdown", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-start-exclusive-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const capturePath = join(root, "capture.json");
    const fakeCodex = join(root, "fake-codex.mjs");
    const expectedAppServerVersion = (
      JSON.parse(
        readFileSync(resolve("src/codex-protocol/version.json"), "utf8"),
      ) as { codexCli: string }
    ).codexCli.replace(/^codex-cli /u, "");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { createServer } from 'node:http';",
      "import { writeFileSync } from 'node:fs';",
      `const { WebSocketServer } = await import(${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)});`,
      "const args = process.argv.slice(2);",
      `if (args[0] === '--version') { process.stdout.write('codex-cli ${expectedAppServerVersion}\\n'); process.exit(0); }`,
      "const baseUrlArg = args.find((value) => value.startsWith('model_providers.deepseek.base_url='));",
      "const listenUrl = args.at(-1);",
      "const socketPath = listenUrl?.startsWith('unix://') ? listenUrl.slice('unix://'.length) : undefined;",
      "const capture = {",
      "  baseUrlArg,",
      "  requestRetries: args.find((value) => value === 'model_providers.deepseek.request_max_retries=1'),",
      "  streamRetries: args.find((value) => value === 'model_providers.deepseek.stream_max_retries=0'),",
      "  initialized: false,",
      "};",
      "writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(capture));",
      "if (!socketPath) process.exit(2);",
      "const server = createServer();",
      "const webSocketServer = new WebSocketServer({ server });",
      "webSocketServer.on('connection', (client) => client.on('message', (data) => {",
      "  const message = JSON.parse(data.toString());",
      "  if (message.method === 'initialize') {",
      "    capture.initialized = true;",
      "    writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(capture));",
      "    client.send(JSON.stringify({",
      "    jsonrpc: '2.0', id: message.id, result: {",
      `      userAgent: 'codex_cli_rs/${expectedAppServerVersion} (test; test)',`,
      "      codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'linux',",
      "    },",
      "    }));",
      "  }",
      "}));",
      "server.listen(socketPath);",
      "const stop = () => {",
      "  if (process.env.CODEX_TEST_IGNORE_SIGTERM === '1') return;",
      "  for (const client of webSocketServer.clients) client.terminate();",
      "  webSocketServer.close(() => server.close(() => process.exit(0)));",
      "};",
      "process.once('SIGTERM', stop);",
      "process.once('SIGINT', stop);",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    writeManagedProviderFixture(
      codexHome,
      home,
      deepseekProviderDefinition,
      "exclusive",
      "sk-start-secret",
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
      CODEX_TEST_CAPTURE: capturePath,
      CODEX_TEST_IGNORE_SIGTERM: "1",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
      table(document.telegram).bot_token = "123456:test-token";
      table(document.telegram).allowed_user_ids = [123456];
    });

    const child = spawn(process.execPath, [cli, "start"], {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })),
    );

    let publicCommandExitedWithinLimit: boolean;
    try {
      await waitForCondition(
        () => existsSync(join(home, "runtime", "gateway-owner.sock"))
          && readCapturedInitialization(capturePath)
          && stdout.includes("Codex App Server 已连接"),
        10_000,
        () => child.exitCode === null
          ? undefined
          : new Error(
            `前台 Gateway 提前退出：\nstdout:\n${stdout}\nstderr:\n${stderr}`
            + `\ncapture:\n${existsSync(capturePath) ? readFileSync(capturePath, "utf8") : "missing"}`,
          ),
      );
      expect(stdout).toContain("Codex App Server 与模型统计代理已启动");
      expect(stdout).toContain("Codex App Server 已连接");
      expect(stderr).not.toContain("WebSocket 就绪前退出");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      publicCommandExitedWithinLimit = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolveTimeout) => {
          setTimeout(() => resolveTimeout(false), 7_000);
        }),
      ]);
      if (!publicCommandExitedWithinLimit) {
        if (process.platform !== "win32" && child.pid !== undefined) {
          signalTestProcessGroup(child.pid, "SIGKILL");
        } else if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await exited;
      }
    }
    expect(publicCommandExitedWithinLimit).toBe(true);
    const reclaimedOwner = new GatewayOwner(join(home, "config.toml"));
    try {
      await reclaimedOwner.start();
      expect(statSync(join(home, "runtime", "gateway-owner.sock")).mode & 0o777).toBe(0o600);
    } finally {
      await reclaimedOwner.close();
    }
    expect(existsSync(join(home, "runtime", "gateway-owner.sock"))).toBe(false);
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      baseUrlArg?: string;
      requestRetries?: string;
      streamRetries?: string;
      initialized?: boolean;
    };
    expect(captured.initialized).toBe(true);
    expect(captured.baseUrlArg).toMatch(
      /^model_providers\.deepseek\.base_url="http:\/\/127\.0\.0\.1:\d+"$/u,
    );
    expect(captured.requestRetries).toBe("model_providers.deepseek.request_max_retries=1");
    expect(captured.streamRetries).toBe("model_providers.deepseek.stream_max_retries=0");
  }, 15_000);

  it("rejects a partial App Server topology instead of bypassing a provider proxy", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-start-partial-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(fakeCodex, 0o700);
    writeManagedProviderFixture(
      codexHome,
      home,
      deepseekProviderDefinition,
      "switching",
      "sk-start-secret",
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const socketPath = join(home, "runtime", "codex-app-server.sock");
    const server = createServer();
    const webSocketServer = new WebSocketServer({ server });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });

    try {
      const failure = await execFileAsync(
        process.execPath,
        [cli, "start"],
        { cwd: root, env: environment, encoding: "utf8" },
      ).then(
        () => undefined,
        (error: Error & { stderr?: string }) => error,
      );
      expect(failure?.stderr).toContain(
        "检测到部分 App Server 正在运行，无法安全补启动完整统计代理链路",
      );
    } finally {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("rejects an unmanaged App Server even when its complete topology is healthy", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-start-unmanaged-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeManagedProviderFixture(
      codexHome,
      home,
      deepseekProviderDefinition,
      "exclusive",
      "sk-start-secret",
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });

    const socketPath = join(home, "runtime", "codex-app-server.sock");
    const appServer = createServer();
    const webSocketServer = new WebSocketServer({ server: appServer });
    await new Promise<void>((resolveListen, rejectListen) => {
      appServer.once("error", rejectListen);
      appServer.listen(socketPath, resolveListen);
    });

    try {
      const failure = await execFileAsync(
        process.execPath,
        [cli, "start"],
        { cwd: root, env: environment, encoding: "utf8" },
      ).then(
        () => undefined,
        (error: Error & { stderr?: string }) => error,
      );
      expect(failure?.stderr).toContain(
        "现有 App Server 不属于 codexc 统一监管入口",
      );
    } finally {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => appServer.close(() => resolveClose()));
    }
  });

  it("rejects an occupied App Server topology inside the shared supervisor entry", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-occupied-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: join(root, ".codex"),
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const socketPath = join(home, "runtime", "codex-app-server.sock");
    const appServer = createServer();
    const webSocketServer = new WebSocketServer({ server: appServer });
    await new Promise<void>((resolveListen, rejectListen) => {
      appServer.once("error", rejectListen);
      appServer.listen(socketPath, resolveListen);
    });

    try {
      const failure = await execFileAsync(
        process.execPath,
        [cli, "service-app-server"],
        { cwd: root, env: environment, encoding: "utf8" },
      ).then(
        () => undefined,
        (error: Error & { stderr?: string }) => error,
      );
      expect(failure?.stderr).toContain(
        "App Server Socket 已被未受监管的进程占用",
      );
    } finally {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => appServer.close(() => resolveClose()));
    }
  });

  it("rejects a second shared App Server supervisor", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-owner-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: join(root, ".codex"),
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const ownerSocketPath = join(home, "runtime", "codex-app-server-supervisor.sock");
    const ownerServer = createNetServer((socket) => socket.end());
    await new Promise<void>((resolveListen, rejectListen) => {
      ownerServer.once("error", rejectListen);
      ownerServer.listen(ownerSocketPath, resolveListen);
    });

    try {
      const failure = await execFileAsync(
        process.execPath,
        [cli, "service-app-server"],
        { cwd: root, env: environment, encoding: "utf8" },
      ).then(
        () => undefined,
        (error: Error & { stderr?: string }) => error,
      );
      expect(failure?.stderr).toContain(
        "Codex App Server 统一监管入口已在运行",
      );
    } finally {
      await new Promise<void>((resolveClose) => ownerServer.close(() => resolveClose()));
    }
  });

  it("rejects a direct duplicate Gateway independently of Provider metrics sockets", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-gateway-owner-entry-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: join(root, ".different-codex-home"),
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.telegram).bot_token = "123456:test-token";
      table(document.telegram).allowed_user_ids = [123456];
    });
    const owner = new GatewayOwner(join(home, "config.toml"));
    await owner.start();

    try {
      const duplicate = spawnSync(process.execPath, [cli, "gateway"], {
        cwd: root,
        env: environment,
        encoding: "utf8",
      });
      expect(duplicate.status).toBe(1);
      expect(duplicate.stderr).toContain("Gateway 已在运行，不能重复启动");
    } finally {
      await owner.close();
    }
  });

  it("does not start the Gateway before the App Server passes a WebSocket health check", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-start-not-ready-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { createServer } from 'node:net';",
      "const listenUrl = process.argv.at(-1);",
      "const socketPath = listenUrl?.startsWith('unix://') ? listenUrl.slice('unix://'.length) : undefined;",
      "if (!socketPath) process.exit(2);",
      "const server = createServer();",
      "server.listen(socketPath, () => setTimeout(() => server.close(() => process.exit(0)), 500));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: join(root, ".codex"),
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const failure = await execFileAsync(
      process.execPath,
      [cli, "start"],
      { cwd: root, env: environment, encoding: "utf8", timeout: 10_000 },
    ).then(
      () => undefined,
      (error: Error & { stderr?: string }) => error,
    );
    expect(failure?.stderr).toContain(
      "App Server 在 WebSocket 就绪前退出",
    );
    expect(failure?.stderr).not.toContain("至少需要配置一个通讯渠道");
  });

  it("keeps the supervised Gateway waiting while the App Server is not ready", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-gateway-wait-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_CONNECT_SERVICE_ROLE: "gateway",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.telegram).bot_token = "123456:test-token";
      table(document.telegram).allowed_user_ids = [123456];
    });

    const gateway = spawn(process.execPath, [cli, "gateway"], {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<void>((resolveClose) => gateway.once("close", () => resolveClose()));

    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
      expect(gateway.exitCode).toBeNull();
      await expect(gatewayOwnerIsActive(join(home, "config.toml"))).resolves.toBe(false);
    } finally {
      if (gateway.exitCode === null) gateway.kill("SIGTERM");
      await closed;
    }
  }, 10_000);

    }

    if (shard === "errors") {
  it("rejects the removed manual ds_proxy configuration", () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-proxy-mode-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\n");
    chmodSync(fakeCodex, 0o700);
    const providerDirectory = join(home, "providers", deepseekProviderDefinition.id);
    mkdirSync(providerDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(providerDirectory, deepseekProviderDefinition.managedMarkerFileName),
      'version = 1\nprovider = "deepseek"\nmode = "exclusive"\n',
      { mode: 0o600 },
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
      document.ds_proxy = { listen: "127.0.0.1:38473" };
    });

    const result = spawnSync(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ds_proxy");
  });

  it("does not overwrite an existing user configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };

    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const before = readFileSync(join(home, "config.toml"), "utf8");
    const output = execFileSync(process.execPath, [cli, "init"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });

    expect(output).toContain("已经初始化");
    expect(output).not.toContain("初始 Workspace");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(before);
  });

  it("rejects ignored extra arguments", () => {
    const result = spawnSync(process.execPath, [cli, "config", "unexpected"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("用法：codexc config");
  });

  it("rejects the undocumented help alias and extra top-level help arguments", () => {
    const alias = spawnSync(process.execPath, [cli, "help"], { encoding: "utf8" });
    const extra = spawnSync(process.execPath, [cli, "--help", "unexpected"], {
      encoding: "utf8",
    });

    expect(alias.status).toBe(1);
    expect(alias.stderr).toContain("未知命令：help");
    expect(extra.status).toBe(1);
    expect(extra.stderr).toContain("用法：codexc --help");
  });

    }

    if (shard === "syntax") {

  it("validates command syntax before requiring user configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-syntax-"));
    temporaryDirectories.push(root);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: join(root, "missing"),
      CODEX_CONNECT_CONFIG_FILE: "",
    };

    const cases = [
      [["work", "remove"], "用法：codexc work remove"],
      [["work", "add", "--unknown"], "未知参数：--unknown"],
      [["work", "add", "--id", "--prune-missing"], "--id 缺少值"],
      [["work", "add", "--name", "-Project", "--unknown"], "未知参数：--unknown"],
      [["work", "unknown"], "用法：codexc work"],
      [["remote", "--workspace"], "用法：codexc remote"],
      [["remote", "--workspace", "--profile", "deepseek"], "用法：codexc remote"],
      [["agents"], "用法：codexc agents"],
      [["agents", "unknown"], "用法：codexc agents"],
      [["agents", "status", "--json", "unexpected"], "用法：codexc agents"],
      [["rules", "check", "--json", "unexpected"], "用法：codexc rules"],
      [["config", "--json", "unexpected"], "用法：codexc config [--json]"],
      [["doctor", "--json", "unexpected"], "用法：codexc doctor [--json]"],
      [["service", "status", "--json", "gateway"], "用法：codexc service status"],
      [["service", "status", "gateway", "--json", "unexpected"], "用法：codexc service status"],
      [["center", "--help", "unexpected"], "用法：codexc center"],
      [["center", "info", "--help", "unexpected"], "用法：codexc center info"],
      [["center", "info", "--json", "unexpected"], "用法：codexc center info"],
      [["metrics", "status", "--json", "unexpected"], "用法：codexc metrics status"],
      [["center", "--unknown"], "未知参数：--unknown"],
      [["center", "--host", "invalid"], "center host 只允许"],
      [["center", "--token", "--unknown"], "不得通过命令行传入"],
      [["center", "--device-token", "--unknown"], "不得通过命令行传入"],
      [["center", "--database", "--unknown"], "用法：codexc center"],
      [["center", "--token", "-token", "--host", "invalid"], "不得通过命令行传入"],
      [["center", "--database", "-metrics.sqlite3", "--host", "invalid"], "center host 只允许"],
      [["webui", "--unknown"], "未知参数：--unknown"],
      [["webui", "--help", "unexpected"], "用法：codexc webui"],
      [["webui", "--host", "invalid"], "WebUI host 只允许"],
      [["webui", "--token", "--unknown"], "不得通过命令行传入"],
      [["webui", "--token", "-token", "--host", "invalid"], "不得通过命令行传入"],
      [["channel", "send-image", "--unknown"], "未知参数：--unknown"],
      [["channel", "send-image", "--help", "unexpected"], "用法：codexc channel send-image"],
      [["channel", "send-image", "relative.png"], "图片路径必须是绝对路径"],
      [["channel", "send-image", join(root, "image.png"), "--thread", "--unknown"], "--thread 缺少值"],
      [["metrics", "report", "--unknown"], "未知参数：--unknown"],
      [["metrics", "report", "--help", "unexpected"], "用法：codexc metrics report"],
      [["metrics", "report", "--range", "invalid"], "--range 只支持"],
      [["metrics", "report", "--group", "invalid"], "--group 只支持"],
      [["metrics", "cleanup", "--before", "invalid"], "日期必须使用 YYYY-MM-DD 格式"],
    ] as const;
    await forEachWithConcurrency(cases, 8, async ([args, expected]) => {
      const result = await runCliProcess(args, {
        cwd: root,
        env: environment,
      });
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(expected);
      expect(result.stderr).not.toContain("尚未初始化");
    });
  }, 15_000);

    }

    if (shard === "errors") {

  it("rejects extra arguments instead of silently executing scoped commands", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-extra-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });

    for (const [args, expected] of [
      [["work", "list", "unexpected"], "用法：codexc work list"],
      [["agents", "status", "unexpected"], "用法：codexc agents"],
      [["agents", "configure"], "用法：codexc agents"],
      [["agents", "disable", "unexpected"], "用法：codexc agents"],
      [["center", "info", "unexpected"], "用法：codexc center info"],
      [["center", "config", "unexpected"], "用法：codexc center config"],
    ] as const) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        env: environment,
        encoding: "utf8",
      });
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(expected);
    }
  });

  it("reads agents status without requiring Gateway initialization", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-agents-status-"));
    temporaryDirectories.push(root);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: join(root, "missing-gateway-home"),
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: join(root, ".codex"),
    };

    const result = spawnSync(process.execPath, [cli, "agents", "status"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("multi_agent_v2：未启用");
    expect(result.stdout).toContain("第三方子代理：未配置");
    expect(result.stderr).toBe("");

    const jsonResult = spawnSync(
      process.execPath,
      [cli, "agents", "status", "--json"],
      { cwd: root, env: environment, encoding: "utf8" },
    );
    expect(jsonResult.status, jsonResult.stderr).toBe(0);
    expect(JSON.parse(jsonResult.stdout)).toEqual({
      configPath: expect.any(String),
      roleConfigPath: expect.any(String),
      multiAgentV2Enabled: false,
      externalRoleConfigured: false,
      legacyDsRoleConfigured: false,
      provider: null,
      model: null,
    });
    expect(jsonResult.stderr).toBe("");
  });

  it("reports a foreground start failure exactly once without a Node stack", () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-start-error-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      const configuredWorkspaces = document.workspaces;
      if (!Array.isArray(configuredWorkspaces) || configuredWorkspaces.length === 0) {
        throw new Error("测试配置缺少 Workspace");
      }
      const configuredWorkspace = configuredWorkspaces[0];
      if (!configuredWorkspace || typeof configuredWorkspace !== "object") {
        throw new Error("测试 Workspace 配置无效");
      }
      configuredWorkspaces[0] = {
        ...configuredWorkspace,
        cwd: join(root, "Missing Workspace"),
      };
    });

    const result = spawnSync(process.execPath, [cli, "start"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("目录不存在或不是目录");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
    expect(result.stderr).not.toContain("Node.js v");
    expect(result.stderr).not.toContain("file://");
  });

  it.skipIf(process.platform === "win32")("reports a silent non-zero App Server exit exactly once", () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-start-exit-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nprocess.exit(1);\n");
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const result = spawnSync(process.execPath, [cli, "start"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Codex App Server 进程意外退出：exit=1");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
    expect(result.stderr).not.toContain("Node.js v");
  });

  it.skipIf(process.platform === "win32")("fails fast when the managed role references an unconfigured provider", () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-start-role-missing-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(fakeCodex, 0o700);
    writeFileSync(
      join(codexHome, "sf-agent.config.toml"),
      'model = "deepseek-v4-flash"\nmodel_provider = "deepseek"\nmodel_reasoning_effort = "high"\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        "[agents.external]",
        `config_file = ${JSON.stringify(join(codexHome, "sf-agent.config.toml"))}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      table(document.codex).binary = fakeCodex;
      const agents = document.agents && typeof document.agents === "object"
        ? document.agents as Record<string, unknown>
        : {};
      agents.external = {
        config_file: join(codexHome, "sf-agent.config.toml"),
      };
      document.agents = agents;
    });

    const result = spawnSync(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DeepSeek Provider 尚未配置");
    expect(result.signal).toBeNull();
  });

  it("does not repeat a managed child command failure", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-channel-error-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: root,
      env: environment,
    });

    const result = spawnSync(
      process.execPath,
      [cli, "channel", "send-image", join(root, "missing.png")],
      { cwd: root, env: environment, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("图片文件不存在");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
  });

  it("does not repeat a metrics status failure reported by the child command", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-metrics-status-error-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "invalid.toml");
    writeFileSync(configPath, "[\n");

    const result = spawnSync(process.execPath, [cli, "metrics", "status"], {
      env: {
        ...process.env,
        CODEX_CONNECT_CONFIG_FILE: configPath,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("语法无效");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
  });

  it("formats a managed WebUI child failure exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-managed-error-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_CONNECT_SERVICE_ROLE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });
    const blocker = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      blocker.once("error", rejectListen);
      blocker.listen(0, "127.0.0.1", resolveListen);
    });
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("测试端口无效");

    let result;
    try {
      result = spawnSync(
        process.execPath,
        [cli, "webui", "--port", String(address.port)],
        { cwd: workspace, env: environment, encoding: "utf8" },
      );
    } finally {
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    }

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("WebUI 启动失败");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
  });

    }

    if (shard === "diagnostics") {

  linuxIt("does not repeat a service status failure from the platform controller", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-status-error-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeSystemctl = join(root, "systemctl");
    mkdirSync(workspace);
    writeFileSync(fakeSystemctl, [
      "#!/bin/sh",
      "printf '测试服务未运行\\n' >&2",
      "exit 3",
    ].join("\n"));
    chmodSync(fakeSystemctl, 0o755);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_CONNECT_SERVICE_ROLE: "",
      SYSTEMCTL_BINARY: fakeSystemctl,
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });

    const result = spawnSync(
      process.execPath,
      [cli, "service", "status", "gateway"],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toContain("测试服务未运行");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");

    const reload = spawnSync(
      process.execPath,
      [cli, "service", "reload"],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );

    expect(reload.status).toBe(1);
    expect(reload.stderr).toContain("Gateway 尚未运行");
    expect(reload.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(reload.stderr).not.toContain("子命令执行失败");
  });

  linuxIt("prints stable JSON for systemd service status", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-status-json-"));
    temporaryDirectories.push(root);
    const fakeSystemctl = join(root, "systemctl");
    writeFileSync(fakeSystemctl, [
      "#!/bin/sh",
      "printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=456\\n'",
    ].join("\n"));
    chmodSync(fakeSystemctl, 0o755);

    const result = spawnSync(
      process.execPath,
      [cli, "service", "status", "gateway", "--json"],
      {
        cwd: root,
        env: { ...process.env, SYSTEMCTL_BINARY: fakeSystemctl },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      platform: "systemd",
      target: "gateway",
      healthy: true,
      services: [{
        target: "gateway",
        name: "Gateway",
        identifier: "codex-connect-gateway.service",
        loaded: true,
        running: true,
        state: "active/running",
        pid: 456,
      }],
    });
    expect(result.stderr).toBe("");

    writeFileSync(fakeSystemctl, [
      "#!/bin/sh",
      "printf 'LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\n'",
    ].join("\n"));
    const inactive = spawnSync(
      process.execPath,
      [cli, "service", "status", "gateway", "--json"],
      {
        cwd: root,
        env: { ...process.env, SYSTEMCTL_BINARY: fakeSystemctl },
        encoding: "utf8",
      },
    );

    expect(inactive.status).toBe(1);
    expect(JSON.parse(inactive.stdout)).toMatchObject({
      platform: "systemd",
      target: "gateway",
      healthy: false,
      services: [{ running: false, state: "inactive/dead", pid: null }],
    });
    expect(inactive.stderr).toBe("");
  });

  linuxIt("does not repeat a nested service failure from metrics maintenance", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-metrics-service-error-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeSystemctl = join(root, "systemctl");
    mkdirSync(workspace);
    writeFileSync(fakeSystemctl, [
      "#!/bin/sh",
      "printf '测试 Gateway 停止失败\\n' >&2",
      "exit 3",
    ].join("\n"));
    chmodSync(fakeSystemctl, 0o755);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_CONNECT_SERVICE_ROLE: "",
      SYSTEMCTL_BINARY: fakeSystemctl,
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });

    const result = spawnSync(
      process.execPath,
      [cli, "metrics", "cleanup", "--restart-gateway"],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("测试 Gateway 停止失败");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("Gateway 停止失败：exit");
  });

  linuxIt("keeps service diagnostics and recovery available without a config file", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-recovery-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const systemctlLog = join(root, "systemctl.log");
    const journalctlLog = join(root, "journalctl.log");
    const fakeSystemctl = join(root, "systemctl");
    const fakeJournalctl = join(root, "journalctl");
    writeFileSync(fakeSystemctl, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"",
    ].join("\n"));
    chmodSync(fakeSystemctl, 0o755);
    writeFileSync(fakeJournalctl, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$JOURNALCTL_LOG\"",
    ].join("\n"));
    chmodSync(fakeJournalctl, 0o755);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: join(home, "missing.toml"),
      CODEX_CONNECT_SERVICE_ROLE: "",
      XDG_CONFIG_HOME: join(root, "config"),
      SYSTEMCTL_BINARY: fakeSystemctl,
      JOURNALCTL_BINARY: fakeJournalctl,
      SYSTEMCTL_LOG: systemctlLog,
      JOURNALCTL_LOG: journalctlLog,
    };

    for (const args of [
      ["status", "gateway"],
      ["logs", "gateway", "-n", "1"],
      ["reload"],
      ["stop", "gateway"],
      ["uninstall"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [cli, "service", ...args],
        { env: environment, encoding: "utf8" },
      );
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
      expect(result.stderr).not.toContain("ENOENT");
      expect(result.stderr).not.toContain("尚未初始化");
    }
    expect(readFileSync(systemctlLog, "utf8")).toContain(
      "--user stop codex-connect-gateway.service",
    );
    expect(readFileSync(journalctlLog, "utf8")).toContain(
      "--user-unit=codex-connect-gateway.service --lines=1 --no-pager",
    );

    const systemctlCallsBeforeStart = readFileSync(systemctlLog, "utf8");
    const start = spawnSync(
      process.execPath,
      [cli, "service", "start", "gateway"],
      { env: environment, encoding: "utf8" },
    );
    expect(start.status).toBe(1);
    expect(start.stderr).toContain("ENOENT");
    expect(readFileSync(systemctlLog, "utf8")).toBe(systemctlCallsBeforeStart);
  });

  it.skipIf(process.platform === "win32")("runs the metrics center info and non-interactive config subcommands", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-center-subcommands-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });

    const info = spawnSync(process.execPath, [cli, "center", "info"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    expect(info.status, info.stderr).toBe(0);
    expect(info.stdout).toContain("中心服务：");
    expect(info.stdout).toContain("中心数据库：");

    const jsonInfo = spawnSync(process.execPath, [cli, "center", "info", "--json"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    expect(jsonInfo.status, jsonInfo.stderr).toBe(0);
    expect(JSON.parse(jsonInfo.stdout)).toMatchObject({
      running: expect.any(Boolean),
      host: "127.0.0.1",
      port: 8790,
      ingestEndpoints: ["http://127.0.0.1:8790/api/ingest"],
      viewEndpoint: "http://127.0.0.1:8790",
      viewTokenConfigured: false,
      deviceTokenConfigured: false,
      databasePath: expect.any(String),
      configPath: expect.any(String),
    });
    expect(jsonInfo.stderr).toBe("");

    const config = spawnSync(process.execPath, [cli, "center", "config"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    expect(config.status, config.stderr).toBe(0);
    expect(config.stdout).toContain("中心服务设置保存在 [metrics.center] 段");
  });

  it("formats a metrics center info failure exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-center-info-error-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });
    const configPath = join(home, "config.toml");
    writeFileSync(
      configPath,
      `${readFileSync(configPath, "utf8")}\n[metrics.center]\nhost = "invalid"\n`,
    );

    const result = spawnSync(process.execPath, [cli, "center", "info"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[metrics.center] 配置无效");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
  });

  it("documents service maintenance commands in scoped help", () => {
    const output = execFileSync(process.execPath, [cli, "service", "--help"], {
      encoding: "utf8",
    });

    expect(output).toContain("uninstall");
    expect(output).toContain("reload");
    expect(output).toContain("logs");
    expect(output).toContain("保留用户数据");
  });

  it("documents managed source removal in top-level help", () => {
    const output = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });

    expect(output).toContain("uninstall");
    expect(output).toContain("卸载受管源码与全局命令并保留用户数据");
  });

  it("describes Setup by its model, provider, channel, and skill responsibilities", () => {
    const output = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });

    expect(output).toContain("配置 Codex 新会话默认值、提供商、通讯渠道与项目技能");
  });

  it("explains the Setup categories in scoped help", () => {
    const output = execFileSync(process.execPath, [cli, "setup", "--help"], {
      encoding: "utf8",
    });

    expect(output).toContain("脱敏配置总览");
    expect(output).toContain("模型与提供商、共享第三方子代理、通讯渠道和项目技能");
    expect(output).toContain("直接 API Provider（预留）");
  });

    }

    if (shard === "services") {
  it("rejects invalid service log options before reading user configuration", () => {
    const invalidLines = spawnSync(process.execPath, [cli, "service", "logs", "--lines", "0"], {
      encoding: "utf8",
    });
    const unknown = spawnSync(process.execPath, [cli, "service", "logs", "--unknown"], {
      encoding: "utf8",
    });
    const removedServiceOption = spawnSync(
      process.execPath,
      [cli, "service", "logs", "--service", "all"],
      { encoding: "utf8" },
    );
    const invalidTarget = spawnSync(
      process.execPath,
      [cli, "service", "restart", "unknown"],
      { encoding: "utf8" },
    );

    expect(invalidLines.status).toBe(1);
    expect(invalidLines.stderr).toContain("日志行数必须是 1 到 10000");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("未知日志参数");
    expect(removedServiceOption.status).toBe(1);
    expect(removedServiceOption.stderr).toContain("未知日志参数");
    expect(invalidTarget.status).toBe(1);
    expect(invalidTarget.stderr).toContain("服务目标必须是");
  });

  linuxIt("rejects service actions that would disconnect a command running inside App Server", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-role-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const systemctlLog = join(root, "systemctl.log");
    const fakeSystemctl = join(root, "systemctl");
    const fakeLoginctl = join(root, "loginctl");
    mkdirSync(workspace);
    writeFileSync(
      fakeSystemctl,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\n",
    );
    chmodSync(fakeSystemctl, 0o755);
    writeFileSync(
      fakeLoginctl,
      "#!/bin/sh\nif [ \"$1\" = \"show-user\" ]; then printf 'yes\\n'; fi\n",
    );
    chmodSync(fakeLoginctl, 0o755);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_CONNECT_SERVICE_ROLE: "app-server",
      XDG_CONFIG_HOME: join(root, "config"),
      SYSTEMCTL_BINARY: fakeSystemctl,
      LOGINCTL_BINARY: fakeLoginctl,
      SYSTEMCTL_LOG: systemctlLog,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });

    for (const args of [
      ["restart", "app-server"],
      ["restart", "all"],
      ["stop", "gateway"],
      ["stop", "app-server"],
      ["stop", "all"],
      ["install"],
      ["uninstall"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [cli, "service", ...args],
        { cwd: workspace, env: environment, encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("不能在 Codex App Server 内执行会中断当前渠道的服务操作");
    }
    expect(existsSync(systemctlLog) ? readFileSync(systemctlLog, "utf8") : "").toBe("");

    const readiness = await startManagedServiceReadinessFixture(
      join(home, "config.toml"),
      environment,
    );
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [cli, "service", "restart", "gateway"],
        {
          cwd: workspace,
          env: {
            ...environment,
            // Retired test overrides must not bypass the production readiness protocol.
            CODEX_CONNECT_SERVICE_READINESS_BINARY: "/bin/false",
          },
          encoding: "utf8",
        },
      );
      expect(stdout).toContain("Gateway 已就绪；Codex App Server 保持运行");
      expect(readFileSync(systemctlLog, "utf8")).toContain(
        "--user restart codex-connect-gateway.service",
      );
      expect(readFileSync(systemctlLog, "utf8")).not.toContain(
        "codex-connect-app-server.service",
      );
    } finally {
      await readiness.close();
    }
  }, 15_000);

  linuxIt("manages WebUI as an independent service target outside all", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-webui-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const systemctlLog = join(root, "systemctl.log");
    const fakeSystemctl = join(root, "systemctl");
    mkdirSync(workspace);
    writeFileSync(
      fakeSystemctl,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\n",
    );
    chmodSync(fakeSystemctl, 0o755);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      SYSTEMCTL_BINARY: fakeSystemctl,
      SYSTEMCTL_LOG: systemctlLog,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const readiness = await startManagedServiceReadinessFixture(
      join(home, "config.toml"),
      environment,
    );

    try {
      const start = spawnSync(
        process.execPath,
        [cli, "service", "start", "webui"],
        { env: environment, encoding: "utf8" },
      );
      expect(start.status).toBe(0);
      expect(readFileSync(systemctlLog, "utf8")).toContain(
        "--user start codex-connect-webui.service",
      );

      writeFileSync(systemctlLog, "");
      const { stdout: allStdout } = await execFileAsync(
        process.execPath,
        [cli, "service", "start", "all"],
        { env: environment, encoding: "utf8" },
      );
      expect(allStdout).toContain("Codex App Server 与 Gateway 已就绪");
      const log = readFileSync(systemctlLog, "utf8");
      expect(log).toContain("codex-connect-app-server.service");
      expect(log).toContain("codex-connect-gateway.service");
      expect(log).not.toContain("codex-connect-webui.service");

      writeFileSync(systemctlLog, "");
      const { stdout: defaultStartStdout } = await execFileAsync(
        process.execPath,
        [cli, "service", "start"],
        { env: environment, encoding: "utf8" },
      );
      expect(defaultStartStdout).toContain("Codex App Server 与 Gateway 已就绪");
      const defaultStartLog = readFileSync(systemctlLog, "utf8");
      expect(defaultStartLog).toContain("codex-connect-app-server.service");
      expect(defaultStartLog).toContain("codex-connect-gateway.service");

      writeFileSync(systemctlLog, "");
      const { stdout: defaultRestartStdout } = await execFileAsync(
        process.execPath,
        [cli, "service", "restart"],
        { env: environment, encoding: "utf8" },
      );
      expect(defaultRestartStdout).toContain("Gateway 已就绪；Codex App Server 保持运行");
      const defaultRestartLog = readFileSync(systemctlLog, "utf8");
      expect(defaultRestartLog).toContain("codex-connect-gateway.service");
      expect(defaultRestartLog).not.toContain("codex-connect-app-server.service");
    } finally {
      await readiness.close();
    }
  }, 15_000);

    }

    if (shard === "doctor") {
  it("rejects removed Workspace command aliases", () => {
    for (const alias of ["workspace", "ws"]) {
      const result = spawnSync(process.execPath, [cli, alias], { encoding: "utf8" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`未知命令：${alias}`);
    }
  });

  it("shows an explicitly configured Gateway config file", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "profile", "gateway.toml");
    mkdirSync(join(root, "profile"));

    const output = execFileSync(process.execPath, [cli, "config"], {
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
      encoding: "utf8",
    });

    expect(output).toContain(`用户目录：${join(root, "profile")}`);
    expect(output).toContain(`配置文件：${configPath}`);

    const jsonOutput = execFileSync(process.execPath, [cli, "config", "--json"], {
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
      encoding: "utf8",
    });
    expect(JSON.parse(jsonOutput)).toEqual({
      dataDir: join(root, "profile"),
      configPath,
      exists: false,
    });
  });

  it("initializes an explicitly configured Gateway config file", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "Workspace");
    const profile = join(root, "profile");
    const configPath = join(profile, "gateway.toml");
    mkdirSync(workspace);
    mkdirSync(profile, { mode: 0o755 });
    chmodSync(profile, 0o755);

    const output = execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
      encoding: "utf8",
    });
    execFileSync(process.execPath, [cli, "work"], {
      cwd: workspace,
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
    });
    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
      encoding: "utf8",
    });

    const parsed = readGatewayConfig(configPath);
    const jsonOutput = execFileSync(process.execPath, [cli, "config", "--json"], {
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
      encoding: "utf8",
    });
    expect(output).toContain(`配置文件：${configPath}`);
    expect(JSON.parse(jsonOutput)).toEqual({
      dataDir: profile,
      configPath,
      exists: true,
    });
    expect(table(parsed.codex).socket_path).toBe("runtime/codex-app-server.sock");
    expect(table(parsed.storage).database_path).toBe("data/gateway.sqlite3");
    expect(statSync(profile).mode & 0o777).toBe(0o755);
    expect(statSync(join(profile, "runtime")).mode & 0o777).toBe(0o700);
    expect(statSync(join(profile, "data")).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(diagnosed.stdout).not.toContain("[失败] 配置目录权限");
  });

  it("reports Telegram as disabled when another channel is enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-channel-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.network).https_proxy = "http://127.0.0.1:7890";
      document.weixin = {
        enabled: true,
        account_id: "bot-fixture@im.bot",
        allowed_user_ids: ["actor-fixture@im.wechat"],
      };
    });

    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(diagnosed.stdout).not.toContain("[通过] 配置格式");
    expect(diagnosed.stdout).toContain("[提示] Telegram：未配置");
    expect(diagnosed.stdout).toContain(
      "[提示] Plugin API：已关闭",
    );
    expect(diagnosed.stdout).toContain(
      "[提示] OpenAI 代理：已检测到代理，官方模型请求将通过代理连接",
    );
    expect(diagnosed.stdout).not.toContain("[失败] Telegram Token");
    expect(diagnosed.stdout).not.toContain("[失败] Telegram 用户");
    expect(diagnosed.stdout).not.toContain("[通过]");
    expect(diagnosed.stdout.match(/诊断发现/g)).toHaveLength(1);
    const visibleSections = [
      "=== 网络与代理 ===",
      "=== 通讯渠道 ===",
      "=== 扩展能力 ===",
      "=== Codex 与 App Server ===",
      "=== 系统服务 ===",
    ];
    expect(visibleSections.every((section) => diagnosed.stdout.includes(section))).toBe(true);
    expect(visibleSections.map((section) => diagnosed.stdout.indexOf(section))).toEqual(
      [...visibleSections]
        .map((section) => diagnosed.stdout.indexOf(section))
        .sort((left, right) => left - right),
    );
    expect(diagnosed.stdout).not.toContain("=== Workspace ===");
    expect(diagnosed.stdout).not.toContain(`${String.fromCharCode(27)}[`);
    expect(diagnosed.stdout).toMatch(/诊断发现 \d+ 项问题：\d+ 项通过，\d+ 项提示。/u);
  });

  it("prints structured Doctor results without exposing configured secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-json-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const secret = "doctor-json-secret-token";
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      const telegram = table(document.telegram);
      telegram.bot_token = secret;
      telegram.allowed_user_ids = [123456];
      document.experimental = { plugin_api: true };
    });

    const diagnosed = spawnSync(process.execPath, [cli, "doctor", "--json"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    const payload = JSON.parse(diagnosed.stdout) as {
      healthy: boolean;
      counts: { success: number; failure: number; note: number };
      checks: Array<{
        section: string;
        kind: "success" | "failure" | "note";
        name: string;
        detail: string;
        remediation: string | null;
      }>;
    };
    expect(diagnosed.status).toBe(payload.healthy ? 0 : 1);
    expect(payload.checks).toHaveLength(
      payload.counts.success + payload.counts.failure + payload.counts.note,
    );
    expect(payload.checks).toContainEqual(expect.objectContaining({
      section: "通讯渠道",
      kind: "success",
      name: "Telegram Token",
      remediation: null,
    }));
    expect(payload.checks).toContainEqual(expect.objectContaining({
      section: "扩展能力",
      kind: "note",
      name: "Plugin API",
      detail: expect.stringContaining("Codex 0.152.0"),
    }));
    expect(diagnosed.stdout).not.toContain(secret);
    expect(diagnosed.stdout).not.toContain("Codex Connect Doctor\n");
    expect(diagnosed.stderr).toBe("");
  });

  linuxIt("reports how to install bubblewrap when it is missing from PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-bwrap-"));
    temporaryDirectories.push(root);
    const emptyPath = join(root, "bin");
    mkdirSync(emptyPath);

    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: emptyPath,
        CODEX_CONNECT_HOME: join(root, ".codex-connect"),
        CODEX_CONNECT_CONFIG_FILE: "",
      },
      encoding: "utf8",
    });

    expect(diagnosed.stdout).toContain(
      "[提示] Linux 沙箱：PATH 中未找到 bwrap；Codex 将回退到内置 helper",
    );
    expect(diagnosed.stdout).toContain(
      "[处理] Linux 沙箱：Debian/Ubuntu：sudo apt install bubblewrap；"
      + "Fedora/RHEL：sudo dnf install bubblewrap；安装后重新运行 codexc doctor",
    );
  });

  linuxIt("warns when OpenAI will use a direct connection without a proxy", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-proxy-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const emptyPath = join(root, "bin");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    mkdirSync(emptyPath);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      const telegram = table(document.telegram);
      telegram.bot_token = "doctor-proxy-fixture";
      telegram.allowed_user_ids = [123456];
    });

    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: {
        ...environment,
        PATH: emptyPath,
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        NO_PROXY: "",
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
        no_proxy: "",
      },
      encoding: "utf8",
    });

    expect(diagnosed.stdout).toContain(
      "[提示] OpenAI 代理：未检测到代理，官方模型请求将尝试直连；受限网络中可能无法连接",
    );
    expect(diagnosed.stdout).toContain(
      "[处理] OpenAI 代理：在 config.toml 的 [network] 中设置 https_proxy",
    );
  });

  linuxIt("reports safe Linux Weixin runtime readiness without exposing private values", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-weixin-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      const telegram = table(document.telegram);
      telegram.bot_token = "test-token";
      telegram.allowed_user_ids = [123456];
      document.weixin = {
        enabled: true,
        account_id: "bot-fixture@im.bot",
        allowed_user_ids: ["actor-fixture@im.wechat"],
      };
    });
    const accountId = "bot-fixture@im.bot";
    const actorId = "actor-fixture@im.wechat";
    const botToken = "private-bot-token";
    const contextToken = "private-context-token";
    const cursor = "private-updates-cursor";
    await new EncryptedFileWeixinCredentialStore(
      join(home, "credentials", "weixin"),
    ).set({
      version: 1,
      accountId,
      botToken,
      baseUrl: "https://ilinkai.weixin.qq.com",
      grantedAt: 1_000,
    });
    await new EncryptedFileWeixinReplyContextPersistence(
      join(home, "credentials", "weixin-reply-context"),
      () => 1_000,
    ).set(
      {
        surface: "weixin",
        accountId,
        conversationId: actorId,
      },
      actorId,
      contextToken,
    );
    await new FileWeixinUpdatesCursorStore(
      join(home, "data", "weixin-updates"),
    ).set(accountId, cursor);

    const enabled = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });
    expect(enabled.stdout).toContain(
      "[提示] 微信运行时：配置已启用",
    );
    expect(enabled.stdout).not.toContain("[失败] 微信配置");
    expect(enabled.stdout).not.toContain("[失败] 微信连接");
    expect(enabled.stdout).toContain(
      "[提示] 微信消息游标：检查点存在且载荷有效",
    );
    expect(enabled.stdout).toContain(
      "[提示] 微信上线通知：1/1 个允许用户具备加密回复上下文",
    );
    expect(enabled.stdout).toContain(
      "最近授权消息：1970-01-01T00:00:01.000Z",
    );
    expect(enabled.stdout).not.toContain(botToken);
    expect(enabled.stdout).not.toContain(contextToken);
    expect(enabled.stdout).not.toContain(cursor);
    expect(enabled.stdout).not.toContain(accountId);
    expect(enabled.stdout).not.toContain(actorId);

    updateGatewayConfig(configPath, (document) => {
      table(document.weixin).enabled = false;
    });
    const disabled = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });
    expect(disabled.stdout).toContain(
      "[提示] 微信运行时：配置未启用",
    );
  });

  it("diagnoses configuration and a real Unix WebSocket without exposing the Telegram token", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-doctor-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });

    const expectedCodexCliVersion = (
      JSON.parse(
        readFileSync(resolve("src/codex-protocol/version.json"), "utf8"),
      ) as { codexCli: string }
    ).codexCli;
    const expectedAppServerVersion = expectedCodexCliVersion.replace(/^codex-cli /u, "");
    const fakeCodex = join(root, "codex");
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${expectedCodexCliVersion}\n`)});\n`,
    );
    chmodSync(fakeCodex, 0o700);
    const configPath = join(home, "config.toml");
    const socketPath = join(root, "app.sock");
    let initializedReceived = false;
    const initializedClientNames: unknown[] = [];
    let appServerVersion = expectedAppServerVersion;
    const secret = "123456:test-secret-token";
    updateGatewayConfig(configPath, (document) => {
      const telegram = table(document.telegram);
      telegram.bot_token = secret;
      telegram.allowed_user_ids = [123456];
      const codex = table(document.codex);
      codex.binary = fakeCodex;
      codex.socket_path = socketPath;
    });

    const server = createServer();
    const webSocketServer = new WebSocketServer({ server });
    webSocketServer.on("connection", (client) => {
      client.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.method === "initialize") {
          initializedClientNames.push(message.params?.clientInfo?.name);
          client.send(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              userAgent: `codex_cli_rs/${appServerVersion} (macOS 26.0; arm64)`,
              codexHome: home,
              platformFamily: "unix",
              platformOs: "macos",
            },
          }));
        }
        if (message.method === "initialized") {
          initializedReceived = true;
        }
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });
    const supervisorOwner = new AppServerSupervisorOwner(socketPath, {
      primaryProvider: "openai",
      managedProviders: [],
      socketPaths: [socketPath],
    });

    try {
      const unmanaged = await execFileAsync(
        process.execPath,
        [cli, "doctor"],
        { cwd: workspace, env: environment, encoding: "utf8" },
      ).then(
        ({ stdout }) => ({ status: 0, stdout }),
        (error: Error & { code?: number; stdout?: string }) => ({
          status: error.code,
          stdout: error.stdout ?? "",
        }),
      );
      expect(unmanaged.status).toBe(1);
      expect(unmanaged.stdout).toContain("[失败] App Server 监管");
      expect(unmanaged.stdout).toContain("codexc service restart all");

      await supervisorOwner.start();
      const { stdout } = await execFileAsync(
        process.execPath,
        [cli, "doctor"],
        {
          cwd: workspace,
          env: environment,
          encoding: "utf8",
        },
      ).catch((error: Error & { stdout?: string; stderr?: string }) => {
        throw new Error(
          `doctor 执行失败\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
          { cause: error },
        );
      });
      expect(stdout).not.toContain("[失败] Codex CLI");
      expect(stdout).not.toContain("[失败] Codex App Server");
      expect(stdout).not.toContain("[失败] App Server 版本");
      expect(stdout).not.toContain("[通过]");
      expect(stdout).toContain("诊断通过");
      expect(stdout).not.toContain(secret);
      expect(initializedReceived).toBe(true);
      expect(initializedClientNames.length).toBeGreaterThan(0);
      expect(initializedClientNames.every((name) => name === "codex_connect")).toBe(true);

      appServerVersion = "0.0.0";
      const mismatched = await execFileAsync(
        process.execPath,
        [cli, "doctor"],
        {
          cwd: workspace,
          env: environment,
          encoding: "utf8",
        },
      ).then(
        ({ stdout: mismatchStdout }) => ({ status: 0, stdout: mismatchStdout }),
        (error: Error & { code?: number; stdout?: string }) => ({
          status: error.code,
          stdout: error.stdout ?? "",
        }),
      );
      expect(mismatched.status).toBe(1);
      expect(mismatched.stdout).toContain(
        `[失败] App Server 版本：0.0.0（要求 ${expectedAppServerVersion}）`,
      );
    } finally {
      await supervisorOwner.close();
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("rejects the removed doctor --fix compatibility command", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-fix-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });

    const rejected = spawnSync(process.execPath, [cli, "doctor", "--fix"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("用法：codexc doctor");
  });

  it("reports invalid TOML without rewriting it", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-legacy-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const configPath = join(home, "config.toml");
    const invalidContent = `${readFileSync(configPath, "utf8")}\ninvalid = [\n`;
    writeFileSync(configPath, invalidContent);

    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(diagnosed.status).toBe(1);
    expect(diagnosed.stdout).toContain("[失败] 配置格式");
    expect(readFileSync(configPath, "utf8")).toBe(invalidContent);
  });

  it("rejects configuration that is valid TOML but violates the Gateway schema", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-schema-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      document.legacy_setting = true;
    });

    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(diagnosed.status).toBe(1);
    expect(diagnosed.stdout).toContain("[失败] 配置格式");
    expect(diagnosed.stdout).toContain("Unrecognized key");
  });

  it("reports unreachable Thread Section administrators as invalid configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-section-admin-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      const telegram = table(document.telegram);
      telegram.bot_token = "test-token";
      telegram.allowed_user_ids = [123456];
      document.thread_sections = { administrators: ["telegram:654321"] };
    });

    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(diagnosed.status).toBe(1);
    expect(diagnosed.stdout).toContain("[失败] 配置格式");
    expect(diagnosed.stdout).toContain(
      "Thread 分区管理员必须属于对应已启用渠道的允许名单",
    );
    expect(diagnosed.stdout).not.toContain("已配置 1 个管理员");
  });
    }
  });
}

function updateGatewayConfig(
  configPath: string,
  update: (document: Record<string, unknown>) => void,
): void {
  const document = readGatewayConfig(configPath);
  update(document);
  writeGatewayConfig(configPath, document);
}

async function startManagedServiceReadinessFixture(
  configPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ close(): Promise<void> }> {
  const descriptor = resolveAppServerRuntime(
    readGatewayConfig(configPath),
    dirname(configPath),
    environment,
  );
  const servers: ReturnType<typeof createServer>[] = [];
  const webSocketServers: WebSocketServer[] = [];
  let supervisorOwner: AppServerSupervisorOwner | undefined;
  let gatewayOwner: GatewayOwner | undefined;

  const close = async (): Promise<void> => {
    if (gatewayOwner) await gatewayOwner.close();
    if (supervisorOwner) await supervisorOwner.close();
    for (const webSocketServer of webSocketServers) {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
    }
    for (const server of servers) {
      if (server.listening) {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
    }
  };

  try {
    for (const socketPath of descriptor.socketPaths) {
      const server = createServer();
      const webSocketServer = new WebSocketServer({ server });
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(socketPath, resolveListen);
      });
      chmodSync(socketPath, 0o600);
      servers.push(server);
      webSocketServers.push(webSocketServer);
    }
    supervisorOwner = new AppServerSupervisorOwner(
      descriptor.primarySocketPath,
      descriptor.topology,
    );
    await supervisorOwner.start();
    gatewayOwner = new GatewayOwner(configPath);
    await gatewayOwner.start();
    gatewayOwner.markReady();
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}

function table(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("测试配置表无效");
  }
  return value as Record<string, unknown>;
}

function writeManagedProviderFixture(
  codexHome: string,
  connectHome: string,
  definition: ModelProviderDefinition,
  mode: "switching" | "exclusive",
  apiKey = "sk-service-secret",
) {
  const providerDirectory = join(connectHome, "providers", definition.id);
  mkdirSync(providerDirectory, { recursive: true, mode: 0o700 });
  const catalogPath = join(providerDirectory, definition.catalogFileName);
  writeFileSync(catalogPath, managedModelCatalog(definition), { mode: 0o600 });
  const target = mode === "exclusive"
    ? join(codexHome, "config.toml")
    : join(codexHome, definition.profileFileName);
  writeFileSync(target, stringify({
    model: definition.defaultModel,
    model_provider: definition.id,
    model_reasoning_effort: definition.defaultReasoningEffort,
    model_catalog_json: catalogPath,
    model_providers: {
      [definition.id]: {
        name: definition.id,
        base_url: definition.baseUrl,
        wire_api: definition.wireApi,
        requires_openai_auth: false,
        ...(definition.supportsWebsockets === undefined
          ? {}
          : { supports_websockets: definition.supportsWebsockets }),
        experimental_bearer_token: apiKey,
      },
    },
  }), { mode: 0o600 });
  writeFileSync(
    join(providerDirectory, definition.managedMarkerFileName),
    stringify({ version: 1, provider: definition.id, mode }),
    { mode: 0o600 },
  );
}

function managedModelCatalog(definition: ModelProviderDefinition): string {
  return `${JSON.stringify({
    models: definition.models.filter(({ available }) => available).map(({ slug }) => ({
      slug,
      display_name: slug,
      input_modalities: slug.includes("vision") ? ["text", "image"] : ["text"],
      context_window: 1_048_576,
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "high", description: "High" },
        { effort: "max", description: "Max" },
      ],
    })),
  })}\n`;
}

function exportedMetricsPath(output: string): string {
  const match = /^已导出：(.+)$/mu.exec(output);
  if (!match?.[1]) throw new Error(`未找到导出路径：${output}`);
  return match[1];
}

async function forEachWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex]!;
        nextIndex += 1;
        await visit(value);
      }
    },
  );
  await Promise.all(workers);
}

function runCliProcess(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectProcess);
    child.once("close", (status) => {
      resolveProcess({ status, stdout, stderr });
    });
  });
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  failure: () => Error | undefined = () => undefined,
): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    const error = failure();
    if (error) throw error;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`等待测试条件超时（${timeoutMs} ms）`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function readCapturedInitialization(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return JSON.parse(readFileSync(path, "utf8")).initialized === true;
  } catch {
    return false;
  }
}

function signalTestProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

function signalTestProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

function metricsSample(index: number): ModelRequestMetricSample {
  const now = Date.now();
  return {
    provider: "deepseek",
    pricing: null,
    transport: "http",
    responseFormat: "sse",
    operation: "response",
    threadId: `thread-${index}`,
    turnId: `turn-${index}`,
    model: "deepseek-v4-flash",
    serviceTier: "default",
    reasoningEffort: "max",
    status: "completed",
    httpStatus: 200,
    errorType: null,
    errorCode: null,
    errorMessage: null,
    incompleteReason: null,
    inputTokens: 1_000,
    cachedInputTokens: 900,
    outputTokens: 100,
    reasoningOutputTokens: 40,
    totalTokens: 1_100,
    upstreamCreatedAt: null,
    upstreamCompletedAt: null,
    requestStartedAtMs: now - 200,
    firstTokenAtMs: now - 150,
    firstReasoningDeltaAtMs: now - 150,
    lastReasoningDeltaAtMs: now - 100,
    firstOutputDeltaAtMs: now - 90,
    lastOutputDeltaAtMs: now - 50,
    responseCompletedAtMs: now,
    weeklyQuota: null,
  };
}
