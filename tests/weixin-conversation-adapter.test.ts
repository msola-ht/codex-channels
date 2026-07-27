import { describe, expect, it, vi } from "vitest";

import type { ConversationService } from "../src/application/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import {
  WeixinConversationAdapter,
} from "../src/surfaces/weixin/index.js";

const target: ConversationTarget = {
  surface: "weixin",
  accountId: "account-fixture@im.bot",
  conversationId: "actor-fixture@im.wechat",
};

const message = {
  target,
  actorId: "actor-fixture@im.wechat",
  text: "继续开发",
};

describe("WeixinConversationAdapter", () => {
  it("keeps ordinary text on the shared conversation submission path", async () => {
    const submit = vi.fn(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: false,
    }));
    const notifyText = vi.fn(() => true);
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ submit }),
      { notifyText },
    );

    await adapter.handle(message);

    expect(submit).toHaveBeenCalledWith(target, "继续开发");
    expect(notifyText).not.toHaveBeenCalled();
  });

  it("handles local help and identity without starting a Turn", async () => {
    const submit = vi.fn();
    const notifyText = vi.fn(() => true);
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ submit }),
      { notifyText },
    );

    await adapter.handle({ ...message, text: "/start" });
    await adapter.handle({ ...message, text: "/help" });
    await adapter.handle({ ...message, text: "/whoami" });

    expect(submit).not.toHaveBeenCalled();
    expect(notifyText).toHaveBeenNthCalledWith(1, target, [
      "微信 Codex 基础命令",
      "/status 查看当前 Workspace、Thread 与运行状态",
      "/new 退出当前会话，下一条普通消息新建 Thread",
      "/stop 停止当前任务",
      "/whoami 查看当前微信连接身份",
      "/start · /help 查看本说明",
    ].join("\n\n"));
    expect(notifyText).toHaveBeenNthCalledWith(
      2,
      target,
      expect.stringContaining("/stop"),
    );
    expect(notifyText).toHaveBeenNthCalledWith(
      3,
      target,
      expect.stringContaining("actor-fixture@im.wechat"),
    );
  });

  it("uses shared status, new, and stop command semantics", async () => {
    const status = vi.fn(() => ({
      workspaceId: "main",
      workspaceName: "Main",
      cwd: "/workspace",
      gitBranch: "feature/weixin-surface",
      threadId: "thread",
      turnId: null,
      model: "gpt-test",
      effort: "medium",
      serviceTier: null,
      modelPending: false,
      effortPending: false,
      fastModePending: false,
    }));
    const newSession = vi.fn(async () => {});
    const stop = vi.fn(async () => true);
    const notifyText = vi.fn(() => true);
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ status, newSession, stop }),
      { notifyText },
    );

    await adapter.handle({ ...message, text: "  /status  " });
    await adapter.handle({ ...message, text: "/new" });
    await adapter.handle({ ...message, text: "/stop" });

    expect(status).toHaveBeenCalledWith(target, {
      includeGitBranch: true,
    });
    expect(newSession).toHaveBeenCalledWith(target);
    expect(stop).toHaveBeenCalledWith(target);
    expect(notifyText).toHaveBeenNthCalledWith(
      1,
      target,
      expect.stringMatching(
        /^Codex 状态\n\nWorkspace：[\s\S]*\n\nGit 分支：feature\/weixin-surface/u,
      ),
    );
    expect(notifyText).toHaveBeenNthCalledWith(
      2,
      target,
      "已退出当前会话，下一条普通消息将创建新的 Codex Thread。",
    );
    expect(notifyText).toHaveBeenNthCalledWith(
      3,
      target,
      "已请求停止当前任务。",
    );
  });

  it("rejects unknown slash commands without submitting them to Codex", async () => {
    const submit = vi.fn();
    const notifyText = vi.fn(() => true);
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ submit }),
      { notifyText },
    );

    await adapter.handle({ ...message, text: "/unknown value" });

    expect(submit).not.toHaveBeenCalled();
    expect(notifyText).toHaveBeenCalledWith(
      target,
      "操作失败：不支持该微信命令，请发送 /help 查看可用命令。",
    );
  });

  it("fails the input batch when a command result cannot enter the output queue", async () => {
    const adapter = new WeixinConversationAdapter(
      serviceFixture({
        stop: vi.fn(async () => false),
      }),
      { notifyText: vi.fn(() => false) },
    );

    await expect(
      adapter.handle({ ...message, text: "/stop" }),
    ).rejects.toThrow("微信输出队列拒绝消息");
  });
});

function serviceFixture(
  methods: Partial<Record<keyof ConversationService, unknown>>,
): ConversationService {
  return methods as unknown as ConversationService;
}
