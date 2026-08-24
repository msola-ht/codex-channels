import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ScheduledTaskApplicationService,
  type ScheduledTaskApplicationPort,
} from "../src/application/index.js";
import {
  parseNaturalScheduledTaskDraft,
  parseScheduledTaskOperation,
} from "../src/application/scheduled-task-command.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import { UserFacingError } from "../src/conversation-core/index.js";
import { SqliteScheduledTaskStore } from "../src/scheduled-tasks/index.js";

const directories: string[] = [];
const now = Date.parse("2026-08-23T12:00:00.000Z");
const target: ConversationTarget = {
  surface: "feishu",
  accountId: "app-1",
  conversationId: "chat-1",
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ScheduledTaskApplicationService", () => {
  it("creates a confirmation from a deterministic natural sentence without a model draft", async () => {
    const { store, service } = createService(() => now);
    const preview = service.previewNaturalLanguage(
      target,
      "actor-1",
      "1 分钟后 Asia/Shanghai 回复“计划任务测试成功”",
    );
    expect(preview.task.schedule).toEqual({
      type: "once",
      afterMinutes: 1,
      anchorAt: now,
    });
    expect(service.confirm(target, "actor-1", preview.token)).toMatchObject({
      action: "created",
      task: { status: "active" },
    });
    store.close();
  });

  it("carries a trailing model from natural language into the create preview", () => {
    const { store, service } = createService();
    const preview = service.previewNaturalLanguage(
      target,
      "actor-1",
      "1 分钟后 Asia/Shanghai 回复测试成功 用 deepseek/deepseek-v4-flash",
    );
    expect(preview.task.modelProvider).toBe("deepseek");
    expect(preview.task.model).toBe("deepseek-v4-flash");
    store.close();
  });

  it("rejects an unrecognized natural description without starting a model draft", async () => {
    const { store, service } = createService(() => now);
    expect(() => service.previewNaturalLanguage(
      target,
      "actor-1",
      "随便提醒我一下",
    )).toThrow(expect.objectContaining({ code: "scheduled-task.command.invalid" }));
    store.close();
  });

  it("requires an exact actor-bound preview before creating and consumes the token once", async () => {
    const { store, service } = createService();
    const preview = service.previewCreate(target, "actor-1", {
      schedule: { type: "daily", time: "09:00" },
      timezone: "Asia/Shanghai",
      prompt: "检查项目状态",
    });

    expect(preview).toMatchObject({
      action: "create",
      task: {
        name: "检查项目状态",
        workspaceId: "main",
        model: "gpt-5.6-sol",
        sandbox: "workspace-write",
        nextRunAt: Date.parse("2026-08-24T01:00:00.000Z"),
      },
    });
    expect(() => service.confirm(target, "actor-2", preview.token))
      .toThrow(expect.objectContaining({ code: "scheduled-task.forbidden" }));
    expect(service.confirm(target, "actor-1", preview.token)).toMatchObject({
      action: "created",
      task: { status: "active" },
    });
    expect(() => service.confirm(target, "actor-1", preview.token))
      .toThrow(expect.objectContaining({ code: "scheduled-task.confirmation.invalid" }));
    expect(store.listTasks({ conversation: target })).toHaveLength(1);
    store.close();
  });

  it("removes expired create confirmations that retain prompts", () => {
    vi.useFakeTimers();
    const { store, service } = createService();
    try {
      const preview = service.previewCreate(target, "actor-1", {
        schedule: { type: "daily", time: "09:00" },
        timezone: "UTC",
        prompt: "敏感的待确认内容",
      });

      vi.advanceTimersByTime(5 * 60_000 + 1);
      expect((service as unknown as { confirmations: Map<string, unknown> }).confirmations).toHaveLength(0);
      expect(() => service.confirm(target, "actor-1", preview.token))
        .toThrow(expect.objectContaining({ code: "scheduled-task.confirmation.invalid" }));
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("rechecks the per-actor conversation task limit when confirming", () => {
    const { store, service } = createService();
    for (let index = 0; index < 99; index += 1) {
      store.createTask(taskInput({ taskId: `task-${index}` }));
    }
    const first = service.previewCreate(target, "actor-1", {
      schedule: { type: "daily", time: "09:00" },
      timezone: "UTC",
      prompt: "第一条待确认任务",
    });
    const second = service.previewCreate(target, "actor-1", {
      schedule: { type: "daily", time: "10:00" },
      timezone: "UTC",
      prompt: "第二条待确认任务",
    });

    service.confirm(target, "actor-1", first.token);
    expect(() => service.confirm(target, "actor-1", second.token))
      .toThrow(expect.objectContaining({ code: "scheduled-task.state.invalid" }));
    expect(store.listTasks({ conversation: target })).toHaveLength(100);
    store.close();
  });

  it("scopes numeric selectors to fresh actor snapshots and supports lifecycle operations", async () => {
    const { store, service, runTaskNow } = createService();
    const task = store.createTask(taskInput());

    expect(() => service.pause(target, "actor-1", "1"))
      .toThrow(expect.objectContaining({ code: "scheduled-task.snapshot.required" }));
    expect(service.list(target, "actor-1").selectors).toEqual(["1"]);
    expect(service.rename(target, "actor-1", "1", " 每日检查 ").name).toBe("每日检查");
    expect(service.pause(target, "actor-1", "1").status).toBe("paused");
    expect(service.resume(target, "actor-1", "1").status).toBe("active");
    await service.run(target, "actor-1", "1");
    expect(runTaskNow).toHaveBeenCalledWith(task.taskId);
    expect(() => service.list(target, "actor-2"))
      .toThrow(expect.objectContaining({ code: "scheduled-task.forbidden" }));
    store.close();
  });

  it("maps store state failures to a surface-safe user-facing error", () => {
    const { store, service } = createService();
    store.createTask(taskInput({ createdAt: now + 1 }));

    expect(() => service.rename(target, "actor-1", "task-1", "新名称"))
      .toThrow(expect.objectContaining({
        code: "scheduled-task.state.invalid",
        constructor: UserFacingError,
      }));
    store.close();
  });

  it("retries only the latest listed uncertain Run and closes it first", async () => {
    const { store, service, runTaskNow } = createService();
    const task = store.createTask(taskInput());
    const claimed = store.claimManual(task.taskId, now);
    store.markUncertain(claimed.run.runId, now + 1);

    expect(service.runs(target, "actor-1", task.taskId).runs[0]?.selector).toBe("1");
    await service.retry(target, "actor-1", "1");
    expect(store.getRun(claimed.run.runId)?.state).toBe("failed");
    expect(runTaskNow).toHaveBeenCalledWith(task.taskId);
    store.close();
  });

  it("resolves an explicit provider/model selection and fails closed on an unconfigured Provider", () => {
    const { store, service } = createService();
    const preview = service.previewCreate(target, "actor-1", {
      schedule: { type: "daily", time: "09:00" },
      timezone: "UTC",
      prompt: "用 deepseek 模型检查",
      model: "deepseek/deepseek-v4-flash",
    });
    expect(preview.task.modelProvider).toBe("deepseek");
    expect(preview.task.model).toBe("deepseek-v4-flash");
    expect(service.confirm(target, "actor-1", preview.token)).toMatchObject({
      action: "created",
      task: { modelProvider: "deepseek", model: "deepseek-v4-flash" },
    });

    expect(() => service.previewCreate(target, "actor-1", {
      schedule: { type: "daily", time: "09:00" },
      timezone: "UTC",
      prompt: "测试",
      model: "unknown/model-x",
    })).toThrow(expect.objectContaining({ code: "scheduled-task.command.invalid" }));
    store.close();
  });

  it("uses the current session Provider when only a bare model ID is given", () => {
    const { store, service } = createService();
    const preview = service.previewCreate(target, "actor-1", {
      schedule: { type: "daily", time: "09:00" },
      timezone: "UTC",
      prompt: "检查",
      model: "gpt-5.6-terra",
    });
    expect(preview.task.modelProvider).toBe("openai");
    expect(preview.task.model).toBe("gpt-5.6-terra");
    store.close();
  });
});

describe("parseScheduledTaskOperation", () => {
  it("parses supported schedules and rejects unsupported forms", () => {
    expect(parseScheduledTaskOperation(
      "add weekly MO,FR 09:30 Asia/Shanghai 检查周报",
      now,
    )).toMatchObject({
      type: "create",
      request: {
        schedule: { type: "weekly", days: ["MO", "FR"], time: "09:30" },
        timezone: "Asia/Shanghai",
      },
    });
    expect(() => parseScheduledTaskOperation("add monthly 1 UTC test"))
      .toThrow(expect.objectContaining({ code: "scheduled-task.command.invalid" }));
    expect(parseScheduledTaskOperation("每天 09:00 在 Asia/Shanghai 检查 CI"))
      .toEqual({ type: "natural", description: "每天 09:00 在 Asia/Shanghai 检查 CI" });
  });

  it("deterministically parses common natural language schedule sentences", () => {
    expect(parseNaturalScheduledTaskDraft("1 分钟后 Asia/Shanghai 发送报告", now)).toEqual({
      schedule: { type: "once", afterMinutes: 1, anchorAt: now },
      timezone: "Asia/Shanghai",
      prompt: "发送报告",
    });
    expect(parseNaturalScheduledTaskDraft("每 15 分钟 Asia/Shanghai 检查 CI", now)).toEqual({
      schedule: { type: "interval", intervalMinutes: 15, anchorAt: now },
      timezone: "Asia/Shanghai",
      prompt: "检查 CI",
    });
    expect(parseNaturalScheduledTaskDraft("每天 09:00 Asia/Shanghai 检查 CI", now)).toEqual({
      schedule: { type: "daily", time: "09:00" },
      timezone: "Asia/Shanghai",
      prompt: "检查 CI",
    });
    expect(parseNaturalScheduledTaskDraft("每天 09:00 在 Asia/Shanghai 检查 CI", now)).toEqual({
      schedule: { type: "daily", time: "09:00" },
      timezone: "Asia/Shanghai",
      prompt: "检查 CI",
    });
    expect(parseNaturalScheduledTaskDraft("这不是可解析的计划描述", now)).toBeNull();
  });

  it("parses an optional trailing model marker on add forms", () => {
    expect(parseScheduledTaskOperation(
      "add daily 09:00 Asia/Shanghai 检查 CI 用 deepseek/deepseek-v4-flash",
      now,
    )).toMatchObject({
      type: "create",
      request: {
        schedule: { type: "daily", time: "09:00" },
        timezone: "Asia/Shanghai",
        prompt: "检查 CI",
        model: "deepseek/deepseek-v4-flash",
      },
    });
    expect(parseScheduledTaskOperation(
      "add interval 5m Asia/Shanghai 检查 用 gpt-5.6-terra",
      now,
    )).toMatchObject({
      type: "create",
      request: {
        schedule: { type: "interval", intervalMinutes: 5 },
        model: "gpt-5.6-terra",
      },
    });
  });
});

function createService(
  clock: () => number = () => now,
): {
  readonly store: SqliteScheduledTaskStore;
  readonly service: ScheduledTaskApplicationService;
  readonly runTaskNow: ReturnType<typeof vi.fn<ScheduledTaskApplicationPort["runTaskNow"]>>;
} {
  const directory = mkdtempSync(join(tmpdir(), "codexc-scheduled-application-"));
  directories.push(directory);
  chmodSync(directory, 0o700);
  const store = new SqliteScheduledTaskStore(join(directory, "scheduled.sqlite3"));
  const runTaskNow = vi.fn<ScheduledTaskApplicationPort["runTaskNow"]>(async (taskId) =>
    store.claimManual(taskId, now + 2).run
  );
  const application: ScheduledTaskApplicationPort = {
    isActorAuthorized: (_target, actorId) => actorId === "actor-1",
    isProviderConfigured: (provider) => provider === "openai" || provider === "deepseek",
    creationContext: () => ({
      workspaceId: "main",
      workspaceName: "Main",
      cwd: "/workspace",
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      serviceTier: null,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      permissions: null,
      modelPending: false,
      effortPending: false,
      serviceTierPending: false,
    }),
    runTaskNow,
  };
  return {
    store,
    service: new ScheduledTaskApplicationService(store, application, clock),
    runTaskNow,
  };
}

function taskInput(overrides: Partial<ReturnType<typeof baseTaskInput>> = {}) {
  return { ...baseTaskInput(), ...overrides };
}

function baseTaskInput() {
  return {
    taskId: "task-1",
    name: "检查",
    surface: target.surface,
    accountId: target.accountId,
    conversationId: target.conversationId,
    actorId: "actor-1",
    workspaceId: "main",
    prompt: "检查项目状态",
    schedule: { type: "daily" as const, time: "09:00" },
    timezone: "UTC",
    modelProvider: "openai",
    model: "gpt-5.6-sol",
    sandbox: "workspace-write" as const,
    approvalPolicy: "never" as const,
    createdAt: now,
  };
}
