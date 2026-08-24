import { describe, expect, it, vi } from "vitest";

import {
  ProviderRoutingClient,
  type ProviderClientInstance,
} from "../src/codex-client/provider-routing-client.js";
import type { ThreadSession, ThreadSnapshot } from "../src/session-routing/index.js";

const cwd = "/workspace";

describe("ProviderRoutingClient", () => {
  it("reports configured Providers without starting their App Server", () => {
    const openai = client();
    const deepseek = client();
    const routed = new ProviderRoutingClient("openai", new Map([
      ["openai", openai],
      ["deepseek", deepseek],
    ]), async () => undefined);

    expect(routed.isProviderConfigured("openai")).toBe(true);
    expect(routed.isProviderConfigured("deepseek")).toBe(true);
    expect(routed.isProviderConfigured("missing")).toBe(false);
    expect(deepseek.connect).not.toHaveBeenCalled();
  });

  it("starts and connects an auxiliary Provider only when first selected", async () => {
    const openai = client();
    const deepseek = client();
    const ensureProvider = vi.fn(async () => undefined);
    deepseek.startThread.mockResolvedValue(session("thread-deepseek", "deepseek", "idle"));
    const routed = new ProviderRoutingClient("openai", new Map([
      ["openai", openai],
      ["deepseek", deepseek],
    ]), ensureProvider);

    await routed.connect();
    expect(openai.connect).toHaveBeenCalledOnce();
    expect(deepseek.connect).not.toHaveBeenCalled();

    await routed.startThread(cwd, {
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
    });

    expect(ensureProvider).toHaveBeenCalledWith("deepseek");
    expect(deepseek.connect).toHaveBeenCalledOnce();
  });

  it("keeps managed Provider history visible before its App Server is started", async () => {
    const openai = client();
    const deepseek = client();
    openai.listThreads.mockResolvedValue([
      snapshot("thread-openai", "openai", "idle"),
      snapshot("thread-deepseek", "deepseek", "notLoaded"),
    ]);
    const routed = new ProviderRoutingClient("openai", new Map([
      ["openai", openai],
      ["deepseek", deepseek],
    ]), async () => undefined);

    await routed.connect();

    await expect(routed.listThreads(cwd)).resolves.toMatchObject([
      { id: "thread-openai", modelProvider: "openai" },
      { id: "thread-deepseek", modelProvider: "deepseek" },
    ]);
    expect(deepseek.connect).not.toHaveBeenCalled();
    expect(deepseek.listThreads).not.toHaveBeenCalled();
  });

  it("routes a new third-party Thread and its Turn to the matching App Server", async () => {
    const openai = client();
    const deepseek = client();
    const started = session("thread-deepseek", "deepseek", "idle");
    deepseek.startThread.mockResolvedValue(started);
    deepseek.startTurn.mockResolvedValue({ turnId: "turn-1" });
    const routed = routing(openai, deepseek);

    await expect(routed.startThread(cwd, {
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
    })).resolves.toBe(started);
    await routed.startTurn(
      "thread-deepseek",
      [{ type: "text", text: "hello" }],
      "client-1",
      cwd,
    );

    expect(openai.startThread).not.toHaveBeenCalled();
    expect(deepseek.startThread).toHaveBeenCalledOnce();
    expect(deepseek.startTurn).toHaveBeenCalledOnce();
  });

  it("releases an ephemeral Thread through its owning Provider and forgets the route", async () => {
    const openai = client();
    const deepseek = client();
    deepseek.startThread.mockResolvedValue(session("thread-draft", "deepseek", "idle"));
    const routed = routing(openai, deepseek);

    await routed.startThread(cwd, {
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      ephemeral: true,
    });
    await routed.releaseEphemeralThread("thread-draft");

    expect(deepseek.unsubscribeThread).toHaveBeenCalledWith("thread-draft");
    expect(openai.unsubscribeThread).not.toHaveBeenCalled();
    openai.readThread.mockRejectedValue(new Error("route forgotten"));
    await expect(routed.releaseEphemeralThread("thread-draft"))
      .rejects.toThrow("route forgotten");
    expect(openai.readThread).toHaveBeenCalledWith("thread-draft");
  });

  it("retains an ephemeral Thread route when unsubscribe fails so cleanup can retry", async () => {
    const openai = client();
    const deepseek = client();
    deepseek.startThread.mockResolvedValue(session("thread-draft", "deepseek", "idle"));
    deepseek.unsubscribeThread
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(undefined);
    const routed = routing(openai, deepseek);

    await routed.startThread(cwd, {
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      ephemeral: true,
    });
    await expect(routed.releaseEphemeralThread("thread-draft"))
      .rejects.toThrow("temporary failure");
    await routed.releaseEphemeralThread("thread-draft");

    expect(deepseek.unsubscribeThread).toHaveBeenCalledTimes(2);
    expect(openai.readThread).not.toHaveBeenCalled();
  });

  it("routes Queue and history operations to the remembered Thread Provider", async () => {
    const openai = client();
    const deepseek = client();
    openai.listThreads.mockResolvedValue([
      snapshot("thread-deepseek", "deepseek", "idle"),
    ]);
    deepseek.listThreads.mockResolvedValue([]);
    deepseek.addQueueItem.mockResolvedValue({
      id: "queued-1",
      clientUserMessageId: "client-1",
      inputType: "text",
      textPreview: "queued",
      editable: true,
    });
    deepseek.listQueue.mockResolvedValue({ items: [], nextCursor: null });
    deepseek.updateQueueItem.mockResolvedValue({
      id: "queued-1",
      clientUserMessageId: "client-1",
      inputType: "text",
      textPreview: "updated",
      editable: true,
    });
    deepseek.deleteQueueItem.mockResolvedValue({ deleted: true });
    deepseek.reorderQueue.mockResolvedValue(undefined);
    deepseek.startQueueItem.mockResolvedValue({ turnId: "turn-queue" });
    deepseek.listThreadTurns.mockResolvedValue({ turns: [], nextCursor: null });
    deepseek.revertThread.mockResolvedValue({
      thread: snapshot("thread-deepseek", "deepseek", "idle"),
    });
    const routed = routing(openai, deepseek);

    await routed.listThreads(cwd);
    await routed.addQueueItem("thread-deepseek", "queued", "client-1");
    await routed.listQueue("thread-deepseek", { limit: 25 });
    await routed.updateQueueItem("thread-deepseek", "queued-1", "updated");
    await routed.deleteQueueItem("thread-deepseek", "queued-1");
    await routed.reorderQueue("thread-deepseek", ["queued-1"]);
    await routed.startQueueItem("thread-deepseek", "queued-1");
    await routed.listThreadTurns("thread-deepseek", { limit: 25 });
    await routed.revertThread("thread-deepseek", "turn-1");

    expect(deepseek.addQueueItem).toHaveBeenCalledWith(
      "thread-deepseek",
      "queued",
      "client-1",
    );
    expect(deepseek.listQueue).toHaveBeenCalledWith("thread-deepseek", { limit: 25 });
    expect(deepseek.updateQueueItem).toHaveBeenCalledWith(
      "thread-deepseek",
      "queued-1",
      "updated",
    );
    expect(deepseek.deleteQueueItem).toHaveBeenCalledWith("thread-deepseek", "queued-1");
    expect(deepseek.reorderQueue).toHaveBeenCalledWith("thread-deepseek", ["queued-1"]);
    expect(deepseek.startQueueItem).toHaveBeenCalledWith("thread-deepseek", "queued-1");
    expect(deepseek.listThreadTurns).toHaveBeenCalledWith(
      "thread-deepseek",
      { limit: 25 },
    );
    expect(deepseek.revertThread).toHaveBeenCalledWith("thread-deepseek", "turn-1");
    expect(openai.addQueueItem).not.toHaveBeenCalled();
    expect(openai.listThreadTurns).not.toHaveBeenCalled();
    expect(openai.revertThread).not.toHaveBeenCalled();
  });

  it("routes an OpenAI Thread usage query through the owning App Server", async () => {
    const openai = client();
    const deepseek = client();
    openai.listThreads.mockResolvedValue([
      snapshot("thread-openai", "openai", "idle"),
    ]);
    deepseek.listThreads.mockResolvedValue([]);
    openai.accountThreadUsage.mockResolvedValue({ kind: "unavailable" });
    const routed = routing(openai, deepseek);

    await routed.listThreads(cwd);
    await expect(routed.accountThreadUsage("thread-openai")).resolves.toEqual({
      kind: "unavailable",
    });

    expect(openai.accountThreadUsage).toHaveBeenCalledWith("thread-openai");
    expect(deepseek.accountThreadUsage).not.toHaveBeenCalled();
  });

  it("uses each Provider App Server status while preserving the primary list order", async () => {
    const openai = client();
    const deepseek = client();
    openai.listThreads.mockResolvedValue([
      snapshot("thread-openai", "openai", "idle"),
      snapshot("thread-deepseek", "deepseek", "notLoaded"),
    ]);
    deepseek.listThreads.mockResolvedValue([
      snapshot("thread-openai", "openai", "notLoaded"),
      snapshot("thread-deepseek", "deepseek", "active"),
    ]);
    const routed = routing(openai, deepseek);

    const result = await routed.listThreads(cwd);

    expect(result.map((thread) => [thread.id, thread.status.type])).toEqual([
      ["thread-openai", "idle"],
      ["thread-deepseek", "active"],
    ]);
  });

  it("keeps available Provider Threads usable when another Provider list fails", async () => {
    const openai = client();
    const deepseek = client();
    openai.listThreads.mockResolvedValue([
      snapshot("thread-openai", "openai", "idle"),
      snapshot("thread-deepseek", "deepseek", "notLoaded"),
    ]);
    deepseek.listThreads.mockRejectedValue(new Error("deepseek offline"));
    const routed = routing(openai, deepseek);

    await expect(routed.listThreads(cwd)).resolves.toMatchObject([
      { id: "thread-openai", modelProvider: "openai" },
    ]);
  });

  it("fails the Thread list only when every Provider query fails", async () => {
    const openai = client();
    const deepseek = client();
    openai.listThreads.mockRejectedValue(new Error("openai offline"));
    deepseek.listThreads.mockRejectedValue(new Error("deepseek offline"));
    const routed = routing(openai, deepseek);

    await expect(routed.listThreads(cwd))
      .rejects.toThrow("所有模型 Provider App Server 的 Thread 列表查询均失败");
  });

  it("keeps historical unconfigured Provider Threads visible but refuses to resume them", async () => {
    const openai = client();
    openai.listThreads.mockResolvedValue([
      snapshot("thread-legacy", "legacy-provider", "notLoaded"),
    ]);
    const routed = new ProviderRoutingClient("openai", new Map([["openai", openai]]));

    await expect(routed.listThreads(cwd)).resolves.toMatchObject([
      { id: "thread-legacy", modelProvider: "legacy-provider" },
    ]);
    await expect(routed.resumeThread("thread-legacy", cwd))
      .rejects.toThrow("模型 Provider 未配置独立 App Server：legacy-provider");
  });

  it("discovers a persisted Thread Provider before resuming it", async () => {
    const openai = client();
    const deepseek = client();
    const resumed = session("thread-deepseek", "deepseek", "idle");
    openai.listThreads.mockResolvedValue([
      snapshot("thread-deepseek", "deepseek", "notLoaded"),
    ]);
    deepseek.resumeThread.mockResolvedValue(resumed);
    const routed = routing(openai, deepseek);

    await expect(routed.resumeThread("thread-deepseek", cwd)).resolves.toBe(resumed);

    expect(deepseek.resumeThread).toHaveBeenCalledWith("thread-deepseek", cwd);
    expect(openai.resumeThread).not.toHaveBeenCalled();
  });

  it("routes legacy default-account Threads directly to the opencode-go client", async () => {
    const openai = client();
    const opencodeGo = client();
    const resumed = session("thread-legacy", "opencode-go", "idle");
    openai.listThreads.mockResolvedValue([
      snapshot("thread-legacy", "opencode-go", "notLoaded"),
    ]);
    opencodeGo.resumeThread.mockResolvedValue(resumed);
    const routed = new ProviderRoutingClient("openai", new Map([
      ["openai", openai],
      ["opencode-go", opencodeGo],
    ]));

    await expect(routed.resumeThread("thread-legacy", cwd)).resolves.toBe(resumed);

    expect(opencodeGo.resumeThread).toHaveBeenCalledWith("thread-legacy", cwd);
    expect(openai.resumeThread).not.toHaveBeenCalled();
  });

  it("namespaces Server Request and resolution ids by Provider", async () => {
    const openai = client();
    const deepseek = client();
    const routed = routing(openai, deepseek);
    const requests: Array<string | number> = [];
    const notifications: Array<{ method: string; params: unknown }> = [];
    routed.setServerRequestHandler(async (request) => {
      requests.push(request.id);
      return { decision: "decline" };
    });
    routed.onNotification((notification) => notifications.push(notification));

    await deepseek.serverRequestHandler?.({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {},
    });
    deepseek.emitNotification({
      method: "serverRequest/resolved",
      params: { requestId: 7 },
    });

    expect(requests).toEqual(["deepseek:7"]);
    expect(notifications).toContainEqual({
      method: "serverRequest/resolved",
      params: { requestId: "deepseek:7" },
    });
  });

  it("suppresses third-party account state and tags Provider-global notifications", () => {
    const openai = client();
    const deepseek = client();
    const routed = routing(openai, deepseek);
    const notifications: Array<{ method: string; params: unknown }> = [];
    routed.onNotification((notification) => notifications.push(notification));

    deepseek.emitNotification({
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "codex" } },
    });
    deepseek.emitNotification({
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: null,
        name: "codex_apps",
        status: "failed",
        error: null,
        failureReason: null,
      },
    });
    deepseek.emitNotification({
      method: "mcpServer/oauthLogin/completed",
      params: {
        threadId: null,
        name: "codex_apps",
        success: true,
      },
    });
    deepseek.emitNotification({ method: "warning", params: { message: "provider warning" } });
    deepseek.emitNotification({
      method: "thread/status/changed",
      params: { threadId: "thread-deepseek", status: { type: "idle" } },
    });
    openai.emitNotification({
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "codex" } },
    });

    expect(notifications).toEqual([
      {
        method: "mcpServer/startupStatus/updated",
        params: {
          threadId: null,
          name: "codex_apps",
          status: "failed",
          error: null,
          failureReason: null,
        },
        provider: "deepseek",
      },
      {
        method: "mcpServer/oauthLogin/completed",
        params: {
          threadId: null,
          name: "codex_apps",
          success: true,
        },
        provider: "deepseek",
      },
      {
        method: "warning",
        params: { message: "provider warning" },
        provider: "deepseek",
      },
      {
        method: "thread/status/changed",
        params: { threadId: "thread-deepseek", status: { type: "idle" } },
      },
      {
        method: "account/rateLimits/updated",
        params: { rateLimits: { limitId: "codex" } },
        provider: "openai",
      },
    ]);
  });

  it("reports and reconnects only the disconnected Provider", async () => {
    const openai = client();
    const deepseek = client();
    const routed = routing(openai, deepseek);
    const disconnected: string[] = [];
    routed.onDisconnect((_error, provider) => disconnected.push(provider));
    deepseek.reconnect.mockResolvedValue({ userAgent: "codex-cli/0.146.0" });

    deepseek.emitDisconnect(new Error("offline"));
    await routed.reconnectProvider("deepseek");

    expect(disconnected).toEqual(["deepseek"]);
    expect(deepseek.reconnect).toHaveBeenCalledOnce();
    expect(openai.reconnect).not.toHaveBeenCalled();
  });

  it("asks the supervisor to restore an on-demand Provider before reconnecting", async () => {
    const openai = client();
    const deepseek = client();
    const ensureProvider = vi.fn(async () => undefined);
    deepseek.startThread.mockResolvedValue(session("thread-deepseek", "deepseek", "idle"));
    deepseek.reconnect.mockResolvedValue({ userAgent: "codex-cli/0.147.0" });
    const routed = new ProviderRoutingClient("openai", new Map([
      ["openai", openai],
      ["deepseek", deepseek],
    ]), ensureProvider);

    await routed.connect();
    await routed.startThread(cwd, {
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
    });
    await routed.reconnectProvider("deepseek");

    expect(ensureProvider).toHaveBeenNthCalledWith(1, "deepseek");
    expect(ensureProvider).toHaveBeenNthCalledWith(2, "deepseek");
    expect(deepseek.reconnect).toHaveBeenCalledOnce();
  });

  it("reads the default service tier from the selected Provider App Server", async () => {
    const openai = client();
    const deepseek = client();
    deepseek.readDefaultServiceTier.mockResolvedValue("default");
    const routed = routing(openai, deepseek);

    await expect(routed.readDefaultServiceTier(cwd, "deepseek"))
      .resolves.toBe("default");

    expect(deepseek.readDefaultServiceTier).toHaveBeenCalledWith(cwd);
    expect(openai.readDefaultServiceTier).not.toHaveBeenCalled();
  });

  it("keeps experimental Plugin discovery on the primary OpenAI App Server", async () => {
    const openai = client();
    const deepseek = client();
    openai.listPlugins.mockResolvedValue({
      plugins: [{ id: "github@local" }],
      loadErrorCount: 0,
    });
    openai.resolvePlugin.mockResolvedValue({ id: "github@local" });
    const routed = routing(openai, deepseek);

    await expect(routed.listPlugins(cwd)).resolves.toEqual({
      plugins: [{ id: "github@local" }],
      loadErrorCount: 0,
    });
    await expect(routed.resolvePlugin(cwd, "github@local"))
      .resolves.toEqual({ id: "github@local" });
    expect(openai.listPlugins).toHaveBeenCalledWith(cwd);
    expect(openai.resolvePlugin).toHaveBeenCalledWith(cwd, "github@local");
    expect(deepseek.listPlugins).not.toHaveBeenCalled();
    expect(deepseek.resolvePlugin).not.toHaveBeenCalled();
  });

  it("keeps global Thread Section catalog operations on primary and routes moves by Thread", async () => {
    const openai = client();
    const deepseek = client();
    const sections = [{ id: "section-1", name: "项目", builtIn: null }];
    openai.listThreadSections.mockResolvedValue(sections);
    openai.listThreads.mockResolvedValue([
      snapshot("thread-deepseek", "deepseek", "idle"),
    ]);
    deepseek.listThreads.mockResolvedValue([]);
    const routed = routing(openai, deepseek);

    await expect(routed.listThreadSections()).resolves.toBe(sections);
    await routed.createThreadSection("项目");
    await routed.renameThreadSection("section-1", "项目二");
    await routed.deleteThreadSection("section-1");
    await routed.listThreads(cwd);
    await routed.moveThreadToSection("thread-deepseek", "section-1");

    expect(openai.createThreadSection).toHaveBeenCalledWith("项目");
    expect(openai.renameThreadSection).toHaveBeenCalledWith("section-1", "项目二");
    expect(openai.deleteThreadSection).toHaveBeenCalledWith("section-1");
    expect(deepseek.moveThreadToSection).toHaveBeenCalledWith(
      "thread-deepseek",
      "section-1",
    );
    expect(openai.moveThreadToSection).not.toHaveBeenCalled();
  });

  it("routes MCP detail, OAuth, and resource reads through the Thread Provider", async () => {
    const openai = client();
    const deepseek = client();
    openai.readThread.mockResolvedValue(snapshot("thread-ds", "deepseek", "idle"));
    deepseek.readThread.mockResolvedValue(snapshot("thread-ds", "deepseek", "idle"));
    deepseek.listMcpServerDetails.mockResolvedValue([]);
    deepseek.startMcpOAuthLogin.mockResolvedValue({
      server: "tools",
      authorizationUrl: "https://example.test/oauth",
    });
    deepseek.readMcpResource.mockResolvedValue({
      server: "tools",
      requestedUri: "project://readme",
      contents: [],
      omittedContentCount: 0,
    });
    const routed = routing(openai, deepseek);
    await routed.readThread("thread-ds");

    await routed.listMcpServerDetails("thread-ds");
    await routed.startMcpOAuthLogin("tools", "thread-ds");
    await routed.readMcpResource("tools", "project://readme", "thread-ds");

    expect(deepseek.listMcpServerDetails).toHaveBeenCalledWith("thread-ds");
    expect(deepseek.startMcpOAuthLogin).toHaveBeenCalledWith("tools", "thread-ds");
    expect(deepseek.readMcpResource)
      .toHaveBeenCalledWith("tools", "project://readme", "thread-ds");
    expect(openai.listMcpServerDetails).not.toHaveBeenCalled();
  });

  it("reloads MCP configuration on every managed App Server", async () => {
    const openai = client();
    const deepseek = client();
    openai.reloadMcpServers.mockResolvedValue(undefined);
    deepseek.reloadMcpServers.mockResolvedValue(undefined);
    const routed = routing(openai, deepseek);

    await expect(routed.reloadMcpServers()).resolves.toBeUndefined();
    expect(openai.reloadMcpServers).toHaveBeenCalledOnce();
    expect(deepseek.reloadMcpServers).toHaveBeenCalledOnce();
  });

  it("attempts every managed App Server and reports MCP reload failures", async () => {
    const openai = client();
    const deepseek = client();
    openai.reloadMcpServers.mockRejectedValue(new Error("reload failed"));
    deepseek.reloadMcpServers.mockResolvedValue(undefined);
    const routed = routing(openai, deepseek);

    await expect(routed.reloadMcpServers()).rejects.toThrow("reload failed");
    expect(openai.reloadMcpServers).toHaveBeenCalledOnce();
    expect(deepseek.reloadMcpServers).toHaveBeenCalledOnce();
  });

  it("routes alias custom-primary Threads to the primary App Server without reconnecting", async () => {
    const openai = client();
    const started = session("thread-custom", "OpenAI", "idle");
    openai.startThread.mockResolvedValue(started);
    openai.startTurn.mockResolvedValue({ turnId: "turn-1" });
    const routed = new ProviderRoutingClient(
      "openai",
      new Map([["openai", openai]]),
      async () => undefined,
      new Set(["OpenAI"]),
    );

    await routed.connect();
    expect(openai.connect).toHaveBeenCalledOnce();

    await expect(routed.startThread(cwd, {
      model: "gpt-5.6-sol",
      modelProvider: "OpenAI",
    })).resolves.toBe(started);
    await routed.startTurn(
      "thread-custom",
      [{ type: "text", text: "hello" }],
      "client-1",
      cwd,
    );

    expect(openai.startThread).toHaveBeenCalledOnce();
    expect(openai.startTurn).toHaveBeenCalledOnce();
    expect(openai.connect).toHaveBeenCalledOnce();
  });

  it("keeps alias custom-primary Threads visible and resumable from the primary list", async () => {
    const openai = client();
    openai.listThreads.mockResolvedValue([
      snapshot("thread-custom", "OpenAI", "idle"),
    ]);
    openai.resumeThread.mockResolvedValue(session("thread-custom", "OpenAI", "active"));
    const routed = new ProviderRoutingClient(
      "openai",
      new Map([["openai", openai]]),
      async () => undefined,
      new Set(["OpenAI"]),
    );

    await routed.connect();

    await expect(routed.listThreads(cwd)).resolves.toMatchObject([
      { id: "thread-custom", modelProvider: "OpenAI" },
    ]);
    await expect(routed.resumeThread("thread-custom", cwd)).resolves.toMatchObject({
      thread: { id: "thread-custom" },
    });
    expect(openai.resumeThread).toHaveBeenCalledOnce();
    expect(openai.connect).toHaveBeenCalledOnce();
  });

  it("reports the canonical primary Provider for alias custom-primary Threads", async () => {
    const openai = client();
    openai.listThreads.mockResolvedValue([
      snapshot("thread-custom", "OpenAI", "idle"),
    ]);
    const routed = new ProviderRoutingClient(
      "openai",
      new Map([["openai", openai]]),
      async () => undefined,
      new Set(["OpenAI"]),
    );

    await routed.connect();
    await routed.listThreads(cwd);

    expect(routed.knownProvider("thread-custom")).toBe("openai");
  });

  it("reconnects an alias custom-primary without launching a separate App Server", async () => {
    const openai = client();
    const ensureProvider = vi.fn(async () => undefined);
    const routed = new ProviderRoutingClient(
      "openai",
      new Map([["openai", openai]]),
      ensureProvider,
      new Set(["OpenAI"]),
    );

    await routed.reconnectProvider("OpenAI");

    expect(ensureProvider).not.toHaveBeenCalled();
    expect(openai.reconnect).toHaveBeenCalledOnce();
  });

  it("rewrites the primary routing key to the custom primary Thread Provider", async () => {
    const openai = client();
    openai.startThread.mockResolvedValue(session("thread-custom", "OpenAI", "idle"));
    const routed = new ProviderRoutingClient(
      "openai",
      new Map([["openai", openai]]),
      async () => undefined,
      new Set(["OpenAI"]),
      "OpenAI",
    );

    await routed.connect();
    await routed.startThread(cwd, {
      model: "gpt-5.6-sol",
      modelProvider: "openai",
    });

    expect(openai.startThread).toHaveBeenCalledOnce();
    expect(openai.startThread).toHaveBeenCalledWith(cwd, expect.objectContaining({
      modelProvider: "OpenAI",
    }));
  });

  it("uses the custom primary Thread Provider when creating a Thread without a Provider", async () => {
    const openai = client();
    openai.startThread.mockResolvedValue(session("thread-custom", "OpenAI", "idle"));
    const routed = new ProviderRoutingClient(
      "openai",
      new Map([["openai", openai]]),
      async () => undefined,
      new Set(["OpenAI"]),
      "OpenAI",
    );

    await routed.connect();
    await routed.startThread(cwd, { model: "gpt-5.6-sol" });

    expect(openai.startThread).toHaveBeenCalledWith(cwd, expect.objectContaining({
      modelProvider: "OpenAI",
    }));
  });

  it("keeps auxiliary Provider Thread forks on the matching App Server", async () => {
    const openai = client();
    const deepseek = client();
    openai.listThreads.mockResolvedValue([]);
    deepseek.listThreads.mockResolvedValue([
      snapshot("thread-deepseek", "deepseek", "idle"),
    ]);
    deepseek.forkThread.mockResolvedValue(session("thread-fork", "deepseek", "idle"));
    const routed = routing(openai, deepseek);

    await routed.connect();
    await routed.listThreads(cwd);
    await routed.forkThread("thread-deepseek", cwd, {
      modelProvider: "deepseek",
    });

    expect(deepseek.forkThread).toHaveBeenCalledWith(
      "thread-deepseek",
      cwd,
      expect.objectContaining({ modelProvider: "deepseek" }),
    );
    expect(openai.forkThread).not.toHaveBeenCalled();
  });

  it("normalizes alias-equal Providers when forking a custom primary Thread", async () => {
    const openai = client();
    openai.listThreads.mockResolvedValue([
      snapshot("thread-custom", "OpenAI", "idle"),
    ]);
    openai.forkThread.mockResolvedValue(session("thread-fork", "OpenAI", "idle"));
    const routed = new ProviderRoutingClient(
      "openai",
      new Map([["openai", openai]]),
      async () => undefined,
      new Set(["OpenAI"]),
      "OpenAI",
    );

    await routed.connect();
    await routed.listThreads(cwd);
    await routed.forkThread("thread-custom", cwd, {
      modelProvider: "openai",
    });

    expect(openai.forkThread).toHaveBeenCalledWith(
      "thread-custom",
      cwd,
      expect.objectContaining({ modelProvider: "OpenAI" }),
    );
  });

  it("preserves a custom primary Thread Provider after receiving its notifications", async () => {
    const openai = client();
    openai.listThreads.mockResolvedValue([
      snapshot("thread-custom", "OpenAI", "idle"),
    ]);
    openai.forkThread.mockResolvedValue(session("thread-fork", "OpenAI", "idle"));
    const routed = new ProviderRoutingClient(
      "openai",
      new Map([["openai", openai]]),
      async () => undefined,
      new Set(["OpenAI"]),
      "OpenAI",
    );

    routed.onNotification(() => undefined);
    await routed.connect();
    await routed.listThreads(cwd);
    openai.emitNotification({
      method: "thread/status/changed",
      params: { threadId: "thread-custom" },
    });
    await routed.forkThread("thread-custom", cwd, {});

    expect(openai.forkThread).toHaveBeenCalledWith(
      "thread-custom",
      cwd,
      expect.objectContaining({ modelProvider: "OpenAI" }),
    );
  });
});

