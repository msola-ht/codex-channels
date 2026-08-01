import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

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
  EncryptedFileWeixinCredentialStore,
  EncryptedFileWeixinReplyContextPersistence,
  FileWeixinUpdatesCursorStore,
} from "../src/surfaces/weixin/index.js";

const temporaryDirectories: string[] = [];
const cli = resolve("bin/codexc.mjs");
const execFileAsync = promisify(execFile);
const linuxIt = process.platform === "linux" ? it : it.skip;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("codexc CLI", () => {
  it("shows scoped help for every public command without requiring configuration", () => {
    const cases = [
      [["init", "-h"], "用法：codexc init"],
      [["setup", "--help"], "用法：codexc setup"],
      [["start", "-h"], "用法：codexc start"],
      [["remote", "-h"], "用法：codexc remote"],
      [["ws", "-h"], "用法：codexc ws"],
      [["ws", "add", "-h"], "用法：codexc ws add"],
      [["ws", "remove", "--help"], "用法：codexc ws remove"],
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
      [["version", "-h"], "用法：codexc version"],
      [["gateway", "-h"], "用法：codexc gateway"],
      [["service-app-server", "--help"], "用法：codexc service-app-server"],
    ] as const;

    for (const [args, expected] of cases) {
      const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(expected);
      expect(result.stderr).toBe("");
    }
  }, 15_000);

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
    mkdirSync(join(project, ".git"));
    writeFileSync(rulesPath, 'prefix_rule(pattern = ["git", "status"], decision = "allow")\n');
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CODEX_RULES_CAPTURE, JSON.stringify(process.argv.slice(2)));",
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
    expect(output).toContain("项目 Codex 规则检查通过");
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
    expect(rejected.stderr).toContain("项目规则已存在");
    expect(readFileSync(rulesPath, "utf8")).toBe("custom rules\n");

    const replaced = execFileSync(process.execPath, [cli, "rules", "init", "--force"], {
      cwd: project,
      env: environment,
      encoding: "utf8",
    });
    expect(replaced).toContain("项目 Codex 规则已重新生成");
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
  });

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
    const firstAdded = execFileSync(process.execPath, [cli, "ws", "add"], {
      cwd: first,
      env: environment,
      encoding: "utf8",
    });
    const added = execFileSync(process.execPath, [cli, "ws", "add"], {
      cwd: second,
      env: environment,
      encoding: "utf8",
    });
    const listed = execFileSync(process.execPath, [cli, "ws"], {
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
    expect(added).toContain("Gateway 会自动热加载");
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

    const rejected = spawnSync(process.execPath, [cli, "ws", "add"], {
      cwd: current,
      env: environment,
      encoding: "utf8",
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("codexc ws add --prune-missing");
    expect(rejected.stderr).not.toContain("ENOENT");

    const repaired = execFileSync(
      process.execPath,
      [cli, "ws", "add", "--prune-missing"],
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
    execFileSync(process.execPath, [cli, "ws", "add"], { cwd: project, env: environment });
    rmSync(project, { recursive: true });

    const listed = execFileSync(process.execPath, [cli, "ws"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    const removed = execFileSync(process.execPath, [cli, "ws", "remove", "temporary-project"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    const relisted = execFileSync(process.execPath, [cli, "ws"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    const rejected = spawnSync(process.execPath, [cli, "ws", "remove", "1"], {
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
    execFileSync(process.execPath, [cli, "ws", "add"], { cwd: project, env: environment });
    const queuePath = configEventQueuePath(home);
    acknowledgeConfigEvents(
      queuePath,
      readConfigEvents(queuePath).map((event) => event.id),
    );
    const before = readFileSync(join(home, "config.toml"), "utf8");

    execFileSync(process.execPath, [cli, "ws", "remove", "project"], {
      cwd: root,
      env: environment,
    });
    execFileSync(process.execPath, [cli, "ws", "add"], {
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

  it("runs remote in the invocation directory unless a workspace is explicit", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const first = join(root, "First Project");
    const second = join(root, "Second Project");
    mkdirSync(first);
    mkdirSync(second);
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
    execFileSync(process.execPath, [cli, "ws", "add"], { cwd: first, env: environment });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      table(document.codex).binary = fakeCodex;
    });
    execFileSync(process.execPath, [cli, "ws", "add"], { cwd: second, env: environment });

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

    expect(JSON.parse(readFileSync(currentCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(first),
      "resume",
    ]);
    expect(JSON.parse(readFileSync(explicitCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(second),
      "resume",
    ]);
  });

  it("routes the DeepSeek profile to its isolated remote App Server and authenticates the TUI", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-remote-profile-"));
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
    writeFileSync(
      join(codexHome, "deepseek.config.toml"),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        'model_reasoning_effort = "high"',
        `model_catalog_json = ${JSON.stringify(join(codexHome, "deepseek.models.json"))}`,
        "[model_providers.deepseek]",
        'name = "deepseek"',
        'base_url = "https://api.deepseek.com/"',
        'wire_api = "responses"',
        "requires_openai_auth = false",
        'experimental_bearer_token = "sk-test-secret"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "codex-connect-deepseek.config.toml"),
      'version = 1\nprovider = "deepseek"\nmode = "switching"\n',
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

    for (const [index, args] of [
      ["--profile", "deepseek"],
      ["--profile=deepseek"],
      ["-p", "deepseek"],
      ["-p=deepseek"],
      ["-pdeepseek"],
    ].entries()) {
      const capturePath = join(root, `capture-${index}.json`);
      const result = spawnSync(process.execPath, [cli, "remote", ...args, "resume"], {
        cwd: workspace,
        env: { ...environment, CODEX_TEST_CAPTURE: capturePath },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual([
        "--remote",
        `unix://${join(home, "runtime", "codex-app-server-deepseek.sock")}`,
        "-C",
        realpathSync(workspace),
        "--profile",
        "deepseek",
        "resume",
      ]);
    }
  });

  it("starts the App Server through the service entry with effective proxy settings", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-entry-"));
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
      "  cwd: process.cwd(),",
      "  httpsProxy: process.env.HTTPS_PROXY,",
      "  lowerHttpsProxy: process.env.https_proxy,",
      "  serviceRole: process.env.CODEX_CONNECT_SERVICE_ROLE,",
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
      cwd: realpathSync(join(home, "workspace")),
      httpsProxy: "http://127.0.0.1:8899",
      lowerHttpsProxy: "http://127.0.0.1:8899",
      serviceRole: "app-server",
    });
  });

  it("starts isolated OpenAI and DeepSeek App Servers without exposing the key", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-provider-"));
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
      "  apiKey: process.env.CODEX_CONNECT_DEEPSEEK_API_KEY,",
      "}) + '\\n');",
      "await new Promise((resolve) => setTimeout(resolve, 100));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    writeFileSync(
      join(codexHome, "deepseek.config.toml"),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        'model_reasoning_effort = "high"',
        `model_catalog_json = ${JSON.stringify(join(codexHome, "deepseek.models.json"))}`,
        "[model_providers.deepseek]",
        'name = "deepseek"',
        'base_url = "https://api.deepseek.com/"',
        'wire_api = "responses"',
        "requires_openai_auth = false",
        'experimental_bearer_token = "sk-service-secret"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "codex-connect-deepseek.config.toml"),
      'version = 1\nprovider = "deepseek"\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "deepseek.models.json"),
      '{"models":[{"slug":"deepseek-v4-flash"}]}\n',
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
    expect(captures).toHaveLength(2);
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
    expect(deepseekCapture?.args).toEqual([
        "-c",
        'model="deepseek-v4-flash"',
        "-c",
        'model_provider="deepseek"',
        "-c",
        'model_reasoning_effort="high"',
        "-c",
        'service_tier="default"',
        "-c",
        `model_catalog_json=${JSON.stringify(join(codexHome, "deepseek.models.json"))}`,
        "-c",
        'model_providers.deepseek.name="deepseek"',
        "-c",
        'model_providers.deepseek.wire_api="responses"',
        "-c",
        'model_providers.deepseek.env_key="CODEX_CONNECT_DEEPSEEK_API_KEY"',
        "-c",
        "model_providers.deepseek.requires_openai_auth=false",
        "-c",
        expect.stringMatching(
          /^model_providers\.deepseek\.base_url="http:\/\/127\.0\.0\.1:\d+"$/u,
        ),
        "app-server",
        "--listen",
        `unix://${join(home, "runtime", "codex-app-server-deepseek.sock")}`,
      ]);
    expect(captures.find(({ args }) => args.includes('model_provider="deepseek"'))?.apiKey)
      .toBe("sk-service-secret");
    expect(JSON.stringify(captures.map(({ args }) => args))).not.toContain("sk-service-secret");
  });

  it("owns the automatic provider proxy in the App Server service without a running Gateway", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-proxy-"));
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
      "const baseUrlArg = process.argv.slice(2).find((value) => value.startsWith('model_providers.deepseek.base_url='));",
      "if (!baseUrlArg) { await new Promise((resolve) => setTimeout(resolve, 500)); process.exit(0); }",
      "const baseUrl = JSON.parse(baseUrlArg.slice(baseUrlArg.indexOf('=') + 1));",
      "const status = await new Promise((resolve) => {",
      "  const request = get(new URL('/health', baseUrl), (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });",
      "  request.on('error', () => resolve(0));",
      "});",
      "writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify({ baseUrl, status }));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    writeFileSync(
      join(codexHome, "deepseek.config.toml"),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        'model_reasoning_effort = "high"',
        `model_catalog_json = ${JSON.stringify(join(codexHome, "deepseek.models.json"))}`,
        "[model_providers.deepseek]",
        'name = "deepseek"',
        'base_url = "https://api.deepseek.com/"',
        'wire_api = "responses"',
        "requires_openai_auth = false",
        'experimental_bearer_token = "sk-service-secret"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "codex-connect-deepseek.config.toml"),
      'version = 1\nprovider = "deepseek"\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "deepseek.models.json"),
      '{"models":[{"slug":"deepseek-v4-flash"}]}\n',
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

    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      baseUrl: string;
      status: number;
    };
    expect(captured.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(captured.status).toBe(404);
  });

  it("rejects the removed manual ds_proxy configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-proxy-mode-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\n");
    chmodSync(fakeCodex, 0o700);
    writeFileSync(
      join(codexHome, "codex-connect-deepseek.config.toml"),
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

  it("documents the launchd uninstall command", () => {
    const output = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });

    expect(output).toContain("service uninstall");
    expect(output).toContain("service reload");
    expect(output).toContain("service logs");
    expect(output).toContain("保留用户数据");
    expect(output).toContain("setup ");
  });

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

  linuxIt("rejects App Server self-restart while allowing a Gateway restart", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-role-"));
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
      CODEX_CONNECT_SERVICE_ROLE: "app-server",
      SYSTEMCTL_BINARY: fakeSystemctl,
      SYSTEMCTL_LOG: systemctlLog,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });

    for (const target of ["app-server", "all"]) {
      const result = spawnSync(
        process.execPath,
        [cli, "service", "restart", target],
        { cwd: workspace, env: environment, encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("不能在 Codex App Server 内重启 App Server");
    }
    expect(existsSync(systemctlLog) ? readFileSync(systemctlLog, "utf8") : "").toBe("");

    const gateway = spawnSync(
      process.execPath,
      [cli, "service", "restart", "gateway"],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );
    expect(gateway.status).toBe(0);
    expect(readFileSync(systemctlLog, "utf8")).toContain(
      "--user restart codex-connect-gateway.service",
    );
    expect(readFileSync(systemctlLog, "utf8")).not.toContain(
      "codex-connect-app-server.service",
    );
  });

  it("rejects the removed workspace command alias", () => {
    const result = spawnSync(process.execPath, [cli, "workspace"], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("未知命令：workspace");
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
    execFileSync(process.execPath, [cli, "ws"], {
      cwd: workspace,
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
    });
    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
      encoding: "utf8",
    });

    const parsed = readGatewayConfig(configPath);
    expect(output).toContain(`配置文件：${configPath}`);
    expect(table(parsed.codex).socket_path).toBe("runtime/codex-app-server.sock");
    expect(table(parsed.storage).database_path).toBe("data/gateway.sqlite3");
    expect(statSync(profile).mode & 0o777).toBe(0o755);
    expect(statSync(join(profile, "runtime")).mode & 0o777).toBe(0o700);
    expect(statSync(join(profile, "data")).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(diagnosed.stdout).not.toContain("[失败] 配置目录权限");
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
    expect(enabled.stdout).toContain(
      "[通过] 微信配置：已启用，允许 1 个用户",
    );
    expect(enabled.stdout).toContain(
      "[通过] 微信连接：安全凭据存在且载荷有效",
    );
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
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-"));
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

    try {
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
      expect(stdout).toContain(`[通过] Codex CLI：${expectedCodexCliVersion}`);
      expect(stdout).toContain("[通过] Codex App Server：initialize 握手通过");
      expect(stdout).toContain(
        `[通过] App Server 版本：${expectedAppServerVersion}（要求 ${expectedAppServerVersion}）`,
      );
      expect(stdout).toContain("诊断通过");
      expect(stdout).not.toContain(secret);
      expect(initializedReceived).toBe(true);

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
});

function updateGatewayConfig(
  configPath: string,
  update: (document: Record<string, unknown>) => void,
): void {
  const document = readGatewayConfig(configPath);
  update(document);
  writeGatewayConfig(configPath, document);
}

function table(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("测试配置表无效");
  }
  return value as Record<string, unknown>;
}
