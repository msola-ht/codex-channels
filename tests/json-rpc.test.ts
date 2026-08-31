import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { appServerGoal, FakeTransport } from "./support/json-rpc-fixtures.js";


describe("JsonRpcClient", () => {
  it("retries overload only when the caller marks a request safe", async () => {
    const transport = new FakeTransport();
    transport.simulateAccountUsageOverload = true;
    const client = new JsonRpcClient(transport);
    await client.connect();

    const result = await client.request<{ ok: boolean }>(
      { method: "account/usage/read", params: undefined },
      { retryOverload: true, attempts: 2 },
    );

    expect(result).toEqual({ ok: true });
    expect(transport.overloadResponses).toBe(2);
  });
});






  it("tags Gateway user input with a client message id", async () => {
    const transport = new FakeTransport();
    const rpc = new JsonRpcClient(transport);
    const client = new CodexAppServerClient(rpc, {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.startTurn(
      "thread-1",
      [
        { type: "text", text: "测试输入" },
        {
          type: "image",
          url: "data:image/png;base64,AA==",
        },
        { type: "localAudio", path: "/tmp/voice.ogg" },
        {
          type: "skill",
          name: "systematic-debugging",
          path: "/tmp/project/.codex/skills/systematic-debugging/SKILL.md",
        },
        {
          type: "plugin",
          name: "GitHub",
          path: "plugin://github@local",
        },
      ],
      "codex_connect:request-1",
      "/tmp/project",
      {
        model: "gpt-selected",
        effort: "high",
        serviceTier: null,
      },
    );
    await client.startTurn(
      "thread-1",
      [{ type: "text", text: "开启 Fast" }],
      "codex_connect:request-fast",
      "/tmp/project",
      { serviceTier: "priority" },
    );
    await client.steerTurn(
      "thread-1",
      "turn-1",
      [{ type: "text", text: "补充输入" }],
      "codex_connect:request-2",
    );

    expect(transport.sent.find((message) => message.method === "turn/start")?.params)
      .toMatchObject({
        clientUserMessageId: "codex_connect:request-1",
        input: [
          { type: "text", text: "测试输入", text_elements: [] },
          { type: "image", url: "data:image/png;base64,AA==" },
          { type: "localAudio", path: "/tmp/voice.ogg" },
          {
            type: "skill",
            name: "systematic-debugging",
            path: "/tmp/project/.codex/skills/systematic-debugging/SKILL.md",
          },
          {
            type: "mention",
            name: "GitHub",
            path: "plugin://github@local",
          },
        ],
        cwd: "/tmp/project",
        model: "gpt-selected",
        effort: "high",
        serviceTier: null,
      });
    expect(transport.sent.filter((message) => message.method === "turn/start")[1]?.params)
      .toMatchObject({
        clientUserMessageId: "codex_connect:request-fast",
        serviceTier: "priority",
      });
    expect(transport.sent.find((message) => message.method === "turn/steer")?.params)
      .toMatchObject({ clientUserMessageId: "codex_connect:request-2" });
  });

  it("lists official collaboration presets and sends the selected mode on turn/start", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listCollaborationModes()).resolves.toEqual([
      { name: "Default", mode: "default", model: null, effort: null },
      { name: "Plan", mode: "plan", model: null, effort: "medium" },
    ]);
    await client.startTurn(
      "thread-1",
      [{ type: "text", text: "设计发布流程" }],
      "codex_connect:plan-1",
      "/tmp/project",
      {
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-selected",
            effort: "medium",
            developerInstructions: null,
          },
        },
      },
    );

    expect(transport.sent.find((message) => message.method === "collaborationMode/list"))
      .toMatchObject({ params: {} });
    expect(transport.sent.find((message) => message.method === "turn/start")?.params)
      .toMatchObject({
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-selected",
            reasoning_effort: "medium",
            developer_instructions: null,
          },
        },
      });
  });

  it("maps Review and Goal responses to stable Application results", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    const review = await client.startReview("thread-1", {
      type: "commit",
      sha: "abc123",
      title: null,
    });
    const goal = await client.getGoal("thread-1");
    const updated = await client.setGoal("thread-1", "完成协议边界");
    await client.clearGoal("thread-1");
    await client.interruptTurn("thread-1", "turn-1");
    await client.setThreadName("thread-1", "新名称");
    await client.setThreadPinned("thread-1", false);
    await client.compactThread("thread-1");

    expect(review).toEqual({ threadId: "thread-1", turnId: "review-turn-1" });
    expect(goal).toEqual({
      threadId: "thread-1",
      objective: "完成协议边界",
      status: "active",
      tokenBudget: null,
      tokensUsed: 100,
      timeUsedSeconds: 10,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(updated).toEqual(goal);
    expect(transport.sent.find((message) => message.method === "review/start")?.params)
      .toEqual({
        threadId: "thread-1",
        target: { type: "commit", sha: "abc123", title: null },
        delivery: "inline",
      });
    expect(transport.sent.find((message) => message.method === "thread/goal/set")?.params)
      .toEqual({
        threadId: "thread-1",
        objective: "完成协议边界",
        status: "active",
      });
    expect(transport.sent.find((message) => message.method === "turn/interrupt")?.params)
      .toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(transport.sent.find((message) => message.method === "thread/metadata/update")?.params)
      .toEqual(undefined);
  });

  it("fails closed when a Goal response lacks a required stable field", async () => {
    const transport = new FakeTransport();
    transport.goal = appServerGoal({ objective: undefined });
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.getGoal("thread-1"))
      .rejects.toThrow("Codex 响应缺少有效 goal objective");
  });

  it("uses CODEX_MODEL only when starting a new thread", async () => {
    const transport = new FakeTransport();
    const rpc = new JsonRpcClient(transport);
    const client = new CodexAppServerClient(rpc, {
      sandbox: "workspace-write",
      model: "gpt-configured",
    });
    await client.connect();

    await client.startThread("/tmp/project");
    await client.startTurn(
      "thread-1",
      [{ type: "text", text: "测试输入" }],
      "request-1",
      "/tmp/project",
    );

    const starts = transport.sent.filter((message) => message.method === "thread/start");
    expect(starts[0]?.params)
      .toMatchObject({ model: "gpt-configured", serviceName: "codex_connect" });
    expect(transport.sent.find((message) => message.method === "turn/start")?.params)
      .not.toHaveProperty("model");
  });

  it("starts a new thread with an explicit model provider", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.startThread("/tmp/project", {
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
    });

    expect(transport.sent.find((message) => message.method === "thread/start")?.params)
      .toMatchObject({
        model: "deepseek-v4-flash",
        modelProvider: "deepseek",
      });
  });

  it("encodes the closed automation Thread source without experimental fields", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "read-only",
    });
    await client.connect();

    await client.startThread("/tmp/project", { threadSource: "automation" });

    const params = transport.sent.find((message) => message.method === "thread/start")?.params;
    expect(params).toMatchObject({ threadSource: "automation" });
    expect(params).not.toHaveProperty("dynamicTools");
    expect(params).not.toHaveProperty("additionalContext");
  });

  it("registers dynamic tool functions on thread start", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.startThread("/tmp/project", {
      dynamicTools: [{
        type: "function",
        name: "schedule_task",
        description: "Create a scheduled task",
        inputSchema: {
          type: "object",
          properties: { action: { type: "string" } },
          required: ["action"],
        },
      }],
    });

    expect(transport.sent.find((message) => message.method === "thread/start")?.params)
      .toMatchObject({
        dynamicTools: [{
          type: "function",
          name: "schedule_task",
          description: "Create a scheduled task",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
            required: ["action"],
          },
        }],
      });
  });

  it("starts a new thread with workspace permissions", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.startThread("/tmp/project", {
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });

    expect(transport.sent.find((message) => message.method === "thread/start")?.params)
      .toMatchObject({
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      });
  });

  it("prefers a permission profile over sandbox when starting a thread", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.startThread("/tmp/project", {
      permissions: ":read-only",
      sandbox: "workspace-write",
    });

    const params = transport.sent
      .find((message) => message.method === "thread/start")?.params;
    expect(params).toMatchObject({ permissions: ":read-only" });
    expect(params).not.toHaveProperty("sandbox");
  });

  it("resumes a thread with workspace permissions", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.resumeThread("thread-1", "/tmp/project", {
      sandbox: "read-only",
      approvalPolicy: "untrusted",
    });

    expect(transport.sent.find((message) => message.method === "thread/resume")?.params)
      .toMatchObject({
        sandbox: "read-only",
        approvalPolicy: "untrusted",
      });
  });

  it("forks a thread with an explicit model provider", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    const forked = await client.forkThread("thread-1", "/tmp/project", {
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
    });

    expect(forked).toMatchObject({
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      thread: { id: "thread-forked" },
    });
    expect(transport.sent.find((message) => message.method === "thread/fork")?.params)
      .toMatchObject({
        threadId: "thread-1",
        model: "deepseek-v4-flash",
        modelProvider: "deepseek",
      });
  });
