import { describe, expect, it, vi } from "vitest";

import {
  ConversationService,
  ScheduledTaskToolService,
  isLikelyScheduledTaskInput,
  scheduledTaskToolSpec,
  type ScheduledTaskUseCases,
} from "../src/application/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import {
  createScheduledTaskToolRequestHandler,
} from "../src/bootstrap/index.js";
import { JsonRpcError } from "../src/codex-client/index.js";
import {
  ConversationCore,
} from "../src/conversation-core/index.js";
import type { TurnExecutionPort } from "../src/application/turn-port.js";
import type { SessionRouter } from "../src/session-routing/router.js";

const target: ConversationTarget = {
  surface: "feishu",
  accountId: "app-1",
  conversationId: "chat-1",
};

describe("ScheduledTaskToolService", () => {
  it("does not expose confirmation through the model tool", () => {
    const actions = scheduledTaskToolSpec.inputSchema.properties.action.enum;
    expect(actions).not.toContain("confirm");
  });

  it("detects common schedule-like natural language for the fresh-Thread upgrade path", () => {
    expect(isLikelyScheduledTaskInput([{ type: "text", text: "每天 09:00 检查 CI" }]))
      .toBe(true);
    expect(isLikelyScheduledTaskInput([{ type: "text", text: "每天吃什么好" }]))
      .toBe(false);
    expect(isLikelyScheduledTaskInput([{ type: "text", text: "帮我看看这个仓库" }]))
      .toBe(false);
  });

  it("turns interval arguments into an existing create preview", async () => {
    const tasks = fakeTasks();
    const service = new ScheduledTaskToolService(tasks);

    const result = await service.execute(target, "actor-1", {
      action: "create",
      scheduleType: "interval",
      intervalMinutes: 15,
      timezone: "Asia/Shanghai",
      prompt: "检查 CI",
    });

    expect(result).toMatchObject({
      kind: "confirmation",
      preview: {
        action: "create",
        task: { name: "检查 CI" },
      },
    });
    expect(tasks.previewCreate).toHaveBeenCalledWith(
      target,
      "actor-1",
      expect.objectContaining({
        schedule: expect.objectContaining({
          type: "interval",
          intervalMinutes: 15,
        }),
        timezone: "Asia/Shanghai",
        prompt: "检查 CI",
      }),
    );
  });

  it("supports once with a relative delay and leaves confirmation to the existing command", async () => {
    const tasks = fakeTasks();
    const service = new ScheduledTaskToolService(tasks);

    const preview = await service.execute(target, "actor-1", {
      action: "create",
      scheduleType: "once",
      afterMinutes: 1,
      timezone: "Asia/Shanghai",
      prompt: "回复测试成功",
    });
    expect(preview).toMatchObject({ kind: "confirmation" });

    await expect(service.execute(target, "actor-1", {
      action: "confirm",
      token: "token-1",
    })).resolves.toMatchObject({ kind: "error" });
    expect(tasks.confirm).not.toHaveBeenCalled();
  });

  it("returns a safe error instead of throwing for invalid tool arguments", async () => {
    const service = new ScheduledTaskToolService(fakeTasks());
    await expect(service.execute(target, "actor-1", {
      action: "create",
      scheduleType: "interval",
      timezone: "not-a-timezone",
      prompt: "检查",
    })).resolves.toEqual({
      kind: "error",
      message: "无效的 IANA 时区：not-a-timezone",
    });
  });

  it("supports list and lifecycle actions through the existing use cases", async () => {
    const tasks = fakeTasks();
    const service = new ScheduledTaskToolService(tasks);

    await expect(service.execute(target, "actor-1", {
      action: "list",
    })).resolves.toMatchObject({ kind: "tasks" });
    await expect(service.execute(target, "actor-1", {
      action: "pause",
      selector: "1",
    })).resolves.toMatchObject({
      kind: "outcome",
      outcome: { action: "paused" },
    });
    await expect(service.execute(target, "actor-1", {
      action: "run",
      selector: "1",
    })).resolves.toMatchObject({
      kind: "outcome",
      outcome: { action: "run-requested" },
    });
    await expect(service.execute(target, "actor-1", {
      action: "delete",
      selector: "1",
    })).resolves.toMatchObject({
      kind: "confirmation",
      preview: { action: "delete" },
    });
  });
});

