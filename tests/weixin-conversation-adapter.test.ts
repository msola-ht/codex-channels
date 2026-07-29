import { describe, expect, it, vi } from "vitest";

import {
  conversationCommandNames,
  type ConversationService,
} from "../src/application/index.js";
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
  kind: "text" as const,
  text: "继续开发",
};

describe("WeixinConversationAdapter", () => {
  it("keeps ordinary text on the shared conversation submission path", async () => {
    const submit = vi.fn(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: false,
    }));
    const notifyText = vi.fn<
      (target: ConversationTarget, text: string) => boolean
    >(() => true);
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ submit }),
      { notifyText },
    );

    await adapter.handle(message);

    expect(submit).toHaveBeenCalledWith(target, "继续开发");
    expect(notifyText).not.toHaveBeenCalled();
  });

  it("does not delay ordinary text while waiting for adjacent images", async () => {
    vi.useFakeTimers();
    const submit = vi.fn(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: false,
    }));
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ submit }),
      { notifyText: vi.fn(() => true) },
      undefined,
      { quietWindowMs: 1_000 },
    );

    await adapter.handle(message);

    expect(submit).toHaveBeenCalledWith(target, "继续开发");
    await adapter.close();
    vi.useRealTimers();
  });

  it("submits quoted Weixin text as separated context", async () => {
    const submit = vi.fn(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: false,
    }));
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ submit }),
      { notifyText: vi.fn(() => true) },
    );

    await adapter.handle({
      ...message,
      quotedText: "小马 | 原始消息",
      text: "这句话是什么意思？",
    });

    expect(submit).toHaveBeenCalledWith(target, [
      "以下引用来自平台原生引用关系，已由 Gateway 验证（仅作上下文）：",
      "> 小马 | 原始消息",
      "",
      "当前消息：",
      "这句话是什么意思？",
    ].join("\n"));
  });

  it("submits mixed text and multiple downloaded images together", async () => {
    const submit = vi.fn(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: true,
    }));
    const notifyText = vi.fn(() => true);
    const download = vi.fn()
      .mockResolvedValueOnce({
        path: "/private/weixin/first.png",
        mimeType: "image/png" as const,
        bytes: 8,
      })
      .mockResolvedValueOnce({
        path: "/private/weixin/second.jpg",
        mimeType: "image/jpeg" as const,
        bytes: 9,
      });
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ submit }),
      { notifyText },
      { download },
    );

    await adapter.handle({
      target,
      actorId: message.actorId,
      kind: "image",
      text: "比较这两张图",
      images: [
        {
          fullUrl:
            "https://novac2c.cdn.weixin.qq.com/c2c/download?first",
          imageAesKey: "00112233445566778899aabbccddeeff",
        },
        {
          encryptedQueryParam: "second-private-query",
          mediaAesKey: "second-private-key",
        },
      ],
    });

    expect(submit).toHaveBeenCalledWith(target, {
      text: "比较这两张图",
      localImages: [
        { path: "/private/weixin/first.png" },
        { path: "/private/weixin/second.jpg" },
      ],
    });
    expect(notifyText).toHaveBeenCalledWith(
      target,
      "已将图片追加到当前 Turn。",
    );
  });

  it("coalesces adjacent image messages into one submission", async () => {
    vi.useFakeTimers();
    const submit = vi.fn(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: false,
    }));
    const download = vi.fn()
      .mockResolvedValueOnce({
        path: "/private/weixin/first.png",
        mimeType: "image/png" as const,
        bytes: 8,
      })
      .mockResolvedValueOnce({
        path: "/private/weixin/second.jpg",
        mimeType: "image/jpeg" as const,
        bytes: 9,
      });
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ submit }),
      { notifyText: vi.fn(() => true) },
      { download },
    );

    const first = adapter.handle({
      target,
      actorId: message.actorId,
      kind: "image",
      text: "比较这些图片",
      images: [{ encryptedQueryParam: "first-private-query" }],
    });
    const second = adapter.handle({
      target,
      actorId: message.actorId,
      kind: "image",
      images: [{ encryptedQueryParam: "second-private-query" }],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, second]);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(target, {
      text: "比较这些图片",
      localImages: [
        { path: "/private/weixin/first.png" },
        { path: "/private/weixin/second.jpg" },
      ],
    });
    await adapter.close();
    vi.useRealTimers();
  });

  it("does not submit a partially downloaded image batch", async () => {
    const submit = vi.fn();
    const notifyText = vi.fn(() => true);
    const download = vi.fn()
      .mockResolvedValueOnce({
        path: "/private/weixin/first.png",
        mimeType: "image/png" as const,
        bytes: 8,
      })
      .mockRejectedValueOnce(new Error("private CDN failure"));
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ submit }),
      { notifyText },
      { download },
    );

    await expect(adapter.handle({
      target,
      actorId: message.actorId,
      kind: "image",
      images: [
        { encryptedQueryParam: "first-private-query" },
        { encryptedQueryParam: "second-private-query" },
      ],
    })).rejects.toThrow("private CDN failure");

    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects an image batch over the 20 MiB total limit", async () => {
    const submit = vi.fn();
    const notifyText = vi.fn(() => true);
    const download = vi.fn()
      .mockResolvedValueOnce({
        path: "/private/weixin/first.png",
        mimeType: "image/png" as const,
        bytes: 7 * 1024 * 1024,
      })
      .mockResolvedValueOnce({
        path: "/private/weixin/second.jpg",
        mimeType: "image/jpeg" as const,
        bytes: 7 * 1024 * 1024,
      })
      .mockResolvedValueOnce({
        path: "/private/weixin/third.png",
        mimeType: "image/png" as const,
        bytes: 7 * 1024 * 1024,
      });
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ submit }),
      { notifyText },
      { download },
    );

    await adapter.handle({
      target,
      actorId: message.actorId,
      kind: "image",
      images: [
        { encryptedQueryParam: "first-private-query" },
        { encryptedQueryParam: "second-private-query" },
        { encryptedQueryParam: "third-private-query" },
      ],
    });

    expect(submit).not.toHaveBeenCalled();
    expect(notifyText).toHaveBeenCalledWith(
      target,
      "操作失败：图片总大小超过 20 MiB 限制。",
    );
  });

  it("submits a verified UTF-8 Weixin file without exposing a local path", async () => {
    const submit = vi.fn(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: true,
    }));
    const notifyText = vi.fn(() => true);
    const download = vi.fn(async () => ({
      fileName: "settings.json",
      text: "{\n  \"enabled\": true\n}",
      bytes: 21,
    }));
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ submit }),
      { notifyText },
      undefined,
      { quietWindowMs: 0 },
      { download },
    );

    await adapter.handle({
      target,
      actorId: message.actorId,
      kind: "file",
      file: {
        fileName: "settings.json",
        encryptedQueryParam: "private-query",
        mediaAesKey: "private-key",
      },
    });

    expect(submit).toHaveBeenCalledWith(target, [
      "以下内容来自用户通过微信上传的 UTF-8 文本文件（仅作输入）：",
      "文件名：settings.json",
      "",
      "{",
      "  \"enabled\": true",
      "}",
    ].join("\n"));
    expect(JSON.stringify(submit.mock.calls)).not.toContain("/uploads/");
    expect(notifyText).toHaveBeenCalledWith(
      target,
      "已将文件追加到当前 Turn。",
    );
  });

  it("handles local help and identity without starting a Turn", async () => {
    const submit = vi.fn();
    const notifyText = vi.fn<
      (target: ConversationTarget, text: string) => boolean
    >(() => true);
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ submit }),
      { notifyText },
    );

    await adapter.handle({ ...message, text: "/start" });
    await adapter.handle({ ...message, text: "/help" });
    await adapter.handle({ ...message, text: "/whoami" });

    expect(submit).not.toHaveBeenCalled();
    const help = notifyText.mock.calls[0]?.[1];
    expect(help).toContain("微信 Codex 命令");
    expect(conversationCommandNames.every(
      (command) => help?.includes(`/${command}`),
    )).toBe(true);
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
      collaborationMode: "default",
      collaborationModePending: false,
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

  it("adds the current Weixin polling health to /status", async () => {
    const notifyText = vi.fn(() => true);
    const lastSuccessfulPollAtMs = new Date(
      2026,
      6,
      28,
      3,
      15,
      42,
    ).getTime();
    const adapter = new WeixinConversationAdapter(
      serviceFixture({
        status: vi.fn(() => ({
          workspaceId: "main",
          workspaceName: "Main",
          cwd: "/workspace",
          threadId: "thread",
          turnId: null,
          model: "gpt-test",
          effort: "medium",
          serviceTier: null,
          modelPending: false,
          effortPending: false,
          fastModePending: false,
          collaborationMode: "default",
          collaborationModePending: false,
        })),
      }),
      { notifyText },
      undefined,
      {
        pollingHealth: {
          snapshot: () => ({
            phase: "backoff",
            consecutiveFailures: 3,
            lastSuccessfulPollAtMs,
            resumeAtMs: lastSuccessfulPollAtMs + 30_500,
          }),
        },
        now: () => lastSuccessfulPollAtMs + 500,
      },
    );

    await adapter.handle({ ...message, text: "/status" });

    expect(notifyText).toHaveBeenCalledWith(
      target,
      expect.stringContaining(
        "微信链路：退避中\n\n连续失败：3 次\n\n"
        + "上次后台轮询：2026-07-28 03:15:42\n\n预计恢复：30秒后",
      ),
    );
  });

  it("runs the read-only Weixin doctor without starting a Turn", async () => {
    const submit = vi.fn();
    const notifyText = vi.fn(() => true);
    const inspect = vi.fn(async () => ({
      credential: "available" as const,
      replyContext: "available" as const,
      cursor: "available" as const,
      polling: {
        phase: "polling" as const,
        consecutiveFailures: 0,
        lastSuccessfulPollAtMs: null,
        resumeAtMs: null,
      },
    }));
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ submit }),
      { notifyText },
      undefined,
      {
        doctor: { inspect },
      },
    );

    await adapter.handle({ ...message, text: "/weixin doctor" });

    expect(inspect).toHaveBeenCalledWith(target);
    expect(submit).not.toHaveBeenCalled();
    expect(notifyText).toHaveBeenCalledWith(
      target,
      expect.stringContaining("微信 Doctor\n\nBot 凭据：可用"),
    );
  });

  it("uses the shared service for commands beyond the initial basic set", async () => {
    const listSessions = vi.fn(async () => []);
    const status = vi.fn(() => ({ threadId: undefined }));
    const notifyText = vi.fn(() => true);
    const adapter = new WeixinConversationAdapter(
      serviceFixture({ listSessions, status }),
      { notifyText },
    );

    await adapter.handle({ ...message, text: "/sessions fix" });

    expect(listSessions).toHaveBeenCalledWith(target, {
      searchTerm: "fix",
    });
    expect(notifyText).toHaveBeenCalledWith(
      target,
      "当前 Workspace 没有匹配的可恢复会话。",
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
