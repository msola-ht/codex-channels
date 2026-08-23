import { describe, expect, it, vi } from "vitest";

import {
  ScheduledTaskDraftCoordinator,
  type ScheduledTaskDraftTurnPort,
} from "../src/application/index.js";
import type { ConversationInputEvent, ConversationTarget } from "../src/conversation-core/index.js";

const target: ConversationTarget = {
  surface: "feishu",
  accountId: "account-1",
  conversationId: "conversation-1",
};
const context = {
  cwd: "/workspace",
  modelProvider: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "low",
  serviceTier: null,
};

function turnPort(): ScheduledTaskDraftTurnPort {
  return {
    start: vi.fn(async (_context, _text, _schema, onThreadStarted) => {
      onThreadStarted("draft-thread-1");
      return { threadId: "draft-thread-1", turnId: "draft-turn-1" };
    }),
    interrupt: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

describe("ScheduledTaskDraftCoordinator", () => {
  it("只消费专用临时 Thread 的结构化结果并在完成后释放", async () => {
    const port = turnPort();
    const coordinator = new ScheduledTaskDraftCoordinator(port);
    const drafting = coordinator.draft(target, "actor-1", "每天九点检查 CI，北京时间", context);
    await vi.waitFor(() => expect(port.start).toHaveBeenCalledOnce());
    coordinator.handleInput(started());
    coordinator.handleInput(completedText(validDraft()));
    coordinator.handleInput(turnCompleted("completed"));

    await expect(drafting).resolves.toEqual({
      prompt: "检查 CI",
      timezone: "Asia/Shanghai",
      schedule: { type: "daily", time: "09:00" },
    });
    expect(port.release).toHaveBeenCalledWith("draft-thread-1");
    coordinator.close();
  });

  it("忽略其他 Thread 的事件", async () => {
    const port = turnPort();
    const coordinator = new ScheduledTaskDraftCoordinator(port);
    const drafting = coordinator.draft(target, "actor-1", "每天九点检查 CI，北京时间", context);
    await vi.waitFor(() => expect(port.start).toHaveBeenCalledOnce());
    coordinator.handleInput({ ...completedText("not-json"), threadId: "other-thread" } as ConversationInputEvent);
    coordinator.handleInput({ ...turnCompleted("completed"), threadId: "other-thread" } as ConversationInputEvent);
    coordinator.handleInput(started());
    coordinator.handleInput(completedText(validDraft()));
    coordinator.handleInput(turnCompleted("completed"));
    await expect(drafting).resolves.toMatchObject({ prompt: "检查 CI" });
    coordinator.close();
  });

  it("同一 Conversation 的不同 Actor 也不能并发创建草案", async () => {
    const port = turnPort();
    const coordinator = new ScheduledTaskDraftCoordinator(port);
    const first = coordinator.draft(target, "actor-1", "每天九点检查 CI，北京时间", context);
    await vi.waitFor(() => expect(port.start).toHaveBeenCalledOnce());
    expect(() => coordinator.draft(target, "actor-2", "另一个任务，北京时间", context))
      .toThrow(expect.objectContaining({ message: "当前会话已有计划任务草案正在生成" }));
    coordinator.handleInput(started());
    coordinator.handleInput(turnCompleted("failed"));
    await expect(first).rejects.toMatchObject({ message: "计划任务草案生成失败，请重试" });
    coordinator.close();
  });

  it("超时后中断并释放临时 Thread，允许再次创建", async () => {
    vi.useFakeTimers();
    const port = turnPort();
    const coordinator = new ScheduledTaskDraftCoordinator(port, 100);
    const first = coordinator.draft(target, "actor-1", "每天九点检查 CI，北京时间", context);
    const firstRejected = expect(first).rejects.toMatchObject({ message: "计划任务理解超时，请简化描述后重试" });
    await vi.advanceTimersByTimeAsync(100);
    await firstRejected;
    expect(port.interrupt).toHaveBeenCalledWith("draft-thread-1", "draft-turn-1");
    expect(port.release).toHaveBeenCalledWith("draft-thread-1");

    const second = coordinator.draft(target, "actor-1", "每天十点检查 CI，北京时间", context);
    const secondRejected = expect(second).rejects.toMatchObject({ message: "计划任务理解超时，请简化描述后重试" });
    await vi.advanceTimersByTimeAsync(100);
    await secondRejected;
    coordinator.close();
    vi.useRealTimers();
  });

  it("缺少时区时使用固定澄清文案而不回显模型文本", async () => {
    const port = turnPort();
    const coordinator = new ScheduledTaskDraftCoordinator(port);
    const drafting = coordinator.draft(target, "actor-1", "每天九点检查 CI", context);
    await vi.waitFor(() => expect(port.start).toHaveBeenCalledOnce());
    coordinator.handleInput(started());
    coordinator.handleInput(completedText(JSON.stringify({
      kind: "clarification",
      prompt: null,
      scheduleType: "daily",
      intervalHours: null,
      time: "09:00",
      days: [],
      timezone: null,
      missing: ["timezone"],
    })));
    coordinator.handleInput(turnCompleted("completed"));
    await expect(drafting).rejects.toMatchObject({
      message: "请补充计划任务时区，例如 Asia/Shanghai 或北京时间",
    });
    coordinator.close();
  });

  it("观察到工具操作时中断并拒绝草案", async () => {
    const port = turnPort();
    vi.mocked(port.release).mockRejectedValueOnce(new Error("temporary unsubscribe failure"));
    const coordinator = new ScheduledTaskDraftCoordinator(port);
    const drafting = coordinator.draft(target, "actor-1", "每天九点检查 CI，北京时间", context);
    await vi.waitFor(() => expect(port.start).toHaveBeenCalledOnce());
    coordinator.handleInput(started());
    coordinator.handleInput({
      type: "item.operation.updated",
      threadId: "draft-thread-1",
      turnId: "draft-turn-1",
      operation: {
        itemId: "tool-1",
        kind: "contextCompaction",
        status: "running",
      },
    });

    await expect(drafting).rejects.toMatchObject({
      message: "计划任务草案尝试使用工具，已安全取消",
    });
    expect(port.interrupt).toHaveBeenCalledWith("draft-thread-1", "draft-turn-1");
    expect(port.release).toHaveBeenCalledTimes(2);
    expect(port.release).toHaveBeenCalledWith("draft-thread-1");
    coordinator.close();
  });
});

function validDraft(): string {
  return JSON.stringify({
    kind: "draft",
    prompt: "检查 CI",
    scheduleType: "daily",
    intervalHours: null,
    time: "09:00",
    days: [],
    timezone: "Asia/Shanghai",
    missing: [],
  });
}

function started(): ConversationInputEvent {
  return { type: "turn.started", threadId: "draft-thread-1", turnId: "draft-turn-1" };
}

function completedText(text: string): ConversationInputEvent {
  return {
    type: "item.agentMessage.completed",
    threadId: "draft-thread-1",
    turnId: "draft-turn-1",
    itemId: "item-1",
    text,
    phase: "final_answer",
  };
}

function turnCompleted(status: "completed" | "failed"): ConversationInputEvent {
  return {
    type: "turn.completed",
    threadId: "draft-thread-1",
    turnId: "draft-turn-1",
    status,
    error: null,
  };
}
