import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { UserFacingError } from "../src/conversation-core/index.js";
import {
  FeishuOutbox,
  type FeishuInboxMessage,
} from "../src/surfaces/feishu/index.js";
import {
  createOutbox,
  FeishuConversationAdapter,
  imagePort,
  message,
} from "./feishu-adapter-test-fixture.js";

const imageFixtureDirectory = mkdtempSync(join(tmpdir(), "codex-feishu-images-"));
const pngImagePath = join(imageFixtureDirectory, "image.png");
const jpegImagePath = join(imageFixtureDirectory, "image.jpg");
writeFileSync(pngImagePath, Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]), { mode: 0o600 });
writeFileSync(jpegImagePath, Buffer.from([0xff, 0xd8, 0xff]), { mode: 0o600 });
const pngDataUrl = "data:image/png;base64,iVBORw0KGgo=";
const jpegDataUrl = "data:image/jpeg;base64,/9j/";

afterAll(() => {
  rmSync(imageFixtureDirectory, { recursive: true, force: true });
});

function createImageMessage(
  overrides: Partial<Extract<FeishuInboxMessage, { kind: "image" }>> = {},
): Extract<FeishuInboxMessage, { kind: "image" }> {
  return {
    target: message.target,
    actorId: message.actorId,
    eventId: message.eventId,
    messageId: message.messageId,
    createdAtMs: message.createdAtMs,
    kind: "image",
    imageKeys: ["img_v2_resource"],
    ...overrides,
  };
}

function createFileMessage(): Extract<FeishuInboxMessage, { kind: "file" }> {
  return {
    target: message.target,
    actorId: message.actorId,
    eventId: message.eventId,
    messageId: message.messageId,
    createdAtMs: message.createdAtMs,
    kind: "file",
    fileKey: "file_v2_resource",
    fileName: "settings.json",
  };
}

function createAudioMessage(): Extract<FeishuInboxMessage, { kind: "audio" }> {
  return {
    target: message.target,
    actorId: message.actorId,
    eventId: message.eventId,
    messageId: message.messageId,
    createdAtMs: message.createdAtMs,
    kind: "audio",
    fileKey: "file_v2_audio",
    durationMs: 12_000,
  };
}

