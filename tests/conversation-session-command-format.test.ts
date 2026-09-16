import { describe, expect, it } from "vitest";

import {
  formatConversationCommandOutcome,
  formatConversationOccupancy,
  formatConversationSessions,
  formatConversationThreadQueue,
  formatConversationThreadRevert,
  formatConversationThreadRevertPreview,
} from "../src/surfaces/conversation-command-format.js";

describe("conversation session command formatting", () => {
  it("renders the reasoning effort for a listed session", () => {
    const rendered = formatConversationSessions({
      kind: "sessions",
      sessions: [{
        id: "thread-000000000001",
        preview: "网关会话元数据",
        name: null,
        isPinned: false,
        model: "gpt-server",
        reasoningEffort: "high",
        modelProvider: "openai",
        status: { type: "idle" },
      }],
      archived: false,
      page: 1,
      pageCount: 1,
      matchedSessionCount: 1,
      view: { page: 1, filter: "all", provider: null, searchTerm: null },
    });

    expect(rendered).toContain("模型：gpt-server");
    expect(rendered).toContain("思考等级：high");
  });

  it("distinguishes an empty Queue from an out-of-range page", () => {
    const missingPage = formatConversationThreadQueue({
      kind: "thread-queue",
      result: {
        items: [],
        selectors: [],
        page: 2,
        pageCount: 1,
        totalItemCount: 1,
      },
    });
    expect(missingPage).toContain("第 2 页不存在，共 1 页");
    expect(missingPage).toContain("/queue list 1");
    expect(missingPage).not.toContain("Queue 为空");

    const empty = formatConversationThreadQueue({
      kind: "thread-queue",
      result: {
        items: [],
        selectors: [],
        page: 1,
        pageCount: 1,
        totalItemCount: 0,
      },
    });
    expect(empty).toContain("Queue 为空");
  });

  it("renders bounded Revert selection and destructive confirmation warnings", () => {
    const listed = formatConversationThreadRevert({
      kind: "thread-revert",
      result: {
        threadId: "thread-1",
        turns: [{
          id: "turn-1",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1_000,
          inputType: "text",
          textPreview: "需要回退的任务",
        }],
        selectors: ["1"],
        page: 1,
        hasNextPage: false,
      },
    });
    expect(listed).toContain("turn-1");
    expect(listed).toContain("最近五分钟");

    const preview = formatConversationThreadRevertPreview({
      kind: "thread-revert-preview",
      preview: {
        threadId: "thread-1",
        beforeTurnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1_000,
          inputType: "text",
          textPreview: "需要回退的任务",
        },
        affectedTurnCount: 2,
        activeTurnId: "turn-active",
        queueItemCount: 2,
        token: "one-time-token",
      },
    });
    expect(preview).toContain("会被中断");
    expect(preview).toContain("按原顺序保留");
    expect(preview).toContain("不会恢复工作区文件");
    expect(preview).toContain("其他客户端");
    expect(preview).toContain("/revert confirm one-time-token");
  });

  it("renders occupancy release results", () => {
    expect(formatConversationOccupancy({
      kind: "occupancy",
      result: { status: "unbound" },
    })).toContain("当前会话没有绑定 Codex Session");
    expect(formatConversationOccupancy({
      kind: "occupancy",
      result: { status: "free", threadId: "thread-free" },
    })).toContain("未被占用");

    const held = formatConversationOccupancy({
      kind: "occupancy",
      result: {
        status: "held",
        threadId: "thread-held",
        holder: { pid: 4242, command: "codex app-server" },
        releasable: true,
        stuck: true,
      },
    });
    expect(held).toContain("PID 4242");
    expect(held).toContain("当前会话恢复失败");

    expect(formatConversationOccupancy({
      kind: "occupancy",
      result: {
        status: "held",
        threadId: "thread-healthy",
        holder: { pid: 4245, command: "codex app-server" },
        releasable: true,
        stuck: false,
      },
    })).toContain("通常无需释放");

    const longCommand = formatConversationOccupancy({
      kind: "occupancy",
      result: {
        status: "held",
        threadId: "thread-long",
        holder: {
          pid: 4243,
          command: `codex ${"-c model=long ".repeat(30)}app-server`,
        },
        releasable: true,
        stuck: true,
      },
    });
    expect(longCommand).toContain("…");
    expect(longCommand.length).toBeLessThan(400);

    expect(formatConversationOccupancy({
      kind: "occupancy",
      result: {
        status: "released",
        threadId: "thread-held",
        holder: { pid: 4242, command: "codex app-server" },
      },
    })).toContain("已释放 Codex Session 占用");
    expect(formatConversationOccupancy({
      kind: "occupancy",
      result: { status: "unidentifiable", threadId: "thread-x" },
    })).toContain("无法识别占用");
  });

  it("shows the model used by the next message after changing session context", () => {
    const nextModel = { model: "gpt-5.6", modelProvider: "openai" };

    expect(formatConversationCommandOutcome({
      type: "session.new",
      nextModel,
    })).toContain("发送下一条普通消息时才会创建新的 Codex Session");
    expect(formatConversationCommandOutcome({
      type: "session.new",
      backgroundedThreadId: "thread-running",
      nextModel,
    })).toContain("新会话已准备，原任务继续在后台运行");
    expect(formatConversationCommandOutcome({
      type: "session.new",
      backgroundedThreadId: "thread-running",
      nextModel,
    })).toContain("恢复会话：/r thread-running");
    expect(formatConversationCommandOutcome({
      type: "session.new",
      previousThreadId: "thread-idle",
      nextModel,
    })).toContain("Session ID：thread-idle");
    expect(formatConversationCommandOutcome({
      type: "session.new",
      previousThreadId: "thread-idle",
      nextModel,
    })).toContain("恢复会话：/r thread-idle");
    expect(formatConversationCommandOutcome({
      type: "session.new",
      nextModel,
    })).toContain("下一条消息模型：gpt-5.6 · Provider：openai");
    expect(formatConversationCommandOutcome({
      type: "session.new",
      nextModel,
    })).not.toContain("Session ID：");
    expect(formatConversationCommandOutcome({
      type: "session.new",
      nextModel,
    })).not.toContain("恢复会话：");
    expect(formatConversationCommandOutcome({
      type: "workspace.selected",
      workspace: { id: "other", name: "Other", cwd: "/other" },
      nextModel,
    })).toContain("下一条消息模型：gpt-5.6 · Provider：openai");
  });

  it("shows the model bound to a resumed session", () => {
    expect(formatConversationCommandOutcome({
      type: "thread.resumed",
      threadId: "thread-1",
      model: { model: "deepseek-v4-pro", modelProvider: "deepseek" },
    })).toContain("会话模型：deepseek-v4-pro · Provider：deepseek");
    expect(formatConversationCommandOutcome({
      type: "thread.resumed",
      threadId: "thread-cold",
      queuePending: true,
      model: { model: "gpt-test", modelProvider: "openai" },
    })).toContain("已沿用该 Session 自身设置");
  });

});
