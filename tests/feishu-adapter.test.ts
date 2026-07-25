import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  conversationCommandNames,
  type ConversationService,
} from "../src/application/index.js";
import { UserFacingError } from "../src/conversation-core/index.js";
import {
  FeishuConversationAdapter,
  FeishuOutbox,
  type FeishuInboxMessage,
} from "../src/surfaces/feishu/index.js";

const message: FeishuInboxMessage = {
  target: {
    surface: "feishu",
    accountId: "cli_0123456789abcdef",
    conversationId: "oc_chat",
  },
  actorId: "ou_actor",
  eventId: "event-1",
  messageId: "om_message",
  createdAtMs: 1_784_900_000_000,
  text: "继续开发",
};

describe("Feishu conversation adapter", () => {
  it("handles Feishu-local help, identity, and cancellation commands without starting a Turn", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationService,
      fixture.outbox,
    );

    for (const text of ["/start", "/help", "/whoami", "/cancel"]) {
      await adapter.handle({ ...message, text });
    }
    await fixture.outbox.close();

    expect(submit).not.toHaveBeenCalled();
    expect(fixture.sent).toHaveLength(4);
    expect(fixture.sent[0]?.text).toContain("飞书 Codex 命令");
    expect(fixture.sent[0]?.text).toContain("/status");
    expect(conversationCommandNames.every(
      (command) => fixture.sent[0]?.text.includes(`/${command}`),
    )).toBe(true);
    expect(fixture.sent[1]?.text).toBe(fixture.sent[0]?.text);
    expect(fixture.sent[2]?.text).toBe([
      "飞书身份",
      "用户 Open ID：ou_actor",
      "Chat ID：oc_chat",
      "App ID：cli_0123456789abcdef",
    ].join("\n"));
    expect(fixture.sent[3]?.text).toBe("当前没有待处理的交互请求。");
  });

  it("rejects an unknown slash command instead of submitting it as model input", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationService,
      fixture.outbox,
    );

    for (const text of ["/unknown", "/unknown-command", "/STATUS", "/"]) {
      await expect(
        adapter.handle({ ...message, text }),
      ).rejects.toMatchObject({ code: "command.unsupported" });
    }
    await fixture.outbox.close();

    expect(submit).not.toHaveBeenCalled();
    expect(fixture.sent).toEqual(Array.from({ length: 4 }, () => ({
      chatId: "oc_chat",
      text: "操作失败：不支持该飞书命令，请发送 /help 查看可用命令。",
    })));
  });

  it("routes an authorized status command through Application instead of starting a Turn", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const status = vi.fn(() => ({
      workspaceId: "main",
      workspaceName: "Main",
      cwd: "/workspace",
      threadId: "thread-1",
      turnId: "turn-1",
      model: "gpt-test",
      effort: "medium",
      serviceTier: "priority",
      modelPending: false,
      effortPending: false,
      fastModePending: false,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit, status } as unknown as ConversationService,
      fixture.outbox,
    );

    await adapter.handle({ ...message, text: "/status" });
    await fixture.outbox.close();

    expect(submit).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(message.target);
    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: [
        "Codex 状态",
        "Workspace：Main (main)",
        "Thread：thread-1",
        "Turn：turn-1",
        "工作目录：/workspace",
        "模型：gpt-test",
        "思考强度：medium",
        "Fast 模式：开启",
        "",
        "当前 Thread 用量：等待 App Server 推送统计",
      ].join("\n"),
    }]);
  });

  it("forwards command arguments through the shared Application command service", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const queueFollowUp = vi.fn(async () => ({
      threadId: "thread-1",
      position: 2,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit, queueFollowUp } as unknown as ConversationService,
      fixture.outbox,
    );

    await adapter.handle({ ...message, text: "/queue 继续检查参数" });
    await fixture.outbox.close();

    expect(submit).not.toHaveBeenCalled();
    expect(queueFollowUp).toHaveBeenCalledWith(
      message.target,
      "继续检查参数",
    );
    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "已排到下一 Turn，当前第 2 条。队列仅保存在内存，Gateway 重启会清空。",
    }]);
  });

  it("reports output queue rejection after a state-changing command without retrying it", async () => {
    const newSession = vi.fn(async () => undefined);
    const notifyText = vi.fn(() => false);
    const adapter = new FeishuConversationAdapter(
      { newSession } as unknown as ConversationService,
      { notifyText } as unknown as FeishuOutbox,
    );

    await expect(
      adapter.handle({ ...message, text: "/new" }),
    ).rejects.toMatchObject({ name: "FeishuOutputQueueError" });

    expect(newSession).toHaveBeenCalledTimes(1);
    expect(notifyText).toHaveBeenCalledTimes(1);
  });

  it("submits an accepted private text message to Application", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationService,
      fixture.outbox,
    );

    await expect(adapter.handle(message)).resolves.toBeUndefined();
    await fixture.outbox.close();

    expect(submit).toHaveBeenCalledWith(message.target, "继续开发");
    expect(fixture.sent).toEqual([]);
  });

  it("confirms when the message was added to the active Turn", async () => {
    const fixture = createOutbox();
    const adapter = new FeishuConversationAdapter(
      {
        submit: async () => ({
          threadId: "thread-1",
          turnId: "turn-1",
          steered: true,
        }),
      } as unknown as ConversationService,
      fixture.outbox,
    );

    await adapter.handle(message);
    await fixture.outbox.close();

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "已将补充要求追加到当前 Turn。",
    }]);
  });

  it("renders a structured user error without exposing its fallback message", async () => {
    const fixture = createOutbox();
    const failure = new UserFacingError(
      "thread.bound",
      "opaque upstream detail",
    );
    const adapter = new FeishuConversationAdapter(
      {
        submit: async () => {
          throw failure;
        },
      } as unknown as ConversationService,
      fixture.outbox,
    );

    await expect(adapter.handle(message)).rejects.toBe(failure);
    await fixture.outbox.close();

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "操作失败：该 Codex Thread 已绑定到其他会话。",
    }]);
    expect(JSON.stringify(fixture.sent)).not.toContain("opaque");
  });

  it("hides an unknown internal error and returns it to the Inbox diagnostic path", async () => {
    const fixture = createOutbox();
    const failure = new Error("Authorization: secret");
    const adapter = new FeishuConversationAdapter(
      {
        submit: async () => {
          throw failure;
        },
      } as unknown as ConversationService,
      fixture.outbox,
    );

    await expect(adapter.handle(message)).rejects.toBe(failure);
    await fixture.outbox.close();

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "操作失败：Gateway 未能完成请求，请稍后重试。",
    }]);
    expect(JSON.stringify(fixture.sent)).not.toContain("secret");
  });
});

function createOutbox(): {
  outbox: FeishuOutbox;
  sent: Array<{ chatId: string; text: string }>;
} {
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    sent,
    outbox: new FeishuOutbox(
      message.target.accountId,
      {
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
      },
      pino({ level: "silent" }),
    ),
  };
}