function routing(openai: MockClient, deepseek: MockClient): ProviderRoutingClient {
  return new ProviderRoutingClient("openai", new Map([
    ["openai", openai],
    ["deepseek", deepseek],
  ]));
}

function snapshot(
  id: string,
  modelProvider: string,
  status: ThreadSnapshot["status"]["type"],
): ThreadSnapshot {
  return {
    id,
    sessionId: id,
    modelProvider,
    preview: id,
    name: null,
    isPinned: false,
    status: status === "active"
      ? { type: "active" }
      : { type: status },
    cwd,
    source: "appServer",
    activeTurnId: status === "active" ? "turn-active" : null,
    historyMode: "paginated",
  };
}

function session(
  id: string,
  modelProvider: string,
  status: ThreadSnapshot["status"]["type"],
): ThreadSession {
  return {
    thread: snapshot(id, modelProvider, status),
    model: modelProvider === "deepseek" ? "deepseek-v4-flash" : "gpt-test",
    modelProvider,
    reasoningEffort: "high",
    serviceTier: null,
    contextCompactionItemIds: [],
  };
}

type MockClient = ReturnType<typeof client>;

function client() {
  let notificationHandler: ((notification: { method: string; params: unknown }) => void)
    | undefined;
  let disconnectHandler: ((error: Error) => void) | undefined;
  const result = {
    connect: vi.fn(),
    reconnect: vi.fn(),
    close: vi.fn(),
    onNotification: vi.fn((handler) => {
      notificationHandler = handler;
      return () => { notificationHandler = undefined; };
    }),
    onDisconnect: vi.fn((handler) => {
      disconnectHandler = handler;
      return () => { disconnectHandler = undefined; };
    }),
    setServerRequestHandler: vi.fn((handler) => { result.serverRequestHandler = handler; }),
    listThreads: vi.fn(),
    listThreadSections: vi.fn(),
    createThreadSection: vi.fn(),
    renameThreadSection: vi.fn(),
    deleteThreadSection: vi.fn(),
    moveThreadToSection: vi.fn(),
    listCollaborationModes: vi.fn(),
    readThread: vi.fn(),
    startThread: vi.fn(),
    resumeThread: vi.fn(),
    unsubscribeThread: vi.fn(),
    deleteThread: vi.fn(),
    archiveThread: vi.fn(),
    unarchiveThread: vi.fn(),
    startTurn: vi.fn(),
    steerTurn: vi.fn(),
    addQueueItem: vi.fn(),
    listQueue: vi.fn(),
    updateQueueItem: vi.fn(),
    deleteQueueItem: vi.fn(),
    reorderQueue: vi.fn(),
    startQueueItem: vi.fn(),
    listThreadTurns: vi.fn(),
    revertThread: vi.fn(),
    interruptTurn: vi.fn(),
    setThreadName: vi.fn(),
    setThreadPinned: vi.fn(),
    compactThread: vi.fn(),
    listModels: vi.fn(),
    writeDefaultFastMode: vi.fn(),
    readDefaultServiceTier: vi.fn(),
    forkThread: vi.fn(),
    startReview: vi.fn(),
    listSkills: vi.fn(),
    resolveSkill: vi.fn(),
    listMcpServers: vi.fn(),
    listMcpServerDetails: vi.fn(),
    startMcpOAuthLogin: vi.fn(),
    readMcpResource: vi.fn(),
    reloadMcpServers: vi.fn(),
    listPlugins: vi.fn(),
    resolvePlugin: vi.fn(),
    accountUsage: vi.fn(),
    accountThreadUsage: vi.fn(),
    accountRateLimits: vi.fn(),
    listPermissionProfiles: vi.fn(),
    getGoal: vi.fn(),
    setGoal: vi.fn(),
    clearGoal: vi.fn(),
    serverRequestHandler: undefined as ProviderClientInstance["setServerRequestHandler"] extends
      (handler: infer Handler) => void ? Handler | undefined : never,
    emitNotification(notification: { method: string; params: unknown }) {
      notificationHandler?.(notification);
    },
    emitDisconnect(error: Error) {
      disconnectHandler?.(error);
    },
  };
  return result;
}
