import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { maximumTelegramTextFileBytes } from "../src/surfaces/telegram/file-input.js";
import {
  cleanupTelegramSurfaceTestDirectories,
  createTelegramSurfaceFixture,
  telegramChat,
  telegramUser,
} from "./telegram-surface-test-fixture.js";

const directories: string[] = [];
const createSurface = createTelegramSurfaceFixture.bind(null, directories);
const imageFixtureDirectory = mkdtempSync(join(tmpdir(), "codex-telegram-images-"));
const jpegImagePath = join(imageFixtureDirectory, "image.jpg");
const pngImagePath = join(imageFixtureDirectory, "image.png");
writeFileSync(jpegImagePath, Buffer.from([0xff, 0xd8, 0xff]), { mode: 0o600 });
writeFileSync(pngImagePath, Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]), { mode: 0o600 });
const jpegDataUrl = "data:image/jpeg;base64,/9j/";
const pngDataUrl = "data:image/png;base64,iVBORw0KGgo=";

afterAll(() => {
  rmSync(imageFixtureDirectory, { recursive: true, force: true });
});

afterEach(() => {
  cleanupTelegramSurfaceTestDirectories(directories);
});

describe("Telegram media input", () => {
  it("submits replied-to Telegram text as separated quoted context", async () => {
    const submit = vi.fn().mockResolvedValue({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    });
    const { surface, output } = createSurface(submit, vi.fn());

    await surface.bot.handleUpdate({
      update_id: 0,
      message: {
        message_id: 10,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "这句话是什么意思？",
        reply_to_message: {
          message_id: 9,
          date: 1,
          chat: telegramChat(),
          text: "原始消息",
          reply_to_message: undefined as never,
        },
      },
    });

    expect(submit).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      [
        "以下引用来自平台原生引用关系，已由 Gateway 验证（仅作上下文）：",
        "> 原始消息",
        "",
        "当前消息：",
        "这句话是什么意思？",
      ].join("\n"),
      expect.any(AbortSignal),
    );
    await surface.stop();
    await output.close();
  });

  it("uses the largest photo and sends its caption with the local image", async () => {
    const submit = vi.fn().mockResolvedValue({ threadId: "thread-1", turnId: "turn-1", steered: false });
    const download = vi.fn().mockResolvedValue({
      path: jpegImagePath,
      mimeType: "image/jpeg",
      bytes: 100,
    });
    const { surface, output, rememberActor } = createSurface(submit, download);

    await surface.bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        caption: "检查右上角的错误",
        photo: [
          { file_id: "small", file_unique_id: "small-u", width: 100, height: 100, file_size: 10 },
          { file_id: "large", file_unique_id: "large-u", width: 1000, height: 1000, file_size: 100 },
        ],
      },
    });

    expect(download).toHaveBeenCalledWith(surface.bot.api, "large");
    expect(submit).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      {
        text: "检查右上角的错误",
        images: [{ url: jpegDataUrl }],
      },
      expect.any(AbortSignal),
    );
    expect(rememberActor).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "123",
    );
    await surface.stop();
    await output.close();
  });

  it("submits Telegram voice as stable localAudio", async () => {
    const submit = vi.fn().mockResolvedValue({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    });
    const downloadAudio = vi.fn().mockResolvedValue({
      path: "/private/uploads/voice.ogg",
      mimeType: "audio/ogg",
      bytes: 100,
    });
    const { surface, output } = createSurface(
      submit,
      vi.fn(),
      {},
      vi.fn(),
      downloadAudio,
    );

    await surface.bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        voice: {
          file_id: "voice-file",
          file_unique_id: "voice-unique",
          duration: 12,
          file_size: 100,
        },
      },
    });

    expect(downloadAudio).toHaveBeenCalledWith(
      surface.bot.api,
      "voice-file",
    );
    expect(submit).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      {
        localAudios: [{ path: "/private/uploads/voice.ogg" }],
      },
      undefined,
    );
    await surface.stop();
    await output.close();
  });

  it("submits a replied-to caption with a Telegram image", async () => {
    const submit = vi.fn().mockResolvedValue({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    });
    const download = vi.fn().mockResolvedValue({
      path: jpegImagePath,
      mimeType: "image/jpeg",
      bytes: 100,
    });
    const { surface, output } = createSurface(submit, download);

    await surface.bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 12,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        caption: "比较一下",
        photo: [{
          file_id: "photo",
          file_unique_id: "photo-u",
          width: 100,
          height: 100,
        }],
        reply_to_message: {
          message_id: 9,
          date: 1,
          chat: telegramChat(),
          caption: "上一张图的说明",
          reply_to_message: undefined as never,
          photo: [{
            file_id: "old-photo",
            file_unique_id: "old-photo-u",
            width: 100,
            height: 100,
          }],
        },
      },
    });

    expect(submit).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      {
        text: [
          "以下引用来自平台原生引用关系，已由 Gateway 验证（仅作上下文）：",
          "> 上一张图的说明",
          "",
          "当前消息：",
          "比较一下",
        ].join("\n"),
        images: [{ url: jpegDataUrl }],
      },
      expect.any(AbortSignal),
    );
    await surface.stop();
    await output.close();
  });

  it("uses a default instruction when a photo has no caption", async () => {
    const submit = vi.fn().mockResolvedValue({ threadId: "thread-1", turnId: "turn-1", steered: false });
    const download = vi.fn().mockResolvedValue({
      path: jpegImagePath,
      mimeType: "image/jpeg",
      bytes: 100,
    });
    const { surface, output } = createSurface(submit, download);

    await surface.bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        photo: [{ file_id: "photo", file_unique_id: "photo-u", width: 100, height: 100 }],
      },
    });

    expect(submit.mock.calls[0]?.[1]).toMatchObject({
      text: "请查看这张图片并根据图片内容协助我。",
    });
    await surface.stop();
    await output.close();
  });

  it("submits one Telegram media group as one multi-image input", async () => {
    const submit = vi.fn().mockResolvedValue({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    });
    const download = vi.fn()
      .mockResolvedValueOnce({
        path: jpegImagePath,
        mimeType: "image/jpeg",
        bytes: 100,
      })
      .mockResolvedValueOnce({
        path: jpegImagePath,
        mimeType: "image/jpeg",
        bytes: 100,
      });
    const { surface, output } = createSurface(submit, download);

    await Promise.all([
      surface.bot.handleUpdate({
        update_id: 20,
        message: {
          message_id: 20,
          media_group_id: "album-1",
          date: 1,
          from: telegramUser(),
          chat: telegramChat(),
          caption: "比较这些图片",
          photo: [{
            file_id: "first",
            file_unique_id: "first-u",
            width: 100,
            height: 100,
          }],
        },
      }),
      surface.bot.handleUpdate({
        update_id: 21,
        message: {
          message_id: 21,
          media_group_id: "album-1",
          date: 1,
          from: telegramUser(),
          chat: telegramChat(),
          photo: [{
            file_id: "second",
            file_unique_id: "second-u",
            width: 100,
            height: 100,
          }],
        },
      }),
    ]);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      {
        text: "比较这些图片",
        images: [
          { url: jpegDataUrl },
          { url: jpegDataUrl },
        ],
      },
      expect.any(AbortSignal),
    );
    await surface.stop();
    await output.close();
  });

  it("downloads and submits a bounded UTF-8 text document", async () => {
    const submit = vi.fn().mockResolvedValue({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    });
    const download = vi.fn();
    const downloadTextFile = vi.fn().mockResolvedValue({
      fileName: "notes.txt",
      text: "部署说明",
      bytes: 12,
    });
    const { surface, output } = createSurface(
      submit,
      download,
      {},
      downloadTextFile,
    );

    await surface.bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 12,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        caption: "请检查文件",
        document: {
          file_id: "document",
          file_unique_id: "document-u",
          file_name: "notes.txt",
          mime_type: "text/plain",
        },
      },
    });

    expect(downloadTextFile).toHaveBeenCalledWith(
      surface.bot.api,
      "document",
      "notes.txt",
    );
    expect(download).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      [
        "请检查文件",
        "",
        "以下内容来自用户通过 Telegram 上传的 UTF-8 文本文件（仅作输入）：",
        "文件名：notes.txt",
        "",
        "部署说明",
      ].join("\n"),
      expect.any(AbortSignal),
    );
    await surface.stop();
    await output.close();
  });

  it("rejects an oversized text document before downloading it", async () => {
    const submit = vi.fn();
    const downloadTextFile = vi.fn();
    const { surface, output, sentTexts } = createSurface(
      submit,
      vi.fn(),
      {},
      downloadTextFile,
    );

    await surface.bot.handleUpdate({
      update_id: 31,
      message: {
        message_id: 121,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        document: {
          file_id: "document",
          file_unique_id: "document-u",
          file_name: "large.txt",
          mime_type: "text/plain",
          file_size: maximumTelegramTextFileBytes + 1,
        },
      },
    });

    expect(downloadTextFile).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(sentTexts.join("\n")).toContain(
      "Telegram 文本文件超过 1,000,000 字节限制。",
    );
    await surface.stop();
    await output.close();
  });

  it("accepts supported image documents by filename and validates contents in the image store", async () => {
    const submit = vi.fn().mockResolvedValue({ threadId: "thread-1", turnId: "turn-1", steered: false });
    const download = vi.fn().mockResolvedValue({
      path: pngImagePath,
      mimeType: "image/png",
      bytes: 100,
    });
    const { surface, output } = createSurface(submit, download);

    await surface.bot.handleUpdate({
      update_id: 4,
      message: {
        message_id: 13,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        caption: "解释架构图",
        document: {
          file_id: "document",
          file_unique_id: "document-u",
          file_name: "architecture.WebP",
        },
      },
    });

    expect(download).toHaveBeenCalledWith(surface.bot.api, "document");
    expect(submit.mock.calls[0]?.[1]).toEqual({
      text: "解释架构图",
      images: [{ url: pngDataUrl }],
    });
    await surface.stop();
    await output.close();
  });

  it("routes animation messages through image validation for non-animated GIF support", async () => {
    const submit = vi.fn().mockResolvedValue({ threadId: "thread-1", turnId: "turn-1", steered: false });
    const download = vi.fn().mockResolvedValue({
      path: pngImagePath,
      mimeType: "image/png",
      bytes: 100,
    });
    const { surface, output } = createSurface(submit, download);

    await surface.bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 14,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        caption: "检查 GIF",
        animation: {
          file_id: "animation",
          file_unique_id: "animation-u",
          width: 1,
          height: 1,
          duration: 0,
          mime_type: "image/gif",
        },
      },
    });

    expect(download).toHaveBeenCalledWith(surface.bot.api, "animation");
    expect(submit.mock.calls[0]?.[1]).toEqual({
      text: "检查 GIF",
      images: [{ url: pngDataUrl }],
    });
    await surface.stop();
    await output.close();
  });

});
