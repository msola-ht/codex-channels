import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { parse } from "smol-toml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { updateCodexUserConfig } from "../scripts/codex-user-config.mjs";
import {
  loadCodexUserSettings,
  updateCodexUserSetting,
} from "../scripts/codex-user-settings-management.mjs";
import type { ApprovalRequest } from "../src/approval/index.js";
import type { McpRuntimeStatus } from "../src/application/index.js";
import { CodexAppServerClient } from "../src/codex-client/client.js";
import {
  handleApprovalServerRequest,
  toConversationInputEvent,
  toThreadStateEvent,
} from "../src/codex-client/index.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { UnixWebSocketTransport } from "../src/codex-client/unix-websocket-transport.js";
import { appendDiagnostic, appServerFailure, stopDetachedTestProcess, waitFor } from "./support/real-app-server-helpers.js";

const runContract = process.env.RUN_CODEX_CONTRACT === "1";
const contractSuite = runContract ? describe : describe.skip;

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
  let runtimeProbeExitFile: string;
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
    runtimeProbeExitFile = join(testRuntime, "runtime-probe-exit");
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        'mcp_oauth_credentials_store = "file"',
        "",
        "[mcp_servers.approval_probe]",
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(approvalProbe)}]`,
        "",
        "[mcp_servers.runtime_probe]",
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(approvalProbe)}]`,
        "",
        "[mcp_servers.runtime_probe.env]",
        `MCP_TEST_EXIT_FILE = ${JSON.stringify(runtimeProbeExitFile)}`,
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
        detached: process.platform !== "win32",
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
    await stopDetachedTestProcess(processHandle, 10_000);
    if (oauthServer) {
      await new Promise<void>((resolveClose) => oauthServer.close(() => resolveClose()));
    }
    if (testRuntime) {
      rmSync(testRuntime, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
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
        "codex_connect:skill-contract",
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
      && server.runtimeStatus === "unknown"
      && (server.pluginId === null || typeof server.pluginId === "string")
      && typeof server.authStatus === "string"
      && Number.isInteger(server.toolCount))).toBe(true);

    const details = await ownerClient.listMcpServerDetails();
    // The isolated fixture exposes config-sourced MCP servers only; the fixed
    // App Server contract has no installed Plugin-backed server to produce a
    // non-null pluginId, so this verifies the nullable boundary only.
    const approvalProbe = details.find((server) => server.name === "approval_probe");
    expect(approvalProbe?.pluginId).toBeNull();
    expect(approvalProbe?.serverVersion).toBe("1.0.0");
    expect(approvalProbe?.tools.some((tool) => tool.name === "approval_probe")).toBe(true);
    const approvalTool = approvalProbe?.tools.find((tool) => tool.name === "approval_probe");
    expect(approvalTool?.access).toBe("writeCapable");
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

  it("reports thread MCP runtime failure and reconnect after an explicit reload", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    try {
      await waitForMcpRuntimeStatus(
        ownerClient,
        threadId,
        "runtime_probe",
        "connected",
      );
      writeFileSync(runtimeProbeExitFile, "exit", { mode: 0o600 });
      await waitForMcpRuntimeStatus(
        ownerClient,
        threadId,
        "runtime_probe",
        "failed",
      );

      rmSync(runtimeProbeExitFile, { force: true });
      await ownerClient.reloadMcpServers();
      await waitForMcpRuntimeStatus(
        ownerClient,
        threadId,
        "runtime_probe",
        "connected",
      );
    } finally {
      rmSync(runtimeProbeExitFile, { force: true });
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId).catch(() => undefined);
    }
  }, 20_000);

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
    const catalog = await ownerClient.listPlugins(workdir);

    expect(Array.isArray(catalog.plugins)).toBe(true);
    expect(catalog.loadErrorCount).toBe(0);
    expect(catalog.plugins.every((plugin) =>
      typeof plugin.id === "string"
      && typeof plugin.name === "string"
      && typeof plugin.enabled === "boolean"
      && typeof plugin.available === "boolean"
      && (plugin.version === null || typeof plugin.version === "string")
      && (plugin.localVersion === null || typeof plugin.localVersion === "string")
      && ["local", "git", "npm", "remote"].includes(plugin.source)
      && (plugin.installedAt === null || Number.isSafeInteger(plugin.installedAt))
      && (plugin.developerName === null || typeof plugin.developerName === "string")
      && (plugin.category === null || typeof plugin.category === "string")
      && plugin.capabilities.every((capability) => typeof capability === "string")
      && ["onInstall", "onUse"].includes(plugin.authPolicy)
      && plugin.eligiblePlanTypes.every((plan) => typeof plan === "string")
      && (plugin.disabledReason === null || typeof plugin.disabledReason === "string")))
      .toBe(true);
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
        "codex_connect:plugin-contract",
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

  it("shares stable custom Thread Sections and unassigns members on delete", async () => {
    const first = await ownerClient.startThread(workdir);
    const second = await ownerClient.startThread(workdir);
    const firstThreadId = first.thread.id;
    const secondThreadId = second.thread.id;
    let sectionId: string | undefined;
    try {
      for (const [threadId, text] of [
        [firstThreadId, "Thread Section contract first"],
        [secondThreadId, "Thread Section contract second"],
      ] as const) {
        let userMessageCompleted = false;
        const removeNotification = ownerClient.onNotification((notification) => {
          if (notification.method !== "item/completed") return;
          const params = notification.params as {
            threadId?: unknown;
            item?: { type?: unknown };
          } | undefined;
          if (params?.threadId === threadId && params.item?.type === "userMessage") {
            userMessageCompleted = true;
          }
        });
        let turnId: string | undefined;
        try {
          const turn = await ownerClient.startTurn(
            threadId,
            [{ type: "text", text }],
            "codex_connect:thread-section-contract",
            workdir,
          );
          turnId = turn.turnId;
          await waitFor(() => userMessageCompleted, 2_000);
        } finally {
          removeNotification();
          if (turnId !== undefined) {
            await ownerClient.interruptTurn(threadId, turnId).catch(() => undefined);
          }
        }
      }

      const created = await ownerClient.createThreadSection(`contract-${Date.now()}`);
      sectionId = created.id;
      const renamed = await ownerClient.renameThreadSection(created.id, "contract-renamed");
      expect(renamed).toMatchObject({ id: created.id, name: "contract-renamed" });
      await ownerClient.moveThreadToSection(firstThreadId, created.id);
      await ownerClient.moveThreadToSection(secondThreadId, created.id, firstThreadId);

      const ordered = await peerClient.listThreads(workdir, {
        fullScan: true,
        sectionId: created.id,
        sortKey: "section_position",
        sortDirection: "asc",
      });
      expect(ordered.map((thread) => thread.id)).toEqual([
        secondThreadId,
        firstThreadId,
      ]);

      await expect(peerClient.listThreadSections()).resolves.toContainEqual({
        id: created.id,
        name: "contract-renamed",
        builtIn: null,
      });
      await expect(peerClient.readThread(firstThreadId)).resolves.toMatchObject({
        section: { id: created.id, name: "contract-renamed" },
        isPinned: false,
      });

      await peerClient.deleteThreadSection(created.id);
      sectionId = undefined;
      await expect(ownerClient.readThread(firstThreadId)).resolves.toMatchObject({
        section: null,
      });
    } finally {
      if (sectionId !== undefined) {
        await ownerClient.deleteThreadSection(sectionId).catch(() => undefined);
      }
      for (const threadId of [firstThreadId, secondThreadId]) {
        await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
        await ownerClient.deleteThread(threadId);
      }
    }
  }, 20_000);

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
        "codex_connect:contract",
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
        "codex_connect:contract",
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

  it("accepts inline image Data URLs without local image paths", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    let observedItem: Record<string, unknown> | undefined;
    const removeNotification = ownerClient.onNotification((notification) => {
      if (notification.method !== "item/completed" && notification.method !== "item/started") {
        return;
      }
      const params = typeof notification.params === "object" && notification.params !== null
        ? notification.params as Record<string, unknown>
        : {};
      if (params.threadId !== threadId) return;
      const item = typeof params.item === "object" && params.item !== null
        ? params.item as Record<string, unknown>
        : undefined;
      if (item?.type === "userMessage") {
        observedItem = item;
      }
    });
    let turnId: string | undefined;
    try {
      const turn = await ownerClient.startTurn(
        threadId,
        [{ type: "image", url: imageUrl }],
        "codex_connect:inline-image-contract",
        workdir,
      );
      turnId = turn.turnId;
      await waitFor(() => observedItem !== undefined, 2_000);
      expect(observedItem?.content).toEqual([{
        type: "image",
        url: imageUrl,
        detail: null,
      }]);
      expect(JSON.stringify(observedItem)).not.toContain("localImage");
      expect(JSON.stringify(observedItem)).not.toContain("path");
    } finally {
      removeNotification();
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

  it("persists model defaults through the official user config transaction", async () => {
    const configPath = join(codexHome, "config.toml");
    const before = parse(readFileSync(configPath, "utf8"));
    const models = await ownerClient.listModels();
    const model = models.find((candidate) =>
      candidate.available !== false
      && candidate.supportedReasoningEfforts.length > 0);
    if (!model) {
      throw new Error("隔离 Codex App Server 没有返回可写入的官方模型默认值");
    }
    const effort = model.defaultReasoningEffort;

    await ownerClient.writeDefaultModelSettings(model.model, effort);

    await expect(peerClient.readDefaultModelSettings()).resolves.toEqual({
      model: model.model,
      effort,
    });
    const after = parse(readFileSync(configPath, "utf8"));
    expect(after.model).toBe(model.model);
    expect(after.model_reasoning_effort).toBe(effort);
    expect(after.mcp_servers).toEqual(before.mcp_servers);
    expect(after.marketplaces).toEqual(before.marketplaces);
    expect(after.plugins).toEqual(before.plugins);
    expect(after.model_providers).toEqual(before.model_providers);
  }, 15_000);

  it("persists every unified user default through one official config transaction", async () => {
    const configPath = join(codexHome, "config.toml");
    const before = parse(readFileSync(configPath, "utf8"));
    const beforeWorkspace = before.sandbox_workspace_write as
      | Record<string, unknown>
      | undefined;
    const createClient = async () => ({
      connect: async () => undefined,
      close: async () => undefined,
      readUserConfigSnapshot: () => ownerClient.readUserConfigSnapshot(),
      writeUserConfigEdits: (
        edits: Parameters<typeof ownerClient.writeUserConfigEdits>[0],
        options?: Parameters<typeof ownerClient.writeUserConfigEdits>[1],
      ) => ownerClient.writeUserConfigEdits(edits, options),
      listModels: () => ownerClient.listModels(),
      readDefaultModelSettings: () => ownerClient.readDefaultModelSettings(),
      writeDefaultModelSettings: (model: string, effort: string) =>
        ownerClient.writeDefaultModelSettings(model, effort),
    });

    try {
      const settings = await loadCodexUserSettings({
        createClient,
        primaryProvider: () => "openai",
      });
      const model = settings.models.find((candidate) => candidate.isDefault)
        ?? settings.models[0];
      if (!model) throw new Error("真实 App Server 没有返回可用模型");
      await updateCodexUserSetting({
        kind: "all",
        model: model.model,
        reasoningEffort: model.defaultReasoningEffort,
        fastEnabled: true,
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        networkAccess: true,
      }, {
        expectedVersion: settings.version,
        createClient,
        primaryProvider: () => "openai",
      });

      const after = parse(readFileSync(configPath, "utf8"));
      expect(after.model).toBe(model.model);
      expect(after.model_reasoning_effort).toBe(model.defaultReasoningEffort);
      expect(after.service_tier).toBe("fast");
      expect(after.sandbox_mode).toBe("workspace-write");
      expect(after.approval_policy).toBe("on-request");
      expect(after.sandbox_workspace_write).toMatchObject({ network_access: true });
    } finally {
      await ownerClient.writeUserConfigEdits([
        { keyPath: "model", value: before.model ?? null },
        { keyPath: "model_reasoning_effort", value: before.model_reasoning_effort ?? null },
        { keyPath: "service_tier", value: before.service_tier ?? null },
        { keyPath: "sandbox_mode", value: before.sandbox_mode ?? null },
        { keyPath: "approval_policy", value: before.approval_policy ?? null },
        {
          keyPath: "sandbox_workspace_write.network_access",
          value: beforeWorkspace?.network_access ?? null,
        },
      ]);
    }
  }, 15_000);

  it("persists and removes an agent role through the official user config transaction", async () => {
    const configPath = join(codexHome, "config.toml");
    const roleConfigPath = join(codexHome, "contract-agent.config.toml");
    writeFileSync(roleConfigPath, 'developer_instructions = "Contract role"\n', {
      mode: 0o600,
    });

    try {
      await updateCodexUserConfig({
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_BINARY: process.env.CODEX_BINARY ?? "codex",
      }, () => [{
        keyPath: "features.multi_agent_v2",
        value: true,
      }, {
        keyPath: "agents.contract",
        value: {
          description: "Contract role",
          config_file: roleConfigPath,
          nickname_candidates: ["Contract"],
        },
      }]);

      const enabled = parse(readFileSync(configPath, "utf8"));
      expect(enabled.features).toMatchObject({ multi_agent_v2: true });
      expect(enabled.agents).toMatchObject({
        contract: {
          description: "Contract role",
          config_file: roleConfigPath,
          nickname_candidates: ["Contract"],
        },
      });

      await ownerClient.writeUserConfigEdits([{
        keyPath: "agents.contract",
        value: null,
      }]);

      const removed = parse(readFileSync(configPath, "utf8"));
      const removedAgents = removed.agents as Record<string, unknown> | undefined;
      expect(removedAgents?.contract).toBeUndefined();
    } finally {
      await ownerClient.writeUserConfigEdits([{
        keyPath: "agents.contract",
        value: null,
      }]).catch(() => undefined);
    }
  }, 15_000);
});

async function expectConfiguredTier(client: CodexAppServerClient, cwd: string, expected: string): Promise<void> {
  await expect(client.readDefaultServiceTier(cwd)).resolves.toBe(expected);
}
async function waitForMcpRuntimeStatus(client: CodexAppServerClient, threadId: string, serverName: string, expectedStatus: McpRuntimeStatus): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= 10_000) {
    const server = (await client.listMcpServerDetails(threadId)).find((entry) => entry.name === serverName);
    if (server?.runtimeStatus === expectedStatus) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`等待 MCP Server ${serverName} 进入 ${expectedStatus} 状态超时`);
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
