import { describe, expect, it, vi } from "vitest";

import {
  ProviderRoutingClient,
  type ProviderClientInstance,
} from "../src/codex-client/provider-routing-client.js";
import type { ThreadSession, ThreadSnapshot } from "../src/session-routing/index.js";

const cwd = "/workspace";

describe("ProviderRoutingClient", () => {
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
    listPlugins: vi.fn(),
    accountUsage: vi.fn(),
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
