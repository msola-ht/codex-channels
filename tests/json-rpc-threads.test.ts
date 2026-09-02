import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { appServerThread, FakeTransport, pinnedThreadSection } from "./support/json-rpc-fixtures.js";

describe("JsonRpcClient threads", () => {
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

    it.each([
      {
        entry: "/pin",
        operate: (client: CodexAppServerClient) => client.setThreadPinned("thread-1", true),
      },
      {
        entry: "custom Thread Section move",
        operate: (client: CodexAppServerClient) =>
          client.moveThreadToSection("thread-1", "section-project"),
      },
    ])("fails closed before $entry when Thread metadata update returns another target", async ({
      operate,
    }) => {
      const transport = new FakeTransport();
      transport.metadataUpdateThreadData = appServerThread({ id: "thread-other" });
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(operate(client))
        .rejects.toThrow("Codex Thread 分区元数据更新目标不一致");
      expect(transport.sent.some((message) => message.method === "thread/section/move"))
        .toBe(false);
    });

    it("passes stable Thread Section filters and position ordering", async () => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await client.listThreads("/tmp/project", {
        fullScan: true,
        sectionId: "section-project",
        sortKey: "section_position",
        sortDirection: "asc",
      });

      expect(transport.sent.find((message) => message.method === "thread/list")?.params)
        .toMatchObject({
          useStateDbOnly: false,
          sectionId: "section-project",
          sortKey: "section_position",
          sortDirection: "asc",
        });
    });

    it("manages stable Thread Sections and preserves the requested thread order", async () => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listThreadSections()).resolves.toEqual([{
        ...pinnedThreadSection,
        builtIn: "pinned",
      }]);
      const created = await client.createThreadSection("项目甲");
      await expect(client.renameThreadSection(created.id, "项目乙")).resolves.toMatchObject({
        id: created.id,
        name: "项目乙",
        builtIn: null,
      });
      await client.moveThreadToSection("thread-1", created.id, "thread-before");
      await expect(client.readThread("thread-1")).resolves.toMatchObject({
        section: { id: created.id, name: "项目乙", builtIn: null },
        isPinned: false,
      });
      expect(transport.sent.findLast((message) => message.method === "thread/section/move")?.params)
        .toEqual({
          threadId: "thread-1",
          sectionId: created.id,
          beforeThreadId: "thread-before",
        });
      await client.deleteThreadSection(created.id);
      await expect(client.listThreadSections()).resolves.toHaveLength(1);
    });
});
