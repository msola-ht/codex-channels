import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appServerSupervisorSocketPath,
  inspectAppServerSupervisor,
  sameAppServerTopology,
} from "../runtime/app-server-supervisor.mjs";
import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import type { ApprovalRequest } from "../src/approval/index.js";
import { CodexAppServerClient } from "../src/codex-client/client.js";
import {
  handleApprovalServerRequest,
  toConversationInputEvent,
  toThreadStateEvent,
} from "../src/codex-client/index.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { UnixWebSocketTransport } from "../src/codex-client/unix-websocket-transport.js";
import { StdioTransport } from "../src/codex-client/stdio-transport.js";

const run = process.env.RUN_CODEX_INTEGRATION === "1";
const suite = run ? describe : describe.skip;
const runContract = process.env.RUN_CODEX_CONTRACT === "1";
const contractSuite = runContract ? describe : describe.skip;
const deepseekCatalogPath = process.env.CODEX_DEEPSEEK_MODEL_CATALOG;
const deepseekCatalogContractTest = runContract ? it : it.skip;
const archiveFixtureThreadId = process.env.CODEX_ARCHIVE_FIXTURE_THREAD_ID;
const archiveTest = run && archiveFixtureThreadId ? it : it.skip;
const resumeFixtureThreadId = process.env.CODEX_RESUME_FIXTURE_THREAD_ID;
const resumeTest = run && resumeFixtureThreadId ? it : it.skip;
const forkTest = run && resumeFixtureThreadId ? it : it.skip;

