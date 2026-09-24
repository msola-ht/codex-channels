import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  modelRequestMetricsSchemaVersion,
  requestMetricsDatabasePath,
  SqliteModelRequestMetricsStore,
  type ModelRequestMetricSample,
} from "../src/observability/index.js";
import { cli, forEachWithConcurrency, mkdtempSync, runCliProcess } from "./codexc-cli-test-fixture.js";

const temporaryDirectories: string[] = [];

function metricsSample(index: number): ModelRequestMetricSample {
  const now = Date.now();
  return {
    provider: "ds-test",
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
    requestStartedAtMs: now - 200,
    responseCompletedAtMs: now,
    weeklyQuota: null,
  };
}

function exportedMetricsPath(output: string): string {
  const match = /^已导出：(.+)$/mu.exec(output);
  if (!match?.[1]) throw new Error(`未找到导出路径：${output}`);
  return match[1];
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("codexc CLI", { timeout: 15_000 }, () => {
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
    for (const extra of [[], ["--stdout"]]) {
      const quota = spawnSync(cli, ["metrics", "quota", "--format", "json", ...extra], {
        cwd: workspace, encoding: "utf8", env: environment,
      });
      expect(quota.status, quota.stderr).toBe(0);
      expect(JSON.parse(quota.stdout)).toMatchObject({ format: "codex-connect-quota-history", periods: [] });
    }

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

  it("validates help paths before loading configuration and reaches uninstall identity checks with broken config", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-help-boundary-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "config.toml");
    writeFileSync(configPath, "[broken");
    const env = { ...process.env, CODEX_CONNECT_HOME: root, CODEX_CONNECT_CONFIG_FILE: configPath, CODEX_HOME: join(root, "codex") };
    const validPaths = [["security", "repair"], ...["add", "list", "switch", "remove"].map((action) => ["primary-provider", action])];
    const invalidPaths = [
      ["desktop-app", "nonsense"], ["opencode-go", "nonsense", "add"],
      ["deepseek", "nonsense"], ["ccg", "nonsense"],
      ["primary-provider", "remove", "some-id"],
      ["opencode-go", "account", "add", "some-id"],
    ];
    const cases = ["-h", "--help"].flatMap((flag) => [
      ...validPaths.map((path) => ({ args: [...path, flag], status: 0 })),
      ...invalidPaths.map((path) => ({ args: [...path, flag], status: 1 })),
    ]);
    await forEachWithConcurrency(cases, 8, async ({ args, status }) => {
      const result = await runCliProcess(args, { env });
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(status);
      expect(status === 0 ? result.stdout : result.stderr).toContain("用法");
      if (status !== 0) expect(result.stderr).not.toContain("语法无效");
    });
    const uninstall = spawnSync(process.execPath, [cli, "uninstall"], { env, encoding: "utf8" });
    expect(uninstall.status).toBe(1);
    expect(uninstall.stderr).toContain("当前不是受管 Git 源码安装");
    expect(readFileSync(configPath, "utf8")).toBe("[broken");
  });

  it("shows scoped help for every public command without requiring configuration", async () => {
    const cases = [
      [["init", "-h"], "用法：codexc init"],
      [["setup", "--help"], "用法：codexc setup"],
      [["start", "-h"], "用法：codexc start"],
      [["remote", "-h"], "用法：codexc remote"],
      [["desktop-app", "--help"], "用法：codexc desktop-app"],
      [["desktop-app", "enable", "-h"], "enable [--port 端口]"],
      [["desktop-app", "disable", "--help"], "disable"],
      [["desktop-app", "status", "-h"], "status [--json]"],
      [["desktop-app", "open", "--help"], "open"],
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
      [["timezone", "-h"], "用法：codexc timezone"],
      [["doctor", "--help"], "用法：codexc doctor"],
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
      [["metrics", "-h"], "用法：codexc metrics"],
      [["cleanup", "-h"], "用法：codexc cleanup"],
      [["cleanup", "--help"], "用法：codexc cleanup"],
      [["cleanup"], "用法：codexc cleanup"],
      [["metrics", "status", "--help"], "用法：codexc metrics status"],
      [["metrics", "run", "--help"], "用法：codexc metrics run"],
      [["metrics", "turns", "--help"], "用法：codexc metrics turns"],
      [["metrics", "threads", "--help"], "用法：codexc metrics threads"],
      [["metrics", "reset", "-h"], "用法：codexc metrics reset"],
      [["metrics", "cleanup", "--help"], "用法：codexc metrics cleanup"],
      [["metrics", "prune", "--help"], "用法：codexc metrics prune"],
      [["metrics", "report", "-h"], "用法：codexc metrics report"],
      [["metrics", "export", "--help"], "用法：codexc metrics export"],
      [["metrics", "quota", "--help"], "用法：codexc metrics quota"],
      [["channel", "-h"], "用法：codexc channel"],
      [["channel", "send-image", "--help"], "用法：codexc channel send-image"],
      [["traffic", "-h"], "用法：codexc traffic"],
      [["traffic", "cleanup", "--help"], "用法：codexc traffic cleanup"],
      [["webui", "-h"], "用法：codexc webui"],
      [["version", "-h"], "用法：codexc version"],
    ] as const;

    const detailedCases = [
      {
        args: ["config", "--help"],
        includes: ["codexc config [--json]", "脱敏配置总览", "网络代理"],
        excludes: ["Thread 分区管理员"],
      },
      {
        args: ["setup", "--help"],
        includes: [
          "OpenAI 官方 → 登录并恢复官方",
          "受管 Provider 模型设置",
        ],
      },
      { args: ["work", "--help"], includes: ["权限"] },
      { args: ["work", "add", "--help"], includes: ["--cwd 指定的目录"] },
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
        includes: ["sf-ocg-<账户>", "sf-ccg-<账户>", "sf-custom-<Provider ID>"],
      },
      {
        args: ["channel", "--help"],
        includes: ["渠道图片能力", "Thread 绑定渠道的机器人凭据"],
        excludes: ["图片等媒体"],
      },
      {
        args: ["update", "--help"],
        includes: ["数据库升级未完成时不启动服务", "当前数据库基线无迁移写入", "执行目标版本的数据库升级入口"],
      },
      { args: ["doctor", "--help"], includes: ["codexc doctor [--json]"] },
      {
        args: ["--help"],
        includes: ["version, -v, --version"],
      },
    ];
    const helpCases = new Map<string, { args: readonly string[]; includes: string[]; excludes: string[] }>();
    for (const entry of [
      ...cases.map(([args, expected]) => ({ args, includes: [expected], excludes: [] as string[] })),
      ...detailedCases,
    ]) {
      const key = JSON.stringify(entry.args);
      const previous = helpCases.get(key);
      helpCases.set(key, {
        args: entry.args,
        includes: [...(previous?.includes ?? []), ...entry.includes],
        excludes: [...(previous?.excludes ?? []), ...(entry.excludes ?? [])],
      });
    }
    await forEachWithConcurrency([...helpCases.values()], 8, async ({ args, includes, excludes }) => {
      const result = await runCliProcess(args);
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
      for (const expected of includes) expect(result.stdout).toContain(expected);
      for (const excluded of excludes) expect(result.stdout).not.toContain(excluded);
      expect(result.stderr).toBe("");
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
      "primary-provider",
      "opencode-go",
      "metrics",
      "channel",
      "webui",
      "start",
      "service",
      "update",
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

  it.skipIf(process.platform === "win32")("preserves provider and errors in machine-readable reports", () => {
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
    const store = new SqliteModelRequestMetricsStore(
      requestMetricsDatabasePath(join(home, "data", "gateway.sqlite3")),
    );
    store.record({
      ...metricsSample(1),
      provider: "openai",
      model: "shared-model",
    });
    store.record({
      ...metricsSample(2),
      provider: "ds-test",
      model: "shared-model",
    });
    store.record({
      ...metricsSample(3),
      provider: "ds-test",
      model: "shared-model",
      status: "failed",
      httpStatus: 429,
      errorType: "rate_limit",
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
    expect(report.report.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "ds-test",
        model: "shared-model",
        aggregate: expect.objectContaining({ requestCount: expect.any(Number) }),
      }),
      expect.objectContaining({
        provider: "openai",
        model: "shared-model",
        aggregate: expect.objectContaining({ requestCount: expect.any(Number) }),
      }),
    ]));
    expect(report.errors.groups).toEqual([
      expect.objectContaining({ provider: "ds-test", errorType: "rate_limit" }),
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
    expect(header).toContain("errorType");
    expect(header).toContain("lastOccurredAtMs");
    expect(rows).toEqual(expect.arrayContaining([
      expect.stringMatching(/^group,ds-test,shared-model,/u),
      expect.stringMatching(/^group,openai,shared-model,/u),
      expect.stringMatching(/^error,ds-test,shared-model,/u),
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
    const store = new SqliteModelRequestMetricsStore(
      requestMetricsDatabasePath(join(home, "data", "gateway.sqlite3")),
    );
    for (let model = 0; model < 20; model += 1) {
      store.record({
        ...metricsSample(model * 2),
        model: `deepseek-model-${model}`,
      });
      store.record({
        ...metricsSample((model * 2) + 1),
        model: `deepseek-model-${model}`,
      });
    }
    store.record({
      ...metricsSample(100),
      provider: "openai",
      model: "openai-hidden-model",
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
      group.provider === "ds-test"
    )).toBe(true);
  });


});