describe("ConversationService schedule tool upgrade path", () => {
  it("switches an old Thread to a tool-enabled fresh session before the turn", async () => {
    const oldBinding = {
      target,
      workspaceId: "main",
      threadId: "old-thread",
      sessionId: "old-session",
    };
    const newBinding = {
      target,
      workspaceId: "main",
      threadId: "new-thread",
      sessionId: "new-session",
    };
    const router = {
      current: () => oldBinding,
      hasDynamicTools: () => false,
      newSession: vi.fn(async () => {}),
      ensure: vi.fn(async () => newBinding),
      workspace: () => ({ id: "main", name: "Main", cwd: "/workspace" }),
    } as unknown as SessionRouter;
    const core = {
      activeTurn: () => undefined,
      markTurnStarted: vi.fn(),
    } as unknown as ConversationCore;
    const models = {
      threadStartOptions: () => undefined,
      turnOverrides: () => ({}),
      markApplied: vi.fn(),
    };
    const codex = {
      startTurn: vi.fn(async () => ({ turnId: "new-turn" })),
    } as unknown as TurnExecutionPort;
    const service = new ConversationService(
      codex,
      router,
      core,
      models as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        enabled: true,
        isLikelyScheduleInput: isLikelyScheduledTaskInput,
      },
    );

    await service.submit(target, "每天 09:00 检查 CI");

    expect(router.newSession).toHaveBeenCalledWith(target);
    expect(codex.startTurn).toHaveBeenCalledWith(
      "new-thread",
      [{ type: "text", text: "每天 09:00 检查 CI" }],
      expect.stringMatching(/^codex_connect:/u),
      "/workspace",
      expect.anything(),
    );
  });
});

describe("createScheduledTaskToolRequestHandler", () => {
  it("formats a dynamic tool call as protocol content", async () => {
    const execute = vi.fn(async () => ({
      kind: "confirmation" as const,
      preview: createPreview(),
    }));
    const handle = createScheduledTaskToolRequestHandler({
      targetForThread: () => target,
      actorsForTarget: () => ["actor-1"],
      execute,
    });

    const response = await handle({
      id: 1,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "schedule_task",
        arguments: { action: "create" },
      },
    });

    expect(response).toMatchObject({
      contentItems: [{ type: "inputText" }],
      success: true,
    });
    expect(JSON.stringify(response)).toContain("/schedule confirm");
  });

  it("rejects an unknown dynamic tool", async () => {
    const handle = createScheduledTaskToolRequestHandler({
      targetForThread: () => target,
      actorsForTarget: () => ["actor-1"],
      execute: async () => ({ kind: "error", message: "unused" }),
    });

    await expect(handle({
      id: 1,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "other_tool",
        arguments: {},
      },
    })).rejects.toBeInstanceOf(JsonRpcError);
  });

  it("fails closed when the Thread cannot be resolved to one authorized actor", async () => {
    const handle = createScheduledTaskToolRequestHandler({
      targetForThread: () => undefined,
      actorsForTarget: () => [],
      execute: async () => ({ kind: "error", message: "unused" }),
    });

    await expect(handle({
      id: 1,
      method: "item/tool/call",
      params: {
        threadId: "thread-missing",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "schedule_task",
        arguments: {},
      },
    })).resolves.toMatchObject({ success: false });
  });
});

function fakeTasks() {
  const task = view();
  return {
    previewCreate: vi.fn(() => createPreview()),
    confirm: vi.fn(() => ({ action: "created" as const, task })),
    list: vi.fn(() => ({
      tasks: [task],
      selectors: ["1"],
      page: 1,
      pageCount: 1,
      totalTaskCount: 1,
    })),
    runs: vi.fn(() => ({
      task,
      runs: [],
      page: 1,
      pageCount: 1,
      totalRunCount: 0,
    })),
    rename: vi.fn(() => task),
    pause: vi.fn(() => ({ ...task, status: "paused" as const })),
    resume: vi.fn(() => ({ ...task, status: "active" as const })),
    run: vi.fn(async () => run()),
    retry: vi.fn(async () => run()),
    previewDelete: vi.fn(() => ({
      action: "delete" as const,
      token: "token-delete",
      expiresAt: Date.now() + 60_000,
      task,
    })),
  } as unknown as ScheduledTaskUseCases;
}

function createPreview() {
  return {
    action: "create" as const,
    token: "token-1",
    expiresAt: Date.now() + 60_000,
    task: view(),
  };
}

function view() {
  return {
    taskId: "task-1",
    name: "检查 CI",
    status: "active" as const,
    schedule: { type: "interval" as const, intervalMinutes: 15, anchorAt: 0 },
    timezone: "Asia/Shanghai",
    nextRunAt: Date.now() + 15 * 60_000,
    workspaceId: "main",
    modelProvider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: null,
    serviceTier: null,
    sandbox: "workspace-write" as const,
    permissions: null,
    promptPreview: "检查 CI",
  };
}

function run() {
  return {
    runId: "run-1",
    taskId: "task-1",
    scheduledFor: Date.now(),
    state: "dispatching" as const,
    threadId: null,
    turnId: null,
    dispatchStartedAt: null,
    startedAt: null,
    completedAt: null,
    errorCategory: null,
    errorMessage: null,
  };
}