suite("real Codex App Server over Unix WebSocket", () => {
  const workdir = process.cwd();
  const runtimeRoot = resolve(".runtime");
  let testRuntime: string;
  let socketPath: string;
  let processHandle: ChildProcess;
  let client: CodexAppServerClient;
  let peerRpc: JsonRpcClient;
  let peerClient: CodexAppServerClient;
  let upstreamUserAgent = "";
  let appServerStderr = "";

  beforeAll(async () => {
    mkdirSync(runtimeRoot, { recursive: true });
    testRuntime = mkdtempSync(join(runtimeRoot, "integration-"));
    socketPath = join(testRuntime, "app-server.sock");
    processHandle = spawn("codex", ["app-server", "--listen", `unix://${socketPath}`], {
      cwd: workdir,
      stdio: ["ignore", "ignore", "pipe"],
    });
    processHandle.stderr?.setEncoding("utf8");
    processHandle.stderr?.on("data", (chunk: string) => {
      appServerStderr = appendDiagnostic(appServerStderr, chunk);
    });
    await waitFor(
      () => existsSync(socketPath),
      10_000,
      () => processHandle.exitCode === null
        ? undefined
        : new Error(appServerFailure("Codex App Server 在创建 Unix Socket 前退出", appServerStderr)),
    );
    const transport = new UnixWebSocketTransport(socketPath);
    client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "read-only",
    });
    peerRpc = new JsonRpcClient(new UnixWebSocketTransport(socketPath));
    peerClient = new CodexAppServerClient(peerRpc, { sandbox: "read-only" });
    const initialized = await client.connect();
    await peerClient.connect();
    upstreamUserAgent = initialized.userAgent;
  }, 15_000);

  afterAll(async () => {
    await peerClient?.close();
    await client?.close();
    if (processHandle?.exitCode === null) {
      processHandle.kill("SIGTERM");
      await new Promise((resolveExit) => processHandle.once("exit", resolveExit));
    }
    if (testRuntime) {
      rmSync(testRuntime, { recursive: true, force: true });
    }
  });

  it("lists native threads without starting a turn", async () => {
    const threads = await client.listThreads(workdir);
    const archived = await client.listThreads(workdir, { archived: true });
    expect(Array.isArray(threads)).toBe(true);
    expect(Array.isArray(archived)).toBe(true);
    pino({ enabled: false }).info({ count: threads.length });
  });

  it("reports the upstream user agent used by Codex", () => {
    expect(upstreamUserAgent).toContain("codex_connect_gateway/");
  });

  it("reads account rate-limit snapshots without starting a turn", async () => {
    const result = await client.accountRateLimits();

    expect(result.limits.length).toBeGreaterThan(0);
    expect(result.limits[0]?.primary === null
      || typeof result.limits[0]?.primary?.usedPercent === "number").toBe(true);
  });

  it("lists models with their supported reasoning efforts", async () => {
    const models = await client.listModels();

    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.supportedReasoningEfforts.length > 0)).toBe(true);
  });

  it("lists directly installed Skills through the stable query result", async () => {
    const skills = await client.listSkills(workdir);

    expect(Array.isArray(skills)).toBe(true);
    expect(skills.every((skill) =>
      typeof skill.name === "string" && typeof skill.description === "string")).toBe(true);
  });

  it("lists installed Plugins without loading remote catalog entries", async () => {
    const plugins = await client.listPlugins(workdir);

    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins.every((plugin) =>
      typeof plugin.id === "string"
      && typeof plugin.name === "string"
      && typeof plugin.enabled === "boolean"
      && typeof plugin.available === "boolean")).toBe(true);
  });

  it("broadcasts and exposes a loaded temporary thread across two clients without running a model turn", async () => {
    let observedThreadId: string | undefined;
    const removePeerNotification = peerClient.onNotification((notification) => {
      if (notification.method !== "thread/started") {
        return;
      }
      const params = typeof notification.params === "object" && notification.params !== null
        ? notification.params as Record<string, unknown>
        : {};
      const thread = typeof params.thread === "object" && params.thread !== null
        ? params.thread as Record<string, unknown>
        : {};
      if (typeof thread.id === "string") {
        observedThreadId = thread.id;
      }
    });
    const started = await client.startThread(workdir);
    try {
      await waitFor(() => observedThreadId === started.thread.id, 2_000);
      const loaded = await peerRpc.request<{ data: string[] }>({
        method: "thread/loaded/list",
        params: { limit: 100 },
      }, { retryOverload: true });
      await client.unsubscribeThread(started.thread.id);

      expect(started.thread.id).toBeTruthy();
      expect(observedThreadId).toBe(started.thread.id);
      expect(loaded.data).toContain(started.thread.id);
    } finally {
      removePeerNotification();
      await client.unsubscribeThread(started.thread.id).catch(() => undefined);
      await client.deleteThread(started.thread.id);
    }
  });

  resumeTest("reads and resumes an explicitly selected idle fixture thread from both clients", async () => {
    const threadId = resumeFixtureThreadId!;
    const fixture = await client.readThread(threadId);
    expect(fixture.cwd).toBe(workdir);
    expect(fixture.status.type).not.toBe("active");

    let ownerSubscribed = false;
    let peerSubscribed = false;
    try {
      const ownerResumed = await client.resumeThread(threadId, workdir);
      ownerSubscribed = true;
      const peerRead = await peerClient.readThread(threadId);
      const peerResumed = await peerClient.resumeThread(threadId, workdir);
      peerSubscribed = true;

      expect(ownerResumed.thread.id).toBe(threadId);
      expect(peerRead.id).toBe(threadId);
      expect(peerRead.cwd).toBe(workdir);
      expect(peerResumed.thread.id).toBe(threadId);
    } finally {
      if (peerSubscribed) {
        await peerClient.unsubscribeThread(threadId).catch(() => undefined);
      }
      if (ownerSubscribed) {
        await client.unsubscribeThread(threadId).catch(() => undefined);
      }
    }
  });

  forkTest("forks an idle history thread with explicit provider settings", async () => {
    const source = await client.resumeThread(resumeFixtureThreadId!, workdir);
    let forkedId: string | undefined;
    try {
      const forked = await client.forkThread(source.thread.id, workdir, {
        model: source.model,
        modelProvider: source.modelProvider ?? "openai",
      });
      forkedId = forked.thread.id;

      expect(forked.thread.id).not.toBe(source.thread.id);
      expect(forked.model).toBe(source.model);
      expect(forked.modelProvider).toBe(source.modelProvider ?? "openai");
    } finally {
      if (forkedId) {
        await client.unsubscribeThread(forkedId).catch(() => undefined);
        await client.deleteThread(forkedId).catch(() => undefined);
      }
      await client.unsubscribeThread(source.thread.id).catch(() => undefined);
    }
  });

  archiveTest("archives and restores an explicitly selected idle fixture thread", async () => {
    const threadId = archiveFixtureThreadId!;
    const fixture = await client.readThread(threadId);
    expect(fixture.cwd).toBe(workdir);
    expect(fixture.status.type).not.toBe("active");

    let archived = false;
    try {
      await client.archiveThread(threadId);
      archived = true;
      const archivedThreads = await client.listThreads(workdir, { archived: true });
      expect(archivedThreads.some((thread) => thread.id === threadId)).toBe(true);

      const restored = await client.unarchiveThread(threadId);
      archived = false;
      expect(restored.id).toBe(threadId);
    } finally {
      if (archived) {
        await client.unarchiveThread(threadId);
      }
    }
  });
});

