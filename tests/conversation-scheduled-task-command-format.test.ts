import { describe, expect, it } from "vitest";

import {
  formatConversationCommandOutcome,
  formatConversationScheduledConfirmation,
  formatConversationScheduledRuns,
  formatConversationScheduledTasks,
  formatScheduledTaskStatusLabel,
} from "../src/surfaces/conversation-command-format.js";

describe("conversation scheduled task command formatting", () => {
  it("distinguishes an enabled scheduled task from a running Run", () => {
    const rendered = formatConversationScheduledTasks({
      kind: "scheduled-tasks",
      result: {
        tasks: [{
          taskId: "task-1",
          name: "每日检查",
          status: "active",
          schedule: { type: "daily", time: "09:00" },
          timezone: "Asia/Shanghai",
          nextRunAt: Date.parse("2026-08-24T01:00:00.000Z"),
          workspaceId: "main",
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "low",
          serviceTier: null,
          sandbox: "workspace-write",
          permissions: null,
          promptPreview: "检查项目状态",
        }],
        selectors: ["1"],
        page: 1,
        pageCount: 1,
        totalTaskCount: 1,
      },
    });

    expect(rendered).toContain("每日检查 · 已启用");
    expect(rendered).not.toContain("每日检查 · 运行中");
    expect([
      formatScheduledTaskStatusLabel("paused"),
      formatScheduledTaskStatusLabel("blocked"),
      formatScheduledTaskStatusLabel("deleted"),
    ]).toEqual(["已暂停", "已阻止", "已删除"]);
  });

  it("renders scheduled task and Run selectors as stable semantic labels", () => {
    const task = {
      taskId: "task-1",
      name: "每小时检查",
      status: "active" as const,
      schedule: { type: "interval" as const, intervalMinutes: 60, anchorAt: 1 },
      timezone: "Asia/Shanghai",
      nextRunAt: 2,
      workspaceId: "main",
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      serviceTier: null,
      sandbox: "workspace-write" as const,
      permissions: null,
      promptPreview: "检查项目",
    };
    const tasks = formatConversationScheduledTasks({
      kind: "scheduled-tasks",
      result: {
        tasks: [task, { ...task, taskId: "task-2", name: "第二项" }],
        selectors: ["1", "2"],
        page: 1,
        pageCount: 1,
        totalTaskCount: 2,
      },
    });
    const runs = formatConversationScheduledRuns({
      kind: "scheduled-runs",
      result: {
        task,
        runs: [
          {
            runId: "run-1",
            taskId: task.taskId,
            scheduledFor: 1,
            state: "completed",
            threadId: "thread-1",
            turnId: "turn-1",
            dispatchStartedAt: 1,
            startedAt: 1,
            completedAt: 2,
            errorCategory: null,
            errorMessage: null,
            selector: "1",
          },
          {
            runId: "run-2",
            taskId: task.taskId,
            scheduledFor: 2,
            state: "completed",
            threadId: "thread-2",
            turnId: "turn-2",
            dispatchStartedAt: 2,
            startedAt: 2,
            completedAt: 3,
            errorCategory: null,
            errorMessage: null,
            selector: "2",
          },
        ],
        page: 1,
        pageCount: 1,
        totalRunCount: 2,
      },
    });

    expect(tasks).toContain("【1】每小时检查");
    expect(tasks).toContain("【2】第二项");
    expect(runs).toContain("【1】run-1");
    expect(runs).toContain("【2】run-2");
    expect(runs).toContain("### 运行记录");
    expect(runs).toContain("  - 计划时间：");
    expect(runs).toContain("  - 触发时间：1970-01-01T00:00:00.001Z");
    expect(runs).toContain("  - 开始时间：1970-01-01T00:00:00.001Z");
    expect(runs).toContain("  - 完成时间：1970-01-01T00:00:00.002Z");
    expect(runs).toContain("  - Session ID：thread-1");
    expect(runs).not.toContain("\n- 计划时间：");
  });

  it("renders a relative once task as a one-shot delay", () => {
    const rendered = formatConversationScheduledTasks({
      kind: "scheduled-tasks",
      result: {
        tasks: [{
          taskId: "task-relative",
          name: "延时回复",
          status: "active",
          schedule: {
            type: "once",
            afterMinutes: 1,
            anchorAt: Date.parse("2026-08-23T14:49:18.500Z"),
          },
          timezone: "Asia/Shanghai",
          nextRunAt: Date.parse("2026-08-23T14:50:18.500Z"),
          workspaceId: "main",
          modelProvider: "deepseek",
          model: "deepseek-flash",
          reasoningEffort: "high",
          serviceTier: null,
          sandbox: "read-only",
          permissions: null,
          promptPreview: "回复“计划任务测试成功”",
        }],
        selectors: ["1"],
        page: 1,
        pageCount: 1,
        totalTaskCount: 1,
      },
    });

    expect(rendered).toContain("一次性 1 分钟后");
  });

  it("renders the scheduled confirmation with a combined provider/model", () => {
    const rendered = formatConversationScheduledConfirmation({
      kind: "scheduled-confirmation",
      preview: {
        action: "create",
        token: "token-1",
        expiresAt: Date.parse("2026-08-23T12:05:00.000Z"),
        task: {
          taskId: "task-1",
          name: "每日检查",
          status: "active",
          schedule: { type: "daily", time: "09:00" },
          timezone: "Asia/Shanghai",
          nextRunAt: Date.parse("2026-08-24T01:00:00.000Z"),
          workspaceId: "main",
          modelProvider: "deepseek",
          model: "deepseek-v4-flash",
          reasoningEffort: "high",
          serviceTier: null,
          sandbox: "workspace-write",
          permissions: null,
          promptPreview: "检查项目状态",
        },
      },
    });

    expect(rendered).toContain("模型：deepseek/deepseek-v4-flash");
    expect(rendered).toContain("/schedule confirm token-1");
  });

  it("renders the scheduled task outcome with its model and reasoning effort", () => {
    const rendered = formatConversationCommandOutcome({
      type: "scheduled-task.created",
      task: {
        taskId: "task-1",
        name: "提醒我：收到消息",
        status: "active",
        schedule: { type: "once", date: "2026-08-24", time: "10:00" },
        timezone: "Asia/Shanghai",
        nextRunAt: Date.parse("2026-08-24T02:00:00.000Z"),
        workspaceId: "main",
        modelProvider: "deepseek",
        model: "deepseek-flash",
        reasoningEffort: "high",
        serviceTier: null,
        sandbox: "workspace-write",
        permissions: null,
        promptPreview: "提醒我：收到消息",
      },
    });

    expect(rendered).toContain("模型：deepseek/deepseek-flash");
    expect(rendered).toContain("思考等级：high");
    expect(rendered).toContain("计划：一次性 2026-08-24 10:00 · Asia/Shanghai");
    expect(rendered).toContain("下次运行：2026-08-24T02:00:00.000Z");
  });

  it("renders the scheduled run trigger time", () => {
    const rendered = formatConversationCommandOutcome({
      type: "scheduled-task.run-requested",
      run: {
        runId: "run-1",
        taskId: "task-1",
        scheduledFor: Date.parse("2026-08-24T02:00:00.000Z"),
        state: "dispatching",
        threadId: null,
        turnId: null,
        dispatchStartedAt: Date.parse("2026-08-24T02:00:01.000Z"),
        startedAt: null,
        completedAt: null,
        errorCategory: null,
        errorMessage: null,
      },
    });

    expect(rendered).toContain("计划时间：2026-08-24T02:00:00.000Z");
    expect(rendered).toContain("触发时间：2026-08-24T02:00:01.000Z");
  });

});