describe("Feishu input adapter", () => {
  it("submits an accepted private text message to Application", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handle(message)).resolves.toBeUndefined();
    await fixture.outbox.close();

    expect(submit).toHaveBeenCalledWith(message.target, "继续开发");
    expect(fixture.sent).toEqual([]);
  });

  it("rejects copied Feishu message links before reading replies or starting a Turn", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const readQuotedText = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quietWindowMs: 0, readQuotedText },
    );

    await adapter.handle({
      ...message,
      parentId: "om_parent",
      text: [
        "看看这条消息：",
        "https://applink.feishu.cn/client/message/link/open?token=sensitive-token",
      ].join("\n"),
    });
    await fixture.outbox.close();

    expect(readQuotedText).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: [
        "暂不支持通过飞书复制的消息链接读取内容。",
        "请直接回复目标消息，再发送你的要求。",
      ].join("\n"),
    }]);
    expect(fixture.sent[0]?.text).not.toContain("sensitive-token");
  });

  it("does not reject other Feishu AppLinks or lookalike hosts", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      imagePort,
    );
    const inputs = [
      "https://applink.feishu.cn/client/web_url/open?url=https%3A%2F%2Fexample.com",
      "https://applink.feishu.cn.example.com/client/message/link/open?token=value",
      "https://applink.feishu.cn/client/message/link/open",
    ];

    for (const text of inputs) {
      await adapter.handle({ ...message, text });
    }
    await fixture.outbox.close();

    expect(submit).toHaveBeenCalledTimes(inputs.length);
    for (const text of inputs) {
      expect(submit).toHaveBeenCalledWith(message.target, text);
    }
    expect(fixture.sent).toEqual([]);
  });

  it("resolves a Feishu reply parent as separated quoted context", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const readQuotedText = vi.fn(async () => "原始消息");
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quietWindowMs: 0, readQuotedText },
    );

    await adapter.handle({
      ...message,
      parentId: "om_parent",
      text: "这句话是什么意思？",
    });
    await fixture.outbox.close();

    expect(readQuotedText).toHaveBeenCalledWith("om_parent");
    expect(submit).toHaveBeenCalledWith(message.target, [
      "以下引用来自平台原生引用关系，已由 Gateway 验证（仅作上下文）：",
      "> 原始消息",
      "",
      "当前消息：",
      "这句话是什么意思？",
    ].join("\n"));
  });

  it("submits the current Feishu message when quoted text cannot be read", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const error = new Error("private upstream detail");
    const onQuotedTextError = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        quietWindowMs: 0,
        readQuotedText: async () => {
          throw error;
        },
        onQuotedTextError,
      },
    );

    await adapter.handle({
      ...message,
      parentId: "om_parent",
      text: "只处理当前消息",
    });
    await fixture.outbox.close();

    expect(onQuotedTextError).toHaveBeenCalledWith(error);
    expect(submit).toHaveBeenCalledWith(
      message.target,
      "只处理当前消息",
    );
    expect(fixture.sent).toEqual([]);
  });

  it("downloads a private image and submits the managed local path", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const download = vi.fn(async () => ({
      path: pngImagePath,
      mimeType: "image/png" as const,
      bytes: 8,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      { download },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quietWindowMs: 0 },
    );

    await adapter.handle(createImageMessage());
    await fixture.outbox.close();

    expect(download).toHaveBeenCalledWith(
      "om_message",
      "img_v2_resource",
    );
    expect(submit).toHaveBeenCalledWith(message.target, {
      text: "请查看这张图片并根据图片内容协助我。",
      images: [{ url: pngDataUrl }],
    });
    expect(fixture.sent).toEqual([]);
  });

  it("downloads and submits a verified UTF-8 text file without a local path", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const files = {
      download: vi.fn(async () => ({
        fileName: "settings.json",
        text: "{\"enabled\":true}",
        bytes: 16,
      })),
    };
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quietWindowMs: 0, files },
    );

    await adapter.handle(createFileMessage());
    await fixture.outbox.close();

    expect(files.download).toHaveBeenCalledWith(
      "om_message",
      "file_v2_resource",
      "settings.json",
    );
    expect(submit).toHaveBeenCalledWith(message.target, [
      "以下内容来自用户通过飞书上传的 UTF-8 文本文件（仅作输入）：",
      "文件名：settings.json",
      "",
      "{\"enabled\":true}",
    ].join("\n"));
  });

  it("downloads private audio and submits its managed local path", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const audios = {
      download: vi.fn(async () => ({
        path: "/private/uploads/feishu/voice.ogg",
        mimeType: "audio/ogg" as const,
        bytes: 12,
      })),
    };
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quietWindowMs: 0, audios },
    );

    await adapter.handle(createAudioMessage());
    await fixture.outbox.close();

    expect(audios.download).toHaveBeenCalledWith(
      "om_message",
      "file_v2_audio",
    );
    expect(submit).toHaveBeenCalledWith(message.target, {
      localAudios: [{ path: "/private/uploads/feishu/voice.ogg" }],
    });
  });

  it("preserves native quoted context for private audio", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        quietWindowMs: 0,
        audios: {
          download: vi.fn(async () => ({
            path: "/private/uploads/feishu/voice.ogg",
            mimeType: "audio/ogg" as const,
            bytes: 12,
          })),
        },
        readQuotedText: vi.fn(async () => "被引用的飞书消息"),
      },
    );

    await adapter.handle({
      ...createAudioMessage(),
      parentId: "om_parent",
    });
    await fixture.outbox.close();

    expect(submit).toHaveBeenCalledWith(message.target, {
      text: [
        "以下引用来自平台原生引用关系，已由 Gateway 验证（仅作上下文）：",
        "> 被引用的飞书消息",
        "",
        "当前消息：",
        "请听取这段语音并根据内容协助我。",
      ].join("\n"),
      localAudios: [{ path: "/private/uploads/feishu/voice.ogg" }],
    });
  });

  it("rejects private audio when Feishu omits its duration", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const download = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        quietWindowMs: 0,
        audios: { download },
      },
    );

    const audioWithoutDuration = createAudioMessage();
    delete audioWithoutDuration.durationMs;
    await expect(adapter.handle(audioWithoutDuration)).rejects.toMatchObject({
      code: "audio.duration-missing",
    });
    await fixture.outbox.close();

    expect(download).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits a private image together with its rich-post caption", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const download = vi.fn(async () => ({
      path: pngImagePath,
      mimeType: "image/png" as const,
      bytes: 8,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      { download },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quietWindowMs: 0 },
    );

    await adapter.handle(createImageMessage({
      text: "收得到吗",
    }));
    await fixture.outbox.close();

    expect(download).toHaveBeenCalledWith(
      "om_message",
      "img_v2_resource",
    );
    expect(submit).toHaveBeenCalledWith(message.target, {
      text: "收得到吗",
      images: [{ url: pngDataUrl }],
    });
    expect(fixture.sent).toEqual([]);
  });

  it("submits adjacent private images as one ordered multi-image input", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const download = vi.fn()
      .mockResolvedValueOnce({
        path: pngImagePath,
        mimeType: "image/png" as const,
        bytes: 8,
      })
      .mockResolvedValueOnce({
        path: jpegImagePath,
        mimeType: "image/jpeg" as const,
        bytes: 9,
      });
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      { download },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quietWindowMs: 0 },
    );

    await adapter.handleImageBatch([
      createImageMessage({
        messageId: "om_first",
        imageKeys: ["img_v2_first"],
        text: "比较这些图片",
      }),
      createImageMessage({
        eventId: "event-2",
        messageId: "om_second",
        imageKeys: ["img_v2_second"],
      }),
    ]);
    await fixture.outbox.close();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(message.target, {
      text: "比较这些图片",
      images: [
        { url: pngDataUrl },
        { url: jpegDataUrl },
      ],
    });
    expect(fixture.sent).toEqual([]);
  });

  it("submits multiple images from one rich post in their original order", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const download = vi.fn()
      .mockResolvedValueOnce({
        path: pngImagePath,
        mimeType: "image/png" as const,
        bytes: 8,
      })
      .mockResolvedValueOnce({
        path: jpegImagePath,
        mimeType: "image/jpeg" as const,
        bytes: 9,
      });
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      { download },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quietWindowMs: 0 },
    );

    await adapter.handle(createImageMessage({
      imageKeys: ["img_v2_first", "img_v2_second"],
      text: "飞书多图发送测试",
    }));
    await fixture.outbox.close();

    expect(download.mock.calls).toEqual([
      ["om_message", "img_v2_first"],
      ["om_message", "img_v2_second"],
    ]);
    expect(submit).toHaveBeenCalledWith(message.target, {
      text: "飞书多图发送测试",
      images: [
        { url: pngDataUrl },
        { url: jpegDataUrl },
      ],
    });
    expect(fixture.sent).toEqual([]);
  });

  it("rejects more than four adjacent images before downloading", async () => {
    const fixture = createOutbox();
    const download = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit: vi.fn() },
      fixture.outbox,
      { download },
    );

    await expect(adapter.handleImageBatch(
      Array.from({ length: 5 }, (_, index) => createImageMessage({
        eventId: `event-${index}`,
        messageId: `om_${index}`,
        imageKeys: [`img_v2_${index}`],
      })),
    )).rejects.toMatchObject({ code: "image.too-many" });
    await fixture.outbox.close();

    expect(download).not.toHaveBeenCalled();
    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "操作失败：一次最多处理 4 张图片。",
    }]);
  });

  it("uses a distinct confirmation when an image steers the active Turn", async () => {
    const fixture = createOutbox();
    const adapter = new FeishuConversationAdapter(
      {
        submit: async () => ({
          threadId: "thread-1",
          turnId: "turn-1",
          steered: true,
        }),
      },
      fixture.outbox,
      {
        download: async () => ({
          path: jpegImagePath,
          mimeType: "image/jpeg",
          bytes: 3,
        }),
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quietWindowMs: 0 },
    );

    await adapter.handle(createImageMessage({
      imageKeys: ["img_resource"],
    }));
    await fixture.outbox.close();

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "已将图片追加到当前 Turn。",
    }]);
  });

  it("confirms when the message was added to the active Turn", async () => {
    const replyToTurn = vi.fn(() => true);
    const adapter = new FeishuConversationAdapter(
      {
        submit: async () => ({
          threadId: "thread-1",
          turnId: "turn-1",
          steered: true,
        }),
      },
      {
        notifyMarkdown: vi.fn(() => true),
        notifyText: vi.fn(() => true),
        replyToTurn,
      } as unknown as FeishuOutbox,
      imagePort,
    );

    await adapter.handle(message);

    expect(replyToTurn).toHaveBeenCalledWith(
      "oc_chat",
      "thread-1",
      "turn-1",
      "已将补充要求追加到当前 Turn：\n\n> 继续开发",
    );
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
      },
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handle(message)).rejects.toBe(failure);
    await fixture.outbox.close();

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "操作失败：该 Codex Session 已绑定到其他会话。",
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
      },
      fixture.outbox,
      imagePort,
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