suite("real supervised App Server service", () => {
  it("starts the OpenAI metrics proxy and exposes the matching supervised App Server", async () => {
    const runtimeRoot = resolve(".runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    const testRuntime = mkdtempSync(join(runtimeRoot, "service-integration-"));
    const codexHome = join(testRuntime, "codex-home");
    const workspace = join(testRuntime, "workspace");
    const configPath = join(testRuntime, "config.toml");
    const socketPath = join(testRuntime, "codex-app-server.sock");
    const supervisorSocketPath = appServerSupervisorSocketPath(socketPath);
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeGatewayConfig(configPath, {
      version: 1,
      default_workspace: "integration",
      telegram: {
        bot_token: "integration-token",
        allowed_user_ids: [123],
        message_format: "html",
      },
      network: {},
      codex: {
        binary: process.env.CODEX_BINARY ?? "codex",
        socket_path: socketPath,
        sandbox: "workspace-write",
      },
      approval: { timeout_seconds: 300 },
      storage: { database_path: join(testRuntime, "gateway.sqlite3") },
      logging: { level: "info" },
      workspaces: [{ id: "integration", name: "Integration", cwd: workspace }],
    });

    let stdout = "";
    let stderr = "";
    let client: CodexAppServerClient | undefined;
    const service = spawn(
      process.execPath,
      [resolve("bin/codexc.mjs"), "service-app-server"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CODEX_CONNECT_HOME: testRuntime,
          CODEX_CONNECT_CONFIG_FILE: configPath,
          CODEX_HOME: codexHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    service.stdout?.setEncoding("utf8");
    service.stderr?.setEncoding("utf8");
    service.stdout?.on("data", (chunk: string) => {
      stdout = appendDiagnostic(stdout, chunk);
    });
    service.stderr?.on("data", (chunk: string) => {
      stderr = appendDiagnostic(stderr, chunk);
    });

    try {
      await waitFor(
        () => existsSync(socketPath) && stdout.includes("openai 模型统计代理已启动"),
        15_000,
        () => service.exitCode === null && service.signalCode === null
          ? undefined
          : new Error(appServerFailure(
              "service-app-server 在真实 App Server 就绪前退出",
              `${stdout}\n${stderr}`,
            )),
      );

      const topology = await inspectAppServerSupervisor(socketPath);
      expect(sameAppServerTopology(topology, {
        primaryProvider: "openai",
        socketPaths: [socketPath],
      })).toBe(true);

      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "read-only" },
      );
      const initialized = await client.connect();
      expect(initialized.userAgent).toContain("codex_connect_gateway/");
    } finally {
      try {
        await client?.close().catch(() => undefined);
        await stopTestProcess(service, 10_000);
        await waitFor(() => !existsSync(supervisorSocketPath), 2_000);
      } finally {
        rmSync(testRuntime, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

suite("real Codex App Server over stdio", () => {
  let client: CodexAppServerClient;

  afterAll(async () => {
    await client?.close();
  });

  it("uses the same client contract to initialize and list threads", async () => {
    const workdir = process.cwd();
    let appServerStderr = "";
    client = new CodexAppServerClient(
      new JsonRpcClient(new StdioTransport({
        codexBinary: "codex",
        cwd: workdir,
        onStderr: (chunk) => {
          appServerStderr = appendDiagnostic(appServerStderr, chunk);
        },
      })),
      { sandbox: "read-only" },
    );

    let initialized;
    let threads;
    try {
      initialized = await client.connect();
      threads = await client.listThreads(workdir);
    } catch (error) {
      throw new Error(
        appServerFailure(
          error instanceof Error ? error.message : String(error),
          appServerStderr,
        ),
        { cause: error },
      );
    }

    const platformNames: Partial<Record<NodeJS.Platform, string>> = {
      darwin: "macos",
      linux: "linux",
      win32: "windows",
    };
    const expectedPlatform = platformNames[process.platform];
    if (expectedPlatform) {
      expect(initialized.platformOs).toBe(expectedPlatform);
    } else {
      expect(initialized.platformOs).not.toBe("");
    }
    expect(Array.isArray(threads)).toBe(true);
  }, 15_000);
});

contractSuite("isolated Codex App Server state contract", () => {
  const workdir = process.cwd();
  const runtimeRoot = resolve(".runtime");
  let testRuntime: string;
  let codexHome: string;
  let socketPath: string;
  let processHandle: ChildProcess;
  let ownerRpc: JsonRpcClient;
  let ownerClient: CodexAppServerClient;
  let peerRpc: JsonRpcClient;
  let peerClient: CodexAppServerClient;
  let oauthServer: ReturnType<typeof createServer>;
  let oauthBaseUrl: string;
  let appServerStderr = "";

  beforeAll(async () => {
    mkdirSync(runtimeRoot, { recursive: true });
    testRuntime = mkdtempSync(join(runtimeRoot, "contract-"));
    codexHome = join(testRuntime, "codex-home");
    socketPath = join(testRuntime, "app-server.sock");
    oauthServer = createServer((request, response) => {
      if (
        request.method === "GET"
        && request.url === "/.well-known/oauth-authorization-server/oauth-mcp"
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          authorization_endpoint: `${oauthBaseUrl}/authorize`,
          token_endpoint: `${oauthBaseUrl}/token`,
          scopes_supported: ["read"],
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/token") {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          access_token: "contract-access-token",
          token_type: "Bearer",
          expires_in: 3_600,
          refresh_token: "contract-refresh-token",
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      oauthServer.once("error", rejectListen);
      oauthServer.listen(0, "127.0.0.1", () => resolveListen());
    });
    const oauthAddress = oauthServer.address();
    if (!oauthAddress || typeof oauthAddress === "string") {
      throw new Error("MCP OAuth 合同无法创建本机 HTTP 夹具");
    }
    oauthBaseUrl = `http://127.0.0.1:${oauthAddress.port}`;
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const contractSkillDirectory = join(
      codexHome,
      "skills",
      "contract-skill",
    );
    mkdirSync(contractSkillDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(contractSkillDirectory, "SKILL.md"),
      [
        "---",
        "name: contract-skill",
        "description: Validate structured Skill input.",
        "---",
        "",
        "# Contract Skill",
        "",
        "Reply concisely.",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const pluginMarketplace = join(testRuntime, "contract-marketplace");
    const pluginManifestDirectory = join(
      pluginMarketplace,
      "plugins",
      "contract-plugin",
      ".codex-plugin",
    );
    mkdirSync(join(pluginMarketplace, ".git"), { recursive: true, mode: 0o700 });
    mkdirSync(join(pluginMarketplace, ".agents", "plugins"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(pluginManifestDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(pluginMarketplace, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        name: "contract-marketplace",
        plugins: [{
          name: "contract-plugin",
          source: {
            source: "local",
            path: "./plugins/contract-plugin",
          },
        }],
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(pluginManifestDirectory, "plugin.json"),
      JSON.stringify({
        name: "contract-plugin",
        interface: {
          displayName: "Contract Plugin",
          shortDescription: "Validate structured Plugin mention input.",
        },
      }),
      { mode: 0o600 },
    );
    const installedPluginManifestDirectory = join(
      codexHome,
      "plugins",
      "cache",
      "contract-marketplace",
      "contract-plugin",
      "local",
      ".codex-plugin",
    );
    mkdirSync(installedPluginManifestDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(installedPluginManifestDirectory, "plugin.json"),
      JSON.stringify({ name: "contract-plugin" }),
      { mode: 0o600 },
    );
    const approvalProbe = resolve(
      "tests/fixtures/mcp-tool-approval-server.mjs",
    );
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        'mcp_oauth_credentials_store = "file"',
        "",
        "[mcp_servers.approval_probe]",
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(approvalProbe)}]`,
        "",
        "[mcp_servers.oauth_probe]",
        `url = ${JSON.stringify(`${oauthBaseUrl}/oauth-mcp`)}`,
        'oauth = { client_id = "contract-oauth-client" }',
        "",
        "[features]",
        "plugins = true",
        "",
        "[marketplaces.contract-marketplace]",
        'source_type = "local"',
        `source = ${JSON.stringify(pluginMarketplace)}`,
        "",
        '[plugins."contract-plugin@contract-marketplace"]',
        "enabled = true",
        "",
        "[model_providers.deepseek]",
        'name = "deepseek"',
        'base_url = "https://api.deepseek.com/"',
        'wire_api = "responses"',
        'experimental_bearer_token = "sk-contract-placeholder"',
        "",
      ].join("\n"),
    );
    processHandle = spawn(
      process.env.CODEX_BINARY ?? "codex",
      ["app-server", "--listen", `unix://${socketPath}`],
      {
        cwd: workdir,
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    processHandle.stderr?.setEncoding("utf8");
    processHandle.stderr?.on("data", (chunk: string) => {
      appServerStderr = appendDiagnostic(appServerStderr, chunk);
    });
    await waitFor(
      () => existsSync(socketPath),
      10_000,
      () => processHandle.exitCode === null
        ? undefined
        : new Error(appServerFailure("隔离 Codex App Server 在创建 Unix Socket 前退出", appServerStderr)),
    );
    ownerRpc = new JsonRpcClient(new UnixWebSocketTransport(socketPath));
    ownerClient = new CodexAppServerClient(
      ownerRpc,
      { sandbox: "read-only" },
    );
    peerRpc = new JsonRpcClient(new UnixWebSocketTransport(socketPath));
    peerClient = new CodexAppServerClient(peerRpc, { sandbox: "read-only" });
    await ownerClient.connect();
    await peerClient.connect();
  }, 15_000);

  afterAll(async () => {
    await peerClient?.close();
    await ownerClient?.close();
    if (processHandle?.exitCode === null) {
      processHandle.kill("SIGTERM");
      await new Promise((resolveExit) => processHandle.once("exit", resolveExit));
    }
    if (oauthServer) {
      await new Promise<void>((resolveClose) => oauthServer.close(() => resolveClose()));
    }
    if (testRuntime) {
      rmSync(testRuntime, { recursive: true, force: true });
    }
  });

  it("maps the isolated App Server Skill list to stable installed entries", async () => {
    const skills = await ownerClient.listSkills(workdir);

    expect(Array.isArray(skills)).toBe(true);
    expect(skills.every((skill) =>
      typeof skill.name === "string" && typeof skill.description === "string")).toBe(true);
  });

  it("accepts the official Skill marker and structured input together", async () => {
    const skill = await ownerClient.resolveSkill(workdir, "contract-skill");
    expect(skill).toEqual({
      name: "contract-skill",
      path: join(codexHome, "skills", "contract-skill", "SKILL.md"),
    });
    if (!skill) {
      throw new Error("隔离 App Server 未返回 contract-skill");
    }
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    let turnId: string | undefined;
    try {
      const turn = await ownerClient.startTurn(
        threadId,
        [
          { type: "text", text: "$contract-skill 验证结构化调用" },
          {
            type: "skill",
            name: skill.name,
            path: skill.path,
          },
        ],
        "codex_connect_gateway:skill-contract",
        workdir,
      );
      turnId = turn.turnId;
      expect(turnId).not.toBe("");
    } finally {
      if (turnId !== undefined) {
        await ownerClient.interruptTurn(threadId, turnId).catch(() => undefined);
      }
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("maps the isolated App Server MCP list, details, and resources", async () => {
    await expect(ownerClient.reloadMcpServers()).resolves.toBeUndefined();
    const servers = await ownerClient.listMcpServers();

    expect(Array.isArray(servers)).toBe(true);
    expect(servers.every((server) =>
      typeof server.name === "string"
      && typeof server.authStatus === "string"
      && Number.isInteger(server.toolCount))).toBe(true);

    const details = await ownerClient.listMcpServerDetails();
    const approvalProbe = details.find((server) => server.name === "approval_probe");
    expect(approvalProbe?.serverVersion).toBe("1.0.0");
    expect(approvalProbe?.tools.some((tool) => tool.name === "approval_probe")).toBe(true);
    const approvalTool = approvalProbe?.tools.find((tool) => tool.name === "approval_probe");
    expect(approvalTool?.description).toHaveLength(2_000);
    expect(approvalTool?.description).toMatch(/^Emit approval details x+$/u);
    expect(approvalProbe?.resources).toContainEqual(expect.objectContaining({
      uri: "contract://status",
      name: "contract-status",
    }));

    await expect(ownerClient.readMcpResource(
      "approval_probe",
      "contract://status",
    )).resolves.toEqual({
      server: "approval_probe",
      requestedUri: "contract://status",
      contents: [{
        kind: "text",
        uri: "contract://status",
        mimeType: "text/plain",
        text: "contract resource ready",
        truncated: false,
      }],
      omittedContentCount: 0,
    });
  }, 15_000);

  it("maps the isolated App Server MCP OAuth completion notification", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    let observed: ReturnType<typeof toConversationInputEvent>;
    const removeNotification = ownerClient.onNotification((notification) => {
      const event = toConversationInputEvent(notification);
      if (event?.type === "mcp.oauth.completed" && event.name === "oauth_probe") {
        observed = event;
      }
    });
    try {
      const login = await ownerClient.startMcpOAuthLogin("oauth_probe", threadId);
      const authorizationUrl = new URL(login.authorizationUrl);
      expect(authorizationUrl.origin).toBe(oauthBaseUrl);
      expect(authorizationUrl.searchParams.get("client_id"))
        .toBe("contract-oauth-client");
      const state = authorizationUrl.searchParams.get("state");
      const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
      expect(state).not.toBeNull();
      expect(redirectUri).not.toBeNull();
      if (!state || !redirectUri) {
        throw new Error("MCP OAuth 授权地址缺少 state 或 redirect_uri");
      }
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", "contract-test-code");
      callbackUrl.searchParams.set("state", state);
      const callbackResponse = await fetch(callbackUrl);
      expect(callbackResponse.ok).toBe(true);

      await waitFor(() => observed !== undefined, 10_000);
      expect(observed).toEqual({
        type: "mcp.oauth.completed",
        threadId,
        name: "oauth_probe",
        success: true,
        error: null,
      });
    } finally {
      removeNotification();
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("maps the isolated App Server Plugin list to stable installed entries", async () => {
    const plugins = await ownerClient.listPlugins(workdir);

    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins.every((plugin) =>
      typeof plugin.id === "string"
      && typeof plugin.name === "string"
      && typeof plugin.enabled === "boolean"
      && typeof plugin.available === "boolean")).toBe(true);
  });

  it("accepts an installed Plugin marker and official mention input together", async () => {
    const plugin = await ownerClient.resolvePlugin(
      workdir,
      "contract-plugin@contract-marketplace",
    );
    expect(plugin).toEqual({
      id: "contract-plugin@contract-marketplace",
      name: "contract-plugin",
      displayName: "Contract Plugin",
      path: "plugin://contract-plugin@contract-marketplace",
    });
    if (!plugin) {
      throw new Error("隔离 App Server 未返回 contract-plugin");
    }
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    let turnId: string | undefined;
    try {
      const turn = await ownerClient.startTurn(
        threadId,
        [
          { type: "text", text: "@contract-plugin 验证结构化调用" },
          {
            type: "plugin",
            name: plugin.displayName,
            path: plugin.path,
          },
        ],
        "codex_connect_gateway:plugin-contract",
        workdir,
      );
      turnId = turn.turnId;
      expect(turnId).not.toBe("");
    } finally {
      if (turnId !== undefined) {
        await ownerClient.interruptTurn(threadId, turnId).catch(() => undefined);
      }
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("shares persisted Thread pin state across clients without local storage", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    try {
      await ownerClient.setThreadPinned(threadId, true);

      const peerRead = await peerClient.readThread(threadId);
      expect(peerRead.isPinned).toBe(true);

      await peerClient.setThreadPinned(threadId, false);
      await expect(ownerClient.readThread(threadId)).resolves
        .toMatchObject({ id: threadId, isPinned: false });
    } finally {
      await ownerClient.setThreadPinned(threadId, false).catch(() => undefined);
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("round-trips MCP tool approval metadata through the real App Server", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    let observed: ApprovalRequest | undefined;
    ownerClient.setServerRequestHandler((request) =>
      handleApprovalServerRequest(request, {
        handle: async (approval) => {
          observed = approval;
          return {
            type: "elicitation",
            action: "accept",
            content: null,
            persist: "session",
          };
        },
      }));
    try {
      const response = await ownerRpc.request<{
        content: Array<{ type?: unknown; text?: unknown }>;
        isError?: boolean;
      }>({
        method: "mcpServer/tool/call",
        params: {
          threadId,
          server: "approval_probe",
          tool: "approval_probe",
          arguments: { pull_number: 146 },
        },
      } as never);

      expect(observed).toMatchObject({
        type: "elicitation",
        threadId,
        turnId: null,
        serverName: "approval_probe",
        mode: "form",
        toolApproval: {
          connectorName: "GitHub",
          toolTitle: "Update pull request",
          parameters: [{
            name: "pull_number",
            displayName: "Pull request",
            value: 146,
          }],
          allowSession: true,
          allowAlways: true,
        },
      });
      expect(response.isError).toBe(false);
      expect(JSON.parse(String(response.content[0]?.text))).toEqual({
        action: "accept",
        content: {},
        _meta: { persist: "session" },
      });
    } finally {
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("maps the isolated App Server Permission Profile list to stable options", async () => {
    const profiles = await ownerClient.listPermissionProfiles(workdir);

    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles.every((profile) =>
      typeof profile.id === "string"
      && (profile.description === null || typeof profile.description === "string")
      && typeof profile.allowed === "boolean")).toBe(true);
  });

  it("accepts per-workspace sandbox, approval and permission profile overrides", async () => {
    const sandboxed = await ownerClient.startThread(workdir, {
      sandbox: "read-only",
      approvalPolicy: "untrusted",
    });
    const profiled = await ownerClient.startThread(workdir, {
      permissions: ":read-only",
    });

    expect(sandboxed.thread.id).not.toBe(profiled.thread.id);
    await ownerClient.unsubscribeThread(sandboxed.thread.id).catch(() => undefined);
    await ownerClient.unsubscribeThread(profiled.thread.id).catch(() => undefined);
    await ownerClient.deleteThread(sandboxed.thread.id).catch(() => undefined);
    await ownerClient.deleteThread(profiled.thread.id).catch(() => undefined);
  });

  it("lists the locked App Server collaboration presets", async () => {
    const modes = await ownerClient.listCollaborationModes();

    expect(modes.some((mode) => mode.mode === "default")).toBe(true);
    expect(modes.some((mode) =>
      mode.mode === "plan" && mode.effort === "medium")).toBe(true);
  });

  it("persists Fast defaults for peer reads and subsequently started threads", async () => {
    const startedThreadIds: string[] = [];
    try {
      await ownerClient.writeDefaultFastMode(false);
      await expectConfiguredTier(peerClient, workdir, "default");
      const standardThread = await ownerClient.startThread(workdir);
      startedThreadIds.push(standardThread.thread.id);
      expect(standardThread.serviceTier).toBe("default");
      expect(standardThread.contextCompactionItemIds).toEqual([]);

      await ownerClient.writeDefaultFastMode(true);
      await expectConfiguredTier(peerClient, workdir, "fast");
      const fastThread = await ownerClient.startThread(workdir);
      startedThreadIds.push(fastThread.thread.id);
      expect(fastThread.serviceTier).toBe("priority");

      await ownerClient.writeDefaultFastMode(false);
      await expectConfiguredTier(peerClient, workdir, "default");
      const restoredThread = await ownerClient.startThread(workdir);
      startedThreadIds.push(restoredThread.thread.id);
      expect(restoredThread.serviceTier).toBe("default");
    } finally {
      for (const threadId of startedThreadIds) {
        await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
        await ownerClient.deleteThread(threadId);
      }
    }
  }, 15_000);

  it("maps Turn and Goal results through the stable Application contract", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    const observedTurnIds: string[] = [];
    let observedPlanMode = false;
    let completedTurnDurationMs: number | undefined;
    const observedGoalEvents: string[] = [];
    const removeNotification = ownerClient.onNotification((notification) => {
      const event = toConversationInputEvent(notification);
      const threadState = toThreadStateEvent(notification);
      if (
        threadState?.type === "thread.settings.updated"
        && threadState.threadId === threadId
        && threadState.settings.collaborationMode === "plan"
      ) {
        observedPlanMode = true;
      }
      if (event?.type === "turn.started" && event.threadId === threadId) {
        observedTurnIds.push(event.turnId);
      }
      if (
        event?.type === "turn.completed"
        && event.threadId === threadId
        && event.turnId === turnId
      ) {
        completedTurnDurationMs = event.durationMs;
      }
      if (
        (event?.type === "thread.goal.updated" || event?.type === "thread.goal.cleared")
        && event.threadId === threadId
      ) {
        observedGoalEvents.push(event.type);
      }
    });
    let turnId: string | undefined;
    let peerSubscribed = false;
    try {
      const turn = await ownerClient.startTurn(
        threadId,
        [{ type: "text", text: "contract-only" }],
        "codex_connect_gateway:contract",
        workdir,
        {
          collaborationMode: {
            mode: "plan",
            settings: {
              model: started.model,
              effort: "medium",
              developerInstructions: null,
            },
          },
        },
      );
      turnId = turn.turnId;
      expect(turnId).not.toBe("");
      await waitFor(() => observedTurnIds.includes(turn.turnId), 2_000);
      await waitFor(() => observedPlanMode, 2_000);

      const updated = await ownerClient.setGoal(threadId, "验证稳定 Goal 映射");
      const read = await peerClient.getGoal(threadId);
      expect(updated.objective).toBe("验证稳定 Goal 映射");
      expect(read).toEqual(updated);
      await waitFor(
        () => observedGoalEvents.includes("thread.goal.updated"),
        2_000,
      );

      await peerClient.close();
      peerRpc = new JsonRpcClient(new UnixWebSocketTransport(socketPath));
      peerClient = new CodexAppServerClient(peerRpc, { sandbox: "read-only" });
      await peerClient.connect();
      let resumedGoalObjective: string | undefined;
      const removePeerNotification = peerClient.onNotification((notification) => {
        const event = toConversationInputEvent(notification);
        if (event?.type === "thread.goal.updated" && event.threadId === threadId) {
          resumedGoalObjective = event.goal.objective;
        }
      });
      try {
        const resumed = await peerClient.resumeThread(threadId, workdir);
        peerSubscribed = true;
        expect(resumed.contextCompactionItemIds).toEqual([]);
        await waitFor(
          () => resumedGoalObjective === updated.objective,
          2_000,
        );
      } finally {
        removePeerNotification();
      }

      await ownerClient.clearGoal(threadId);
      await expect(peerClient.getGoal(threadId)).resolves.toBeNull();
      await waitFor(
        () => observedGoalEvents.includes("thread.goal.cleared"),
        2_000,
      );
      await ownerClient.interruptTurn(threadId, turnId);
      await waitFor(
        () => completedTurnDurationMs !== undefined,
        2_000,
      );
      expect(completedTurnDurationMs).toBeGreaterThanOrEqual(0);
      turnId = undefined;
    } finally {
      removeNotification();
      if (turnId) {
        await ownerClient.interruptTurn(threadId, turnId).catch(() => undefined);
      }
      if (peerSubscribed) {
        await peerClient.unsubscribeThread(threadId).catch(() => undefined);
      }
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId).catch(() => undefined);
    }
  }, 15_000);

  it("accepts stable localAudio input through the real App Server", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    const audioPath = join(testRuntime, "contract-silence.wav");
    writeFileSync(audioPath, wavSilence());
    let turnId: string | undefined;
    try {
      const turn = await ownerClient.startTurn(
        threadId,
        [{ type: "localAudio", path: audioPath }],
        "codex_connect_gateway:contract",
        workdir,
      );
      turnId = turn.turnId;
      expect(turnId).not.toBe("");
    } finally {
      if (turnId !== undefined) {
        await ownerClient.interruptTurn(threadId, turnId).catch(() => undefined);
      }
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("broadcasts peer model, effort and Fast changes across a peer reconnect", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    const observedSettings: Array<{
      model: string;
      effort: string | null;
      serviceTier: string | null;
      collaborationMode: "default" | "plan";
    }> = [];
    const removeNotification = ownerClient.onNotification((notification) => {
      const event = toThreadStateEvent(notification);
      if (event?.type !== "thread.settings.updated" || event.threadId !== threadId) {
        return;
      }
      observedSettings.push(event.settings);
    });
    try {
      await peerRpc.request({
        method: "thread/settings/update",
        params: {
          threadId,
          model: "gpt-5.6-sol",
          effort: "high",
          serviceTier: "priority",
        },
        // 仅用于固定版本真实合同，不进入业务公开接口。
      } as never);
      await waitFor(
        () => observedSettings.some((settings) =>
          settings.model === "gpt-5.6-sol"
          && settings.effort === "high"
          && settings.serviceTier === "priority"),
        2_000,
      );

      await peerClient.close();
      peerRpc = new JsonRpcClient(new UnixWebSocketTransport(socketPath));
      peerClient = new CodexAppServerClient(peerRpc, { sandbox: "read-only" });
      await peerClient.connect();

      await peerRpc.request({
        method: "thread/settings/update",
        params: {
          threadId,
          model: "gpt-5.6-sol",
          effort: "low",
          serviceTier: "default",
        },
        // 仅用于固定版本真实合同，不进入业务公开接口。
      } as never);
      await waitFor(
        () => observedSettings.some((settings) =>
          settings.model === "gpt-5.6-sol"
          && settings.effort === "low"
          && settings.serviceTier === "default"),
        2_000,
      );
    } finally {
      removeNotification();
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);
});

deepseekCatalogContractTest(
  "cold-resumes a third-party thread with its provider model catalog",
  async () => {
    const workdir = process.cwd();
    const runtimeRoot = resolve(".runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    const testRuntime = mkdtempSync(join(runtimeRoot, "deepseek-resume-contract-"));
    const codexHome = join(testRuntime, "codex-home");
    const resolvedCatalogPath = deepseekCatalogPath
      ?? join(testRuntime, "deepseek.models.json");
    const socketPath = join(testRuntime, "app-server.sock");
    const apiServer = createServer((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { type: "invalid_request_error", message: "contract failure" },
      }));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      apiServer.once("error", rejectListen);
      apiServer.listen(0, "127.0.0.1", () => resolveListen());
    });
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("DeepSeek 冷恢复合同无法创建本机 API 夹具");
    }
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    if (!deepseekCatalogPath) {
      writeFileSync(
        resolvedCatalogPath,
        `${JSON.stringify({
          models: [{
            slug: "deepseek-v4-flash",
            display_name: "DeepSeek-V4-Flash",
            description: "DeepSeek contract fixture",
            default_reasoning_level: "high",
            supported_reasoning_levels: [{
              effort: "high",
              description: "DeepSeek contract fixture",
            }],
            shell_type: "shell_command",
            visibility: "list",
            supported_in_api: true,
            priority: 1,
            availability_nux: null,
            upgrade: null,
            base_instructions: "You are a coding agent.",
            support_verbosity: true,
            default_verbosity: "low",
            apply_patch_tool_type: "freeform",
            truncation_policy: { mode: "tokens", limit: 10_000 },
            supports_parallel_tool_calls: true,
            experimental_supported_tools: [],
          }],
        })}\n`,
        { mode: 0o600 },
      );
    }
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        `model_catalog_json = ${JSON.stringify(resolvedCatalogPath)}`,
        "",
        "[model_providers.deepseek]",
        'name = "deepseek"',
        `base_url = "http://127.0.0.1:${apiAddress.port}/"`,
        'wire_api = "responses"',
        'experimental_bearer_token = "sk-contract-placeholder"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    let processHandle: ChildProcess | undefined;
    let appServerStderr = "";
    let client: CodexAppServerClient | undefined;
    const startServer = async (): Promise<void> => {
      appServerStderr = "";
      processHandle = spawn(
        process.env.CODEX_BINARY ?? "codex",
        ["app-server", "--listen", `unix://${socketPath}`],
        {
          cwd: workdir,
          env: { ...process.env, CODEX_HOME: codexHome },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      processHandle.stderr?.setEncoding("utf8");
      processHandle.stderr?.on("data", (chunk: string) => {
        appServerStderr = appendDiagnostic(appServerStderr, chunk);
      });
      await waitFor(
        () => existsSync(socketPath),
        10_000,
        () => processHandle?.exitCode === null
          ? undefined
          : new Error(appServerFailure(
            "DeepSeek 冷恢复合同 App Server 启动失败",
            appServerStderr,
          )),
      );
    };
    const stopServer = async (): Promise<void> => {
      if (processHandle?.exitCode === null) {
        processHandle.kill("SIGTERM");
        await new Promise((resolveExit) => processHandle?.once("exit", resolveExit));
      }
      rmSync(socketPath, { force: true });
    };
    try {
      await startServer();
      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "read-only" },
      );
      await client.connect();
      const started = await client.startThread(workdir, {
        model: "deepseek-v4-flash",
        modelProvider: "deepseek",
      });
      const threadId = started.thread.id;
      let turnCompleted = false;
      const removeNotification = client.onNotification((notification) => {
        if (notification.method !== "turn/completed") return;
        const params = notification.params as { threadId?: unknown } | undefined;
        if (params?.threadId === threadId) turnCompleted = true;
      });
      await client.startTurn(
        threadId,
        [{ type: "text", text: "Persist the contract fixture." }],
        "codex_connect_gateway:deepseek-resume-contract",
        workdir,
      );
      await waitFor(() => turnCompleted, 10_000);
      removeNotification();
      await client.close();
      client = undefined;
      await stopServer();

      await startServer();
      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "read-only" },
      );
      await client.connect();

      const resumed = await client.resumeThread(threadId, workdir);

      expect(resumed.model).toBe("deepseek-v4-flash");
      expect(resumed.modelProvider).toBe("deepseek");
      await client.unsubscribeThread(threadId).catch(() => undefined);
      await client.deleteThread(threadId);
    } finally {
      await client?.close().catch(() => undefined);
      await stopServer();
      await new Promise<void>((resolveClose) => apiServer.close(() => resolveClose()));
      rmSync(testRuntime, { recursive: true, force: true });
    }
  },
  30_000,
);

async function expectConfiguredTier(
  client: CodexAppServerClient,
  cwd: string,
  expected: string,
): Promise<void> {
  await expect(client.readDefaultServiceTier(cwd)).resolves.toBe(expected);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  failure?: () => Error | undefined,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    const currentFailure = failure?.();
    if (currentFailure) {
      throw currentFailure;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待 Codex App Server Unix Socket 超时；请检查 App Server stderr");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stopTestProcess(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      timeoutMs,
    );
  } catch (error) {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (killError) {
        if (!(killError instanceof Error && "code" in killError && killError.code === "ESRCH")) {
          throw killError;
        }
      }
    } else {
      child.kill("SIGKILL");
    }
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      2_000,
    );
    throw error;
  }
}

function appendDiagnostic(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-4_000);
}

function wavSilence(): Buffer {
  const sampleRate = 16_000;
  const sampleCount = 1_600;
  const dataBytes = sampleCount * 2;
  const result = Buffer.alloc(44 + dataBytes);
  result.write("RIFF", 0);
  result.writeUInt32LE(36 + dataBytes, 4);
  result.write("WAVE", 8);
  result.write("fmt ", 12);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(dataBytes, 40);
  return result;
}

function appServerFailure(message: string, stderr: string): string {
  const sanitized = stderr
    .replace(/(authorization|token|password|cookie)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]")
    .trim();
  return sanitized ? `${message}\nApp Server stderr:\n${sanitized}` : message;
}
