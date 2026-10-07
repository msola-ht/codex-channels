import { describe, expect, it, vi } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { appServerThread, FakeTransport, pinnedThreadSection } from "./support/json-rpc-fixtures.js";

function reviewerSettings(approvalsReviewer: string) {
  return { model: "gpt-test", effort: null, serviceTier: null, collaborationMode: { mode: "default" }, approvalsReviewer };
}

describe("JsonRpcClient threads", () => {
    it("ignores incomplete settings and requires the latest same-Thread reviewer when notifications precede the acknowledgement", async () => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      await client.connect();
      let requestId = 0;
      const send = vi.spyOn(transport, "send").mockImplementation(async message => {
        requestId = (JSON.parse(message) as { id: number }).id;
      });
      let complete = false;
      const pending = client.updateThreadApprovalsReviewer("thread-1", "auto_review").then(() => { complete = true; });
      const notify = (threadSettings: unknown) => transport.receive({ method: "thread/settings/updated", params: { threadId: "thread-1", threadSettings } });
      notify(reviewerSettings("auto_review"));
      notify(reviewerSettings("user"));
      transport.receive({ id: requestId, result: {} });
      await Promise.resolve();
      expect(complete).toBe(false);
      notify({ approvalsReviewer: "auto_review" });
      await Promise.resolve();
      expect(complete).toBe(false);
      notify(reviewerSettings("auto_review"));
      await pending;
      expect(complete).toBe(true);
      send.mockRestore();
      await client.close();
    });
    it.each(["notification-first", "response-first"])("confirms reviewer changes only after matching notification and RPC success (%s)", async (order) => {
      const transport = new FakeTransport();
      const rpc = new JsonRpcClient(transport);
      const client = new CodexAppServerClient(rpc, { sandbox: "read-only" });
      await client.connect();
      let requestId = 0;
      const send = vi.spyOn(transport, "send").mockImplementation(async message => {
        const request = JSON.parse(message) as { id: number; method: string; params: unknown };
        expect(request).toMatchObject({ method: "thread/settings/update", params: { threadId: "thread-1", approvalsReviewer: "auto_review" } });
        requestId = request.id;
      });
      let complete = false;
      const pending = client.updateThreadApprovalsReviewer("thread-1", "auto_review").then(() => { complete = true; });
      const notify = (threadId: string, approvalsReviewer: string) => transport.receive({ method: "thread/settings/updated", params: { threadId, threadSettings: reviewerSettings(approvalsReviewer) } });
      notify("other", "auto_review");
      notify("thread-1", "user");
      await Promise.resolve();
      expect(complete).toBe(false);
      if (order === "notification-first") notify("thread-1", "auto_review");
      else transport.receive({ id: requestId, result: {} });
      await Promise.resolve();
      expect(complete).toBe(false);
      if (order === "notification-first") transport.receive({ id: requestId, result: {} });
      else notify("thread-1", "auto_review");
      await pending;
      expect(complete).toBe(true);
      expect(send).toHaveBeenCalledOnce();
      send.mockRestore();
      await client.close();
    });

    it("rejects an RPC failure even after a matching notification, without retry or raw error exposure", async () => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      await client.connect();
      const send = vi.spyOn(transport, "send").mockImplementation(async message => {
        const request = JSON.parse(message) as { id: number };
        transport.receive({ method: "thread/settings/updated", params: { threadId: "thread-1", threadSettings: reviewerSettings("user") } });
        transport.receive({ id: request.id, error: { code: -32001, message: "secret response" } });
      });
      try {
        await expect(client.updateThreadApprovalsReviewer("thread-1", "user")).rejects.toMatchObject({ code: "autoreview.update-failed", message: "会话审批方式更新失败，请重新查询状态" });
        expect(send).toHaveBeenCalledOnce();
      } finally { send.mockRestore(); await client.close(); }
    });

    it.each(["timeout", "disconnect", "close", "thread/closed", "thread/archived", "thread/deleted"])("cleans reviewer observers, request and deadline on %s after queued acknowledgement", async reason => {
      const transport = new FakeTransport();
      const rpc = new JsonRpcClient(transport);
      const client = new CodexAppServerClient(rpc, { sandbox: "read-only" });
      await client.connect();
      const removeNotification = vi.fn();
      const original = rpc.onNotification.bind(rpc);
      vi.spyOn(rpc, "onNotification").mockImplementation(handler => {
        const remove = original(handler);
        return () => { removeNotification(); remove(); };
      });
      vi.useFakeTimers();
      try {
        const pending = client.updateThreadApprovalsReviewer("thread-1", "user");
        const rejected = expect(pending).rejects.toMatchObject({ code: "autoreview.update-unconfirmed" });
        await Promise.resolve();
        await Promise.resolve();
        if (reason === "timeout") await vi.advanceTimersByTimeAsync(10_000);
        else if (reason === "disconnect") transport.disconnect(new Error("secret disconnect"));
        else if (reason.startsWith("thread/")) transport.receive({ method: reason, params: { threadId: "thread-1" } });
        else await client.close();
        await rejected;
        expect(removeNotification).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); vi.restoreAllMocks(); await client.close(); }
    });

    it("cleans the still-pending RPC when the reviewer deadline expires without an acknowledgement", async () => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      await client.connect();
      const send = vi.spyOn(transport, "send").mockResolvedValue();
      vi.useFakeTimers();
      try {
        const pending = expect(client.updateThreadApprovalsReviewer("thread-1", "user")).rejects.toMatchObject({ code: "autoreview.update-unconfirmed" });
        await vi.advanceTimersByTimeAsync(10_000);
        await pending;
        expect(send).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); send.mockRestore(); await client.close(); }
    });
    it("reads nullable official Thread model configuration", async () => {
      const transport = new FakeTransport();
      transport.threadReadData = appServerThread({ model: "child-model", reasoningEffort: "high" });
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      await client.connect();
      try {
        await expect(client.readThread("thread-1")).resolves.toMatchObject({ model: "child-model", reasoningEffort: "high" });
        transport.threadReadData = appServerThread({ model: null, reasoningEffort: null });
        await expect(client.readThread("thread-1")).resolves.toMatchObject({ model: null, reasoningEffort: null });
      } finally { await client.close(); }
    });

    it.each([{ model: 42 }, { reasoningEffort: {} }, { model: "" }])("rejects malformed model configuration %j", async (invalid) => {
      const transport = new FakeTransport();
      transport.threadReadData = appServerThread(invalid);
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      await client.connect();
      try { await expect(client.readThread("thread-1")).rejects.toThrow("Codex Thread 响应缺少有效"); }
      finally { await client.close(); }
    });

    it("passes metadata-read cancellation to the RPC and avoids sending an aborted request", async () => {
      const transport = new FakeTransport();
      const rpc = new JsonRpcClient(transport);
      const client = new CodexAppServerClient(rpc, { sandbox: "read-only" });
      await client.connect();
      const request = vi.spyOn(rpc, "request");
      const controller = new AbortController();
      controller.abort(new Error("metadata read cancelled"));
      try {
        await expect(client.readThread("thread-1", controller.signal)).rejects.toThrow("metadata read cancelled");
        expect(request).toHaveBeenCalledWith({ method: "thread/read", params: { threadId: "thread-1", includeTurns: false } },
          { retryOverload: true, signal: controller.signal });
        expect(transport.sent.some((message) => message.method === "thread/read")).toBe(false);
      } finally { await client.close(); }
    });

    it("lists spawned descendants across directories with explicit sources and archive state", async () => {
      const transport = new FakeTransport();
      transport.threadListData = [appServerThread({ parentThreadId: "parent", cwd: "/other" })];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      await client.connect();
      try {
        const threads = await client.listThreadDescendants("parent", true);
        expect(threads[0]).toMatchObject({ parentThreadId: "parent", cwd: "/other" });
        const request = transport.sent.find((message) => message.method === "thread/list");
        expect(request?.params).toEqual({
          ancestorThreadId: "parent", archived: true, modelProviders: [],
          sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
            "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"],
          useStateDbOnly: false, sortKey: "created_at", sortDirection: "asc", limit: 100,
        });
      } finally { await client.close(); }
    });

    it("lists CLI, Remote TUI, and App Server thread sources explicitly", async () => {
      const transport = new FakeTransport();
      const rpc = new JsonRpcClient(transport);
      const client = new CodexAppServerClient(rpc, {
        sandbox: "workspace-write",
      });
      await client.connect();

      await client.listThreads("/tmp/project");

      const request = transport.sent.find((message) => message.method === "thread/list");
      expect(request?.params).toMatchObject({
        cwd: "/tmp/project",
        modelProviders: [],
        sourceKinds: ["cli", "vscode", "appServer"],
        useStateDbOnly: true,
        archived: false,
      });
    });

    it("maps official Thread responses to the stable routing snapshot", async () => {
      const transport = new FakeTransport();
      transport.threadListData = [appServerThread({
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
        source: { custom: "future-client" },
        turns: [{
          id: "turn-running",
          items: [],
          itemsView: "full",
          status: "inProgress",
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        }],
      })];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      const threads = await client.listThreads("/tmp/project");

      expect(threads).toEqual([{
        id: "thread-1",
        sessionId: "session-1",
        modelProvider: "openai",
        preview: "测试 Thread",
        name: null,
        isPinned: false,
        section: null,
        status: { type: "active" },
        cwd: "/tmp/project",
        source: "other",
        activeTurnId: "turn-running",
        historyMode: "legacy",
        updatedAt: 1,
        recencyAt: 1,
      }]);
    });

    it("counts active loaded Threads including ephemeral sessions", async () => {
      const transport = new FakeTransport();
      transport.threadLoadedListData = ["thread-idle", "thread-active"];
      transport.threadReadDataById.set(
        "thread-idle",
        appServerThread({ id: "thread-idle", ephemeral: true }),
      );
      transport.threadReadDataById.set(
        "thread-active",
        appServerThread({
          id: "thread-active",
          ephemeral: true,
          status: { type: "active", activeFlags: [] },
          source: { subAgent: { threadSpawn: { parentThreadId: "thread-parent" } } },
        }),
      );
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "read-only",
      });
      await client.connect();

      await expect(client.countActiveLoadedThreads())
        .resolves.toBe(1);

      expect(transport.sent.find((message) => message.method === "thread/loaded/list")?.params)
        .toEqual({ limit: 100 });
      expect(transport.sent.filter((message) => message.method === "thread/read"))
        .toHaveLength(2);
    });

    it("fails closed when a loaded Thread read returns another target", async () => {
      const transport = new FakeTransport();
      transport.threadLoadedListData = ["thread-requested"];
      transport.threadReadData = appServerThread({ id: "thread-other" });
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "read-only",
      });
      await client.connect();

      await expect(client.countActiveLoadedThreads())
        .rejects.toThrow("读取目标不一致");
    });

    it("maps the official automation Feature source to the closed stable source", async () => {
      const transport = new FakeTransport();
      transport.threadListData = [appServerThread({ threadSource: "automation" })];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "read-only",
      });
      await client.connect();

      await expect(client.listThreads("/tmp/project")).resolves.toMatchObject([
        { source: "automation" },
      ]);
    });

    it.each(["default", "plan"])("reads the authoritative %s mode when resuming", async (mode) => {
      const transport = new FakeTransport();
      transport.resumeSettings = { collaborationMode: { mode, settings: {
        model: "gpt-default", reasoning_effort: "medium", developer_instructions: null,
      } } };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      await client.connect();
      expect((await client.resumeThread("thread-1", "/tmp/project")).collaborationMode).toBe(mode);
      await client.close();
    });

    it.each([
      ["user", "user"], ["auto_review", "auto_review"],
      ["guardian_subagent", "guardian_subagent"], ["future_reviewer", null], [undefined, null],
    ])("reads the actual reviewer %s from resume", async (approvalsReviewer, expected) => {
      const transport = new FakeTransport();
      transport.resumeSettings = { approvalsReviewer };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      try {
        await client.connect();
        expect((await client.resumeThread("thread-1", "/tmp/project")).approvalsReviewer).toBe(expected);
      } finally { await client.close(); }
    });

    it.each([undefined, "user", "auto_review"] as const)("encodes only an explicit Workspace reviewer %s for Thread lifecycle requests", async (approvalsReviewer) => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      try {
        await client.connect();
        const options = approvalsReviewer === undefined ? {} : { approvalsReviewer };
        await client.startThread("/tmp/project", options);
        await client.resumeThread("thread-1", "/tmp/project", options);
        await client.forkThread("thread-1", "/tmp/project", options);
        for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
          const params = transport.sent.find(message => message.method === method)?.params;
          if (approvalsReviewer === undefined) expect(params).not.toHaveProperty("approvalsReviewer");
          else expect(params).toHaveProperty("approvalsReviewer", approvalsReviewer);
        }
      } finally { await client.close(); }
    });

    it("confirms a requested Workspace reviewer against the actual resume response", async () => {
      const transport = new FakeTransport();
      transport.resumeSettings = { approvalsReviewer: "user" };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      try {
        await client.connect();
        expect((await client.resumeThread("thread-1", "/tmp/project", { approvalsReviewer: "auto_review" })).settingsMatch).toBe(false);
        expect((await client.resumeThread("thread-1", "/tmp/project", { approvalsReviewer: "user" })).settingsMatch).toBe(true);
        expect((await client.resumeThread("thread-1", "/tmp/project")).settingsMatch).toBe(true);
      } finally { await client.close(); }
    });

    it.each([null, undefined, { mode: "unknown" }])("rejects invalid resume collaboration mode %j", async (collaborationMode) => {
      const transport = new FakeTransport();
      transport.resumeSettings = { collaborationMode };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      await client.connect();
      await expect(client.resumeThread("thread-1", "/tmp/project")).rejects.toThrow("collaborationMode");
      await client.close();
    });

    it("extracts context compaction item ids when resuming a thread", async () => {
      const transport = new FakeTransport();
      transport.resumeThreadData = appServerThread({
        turns: [{
          id: "turn-1",
          items: [
            { type: "contextCompaction", id: "compact-1" },
            { type: "contextCompaction", id: "compact-2" },
          ],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1_000,
        }],
      });
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      const session = await client.resumeThread("thread-1", "/tmp/project");

      expect(session.contextCompactionItemIds).toEqual(["compact-1", "compact-2"]);
    });

    it.each([
      { cwd: "/different" },
      { approvalPolicy: "never" },
      { sandbox: { type: "dangerFullAccess" } },
    ])("reports ignored resume settings from the authoritative response: %j", async (settings) => {
      const transport = new FakeTransport();
      transport.resumeSettings = settings;
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      await client.connect();
      const resumed = await client.resumeThread("thread-1", "/tmp/project");
      expect(resumed.settingsMatch).toBe(false);
      expect(resumed.effectiveSettings).toMatchObject({ cwd: settings.cwd ?? "/tmp/project" });
      await client.close();
    });

    it("compares a requested permission profile with the profile actually returned", async () => {
      const transport = new FakeTransport();
      transport.resumeSettings = { activePermissionProfile: { id: ":workspace", extends: null } };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      await client.connect();
      expect((await client.resumeThread("thread-1", "/tmp/project", { permissions: ":read-only" })).settingsMatch).toBe(false);
      expect((await client.resumeThread("thread-1", "/tmp/project", { permissions: ":workspace" })).settingsMatch).toBe(true);
      await client.close();
    });

    it("does not override process-owned provider configuration when resuming a thread", async () => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await client.resumeThread("thread-1", "/tmp/project");

      expect(transport.sent.find((message) => message.method === "thread/resume")?.params)
        .not.toHaveProperty("config");
    });

    it("fails closed when an official Thread response lacks a required routing field", async () => {
      const transport = new FakeTransport();
      transport.threadListData = [appServerThread({ sessionId: undefined })];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listThreads("/tmp/project"))
        .rejects.toThrow("Codex Thread 响应缺少有效 sessionId");
    });

    it("fails closed when an official Thread response has invalid section state", async () => {
      const transport = new FakeTransport();
      transport.threadListData = [appServerThread({ section: { name: "Pinned" } })];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listThreads("/tmp/project"))
        .rejects.toThrow("Codex Thread 响应缺少有效 section id");
    });

    it("passes stable search/archive filters and uses explicit archive methods", async () => {
      const transport = new FakeTransport();
      const rpc = new JsonRpcClient(transport);
      const client = new CodexAppServerClient(rpc, { sandbox: "workspace-write" });
      await client.connect();

      await client.listThreads("/tmp/project", { archived: true, searchTerm: "修复" });
      await client.archiveThread("thread-1");
      await client.unarchiveThread("thread-1");
      await expect(client.setThreadPinned("thread-1", true)).resolves.toBe(true);

      expect(transport.sent.find((message) => message.method === "thread/list")?.params)
        .toMatchObject({ archived: true, searchTerm: "修复" });
      expect(transport.sent.find((message) => message.method === "thread/archive")?.params)
        .toEqual({ threadId: "thread-1" });
      expect(transport.sent.find((message) => message.method === "thread/unarchive")?.params)
        .toEqual({ threadId: "thread-1" });
      expect(transport.sent.find((message) => message.method === "thread/metadata/update")?.params)
        .toEqual({ threadId: "thread-1", gitInfo: { sha: null } });
      expect(transport.sent.find((message) => message.method === "thread/section/move")?.params)
        .toEqual({
          threadId: "thread-1",
          sectionId: pinnedThreadSection.id,
          beforeThreadId: null,
        });
    });

    it("reports no change when the Thread is already in the requested pinned state", async () => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.setThreadPinned("thread-1", false)).resolves.toBe(false);
      expect(transport.sent.some((message) => message.method === "thread/section/move"))
        .toBe(false);

      await client.setThreadPinned("thread-1", true);
      await expect(client.setThreadPinned("thread-1", true)).resolves.toBe(false);
    });

    it("fails closed before /pin when Thread metadata update returns another target", async () => {
      const transport = new FakeTransport();
      transport.metadataUpdateThreadData = appServerThread({ id: "thread-other" });
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.setThreadPinned("thread-1", true))
        .rejects.toThrow("Codex Thread 分区元数据更新目标不一致");
      expect(transport.sent.some((message) => message.method === "thread/section/move"))
        .toBe(false);
    });

});
