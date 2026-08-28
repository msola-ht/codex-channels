import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationUseCases } from "../src/application/conversation-service.js";
import type {
  ScheduledTaskConfirmation,
  ScheduledTaskUseCases,
} from "../src/application/scheduled-task-service.js";
import { UserFacingError, type OutputEvent } from "../src/conversation-core/index.js";
import { EventBus } from "../src/event-bus/event-bus.js";
import { TelegramAccessPolicy } from "../src/policy/telegram-access.js";
import { ThreadSectionAccessPolicy } from "../src/policy/thread-section-access.js";
import {
  TelegramSurface,
  type TelegramAudioPort,
  type TelegramImagePort,
} from "../src/surfaces/telegram/bot.js";
import { telegramModelSelectionToken } from "../src/surfaces/telegram/command-renderer.js";
import {
  maximumTelegramTextFileBytes,
  type TelegramTextFilePort,
} from "../src/surfaces/telegram/file-input.js";

const directories: string[] = [];
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
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Telegram image input", () => {
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

  it("maps Telegram commands through the shared application command service", async () => {
    const submit = vi.fn();
    const download = vi.fn();
    const newSession = vi.fn().mockResolvedValue(undefined);
    const { surface, output, apiCalls } = createSurface(submit, download, { newSession });

    await surface.bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 14,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "/new",
        entities: [{ offset: 0, length: 4, type: "bot_command" }],
      },
    });

    expect(newSession).toHaveBeenCalledWith({
      surface: "telegram",
      accountId: "default",
      conversationId: "100",
    });
    expect(apiCalls).toContain("sendMessage");
    await surface.stop();
    await output.close();
  });

  it("uses the shared Skill list and explicit invocation commands", async () => {
    const listSkills = vi.fn(async () => [{
      name: "systematic-debugging",
      description: "系统化排查",
    }]);
    const invokeSkill = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
      skillName: "systematic-debugging",
    }));
    const { surface, output, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      { listSkills, invokeSkill },
    );

    await surface.bot.handleUpdate({
      update_id: 60,
      message: {
        message_id: 60,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "/skill",
        entities: [{ offset: 0, length: 6, type: "bot_command" }],
      },
    });
    await surface.bot.handleUpdate({
      update_id: 61,
      message: {
        message_id: 61,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "/skill systematic-debugging 排查微信断线",
        entities: [{ offset: 0, length: 6, type: "bot_command" }],
      },
    });

    expect(sentTexts.some((text) =>
      text.includes("1. systematic-debugging")
    )).toBe(true);
    expect(invokeSkill).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "systematic-debugging",
      "排查微信断线",
    );
    await surface.stop();
    await output.close();
  });

  it("accepts the documented shared command shortcuts", async () => {
    const selectWorkspace = vi.fn().mockResolvedValue({
      id: "main",
      name: "Main",
      cwd: "/workspace",
    });
    const resume = vi.fn().mockResolvedValue("thread-1");
    const { surface, output, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      {
        listWorkspaces: () => [{
          id: "main",
          name: "Main",
          cwd: "/workspace",
        }],
        status: () => ({ model: "gpt-test", modelProvider: "openai" }),
        selectWorkspace,
        resume,
      },
    );

    for (const [index, text] of ["/h", "/work main", "/r thread-1"].entries()) {
      await surface.bot.handleUpdate({
        update_id: 50 + index,
        message: {
          message_id: 50 + index,
          date: 1,
          from: telegramUser(),
          chat: telegramChat(),
          text,
          entities: [{ offset: 0, length: text.split(" ")[0]!.length, type: "bot_command" }],
        },
      });
    }

    expect(sentTexts.join("\n")).toContain("快捷命令：");
    expect(selectWorkspace).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "main",
    );
    expect(resume).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "thread-1",
    );
    await surface.stop();
    await output.close();
  });

  it("does not let lookalike or other-bot whoami commands bypass authorization", async () => {
    const submit = vi.fn().mockResolvedValue({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    });
    const { surface, output } = createSurface(submit, vi.fn());
    const unauthorized = { ...telegramUser(), id: 456 };

    await surface.bot.handleUpdate({
      update_id: 6,
      message: {
        message_id: 15,
        date: 1,
        from: unauthorized,
        chat: telegramChat(),
        text: "/whoamix",
        entities: [{ offset: 0, length: 8, type: "bot_command" }],
      },
    });
    await surface.bot.handleUpdate({
      update_id: 7,
      message: {
        message_id: 16,
        date: 1,
        from: unauthorized,
        chat: telegramChat(),
        text: "/whoami@other_bot",
        entities: [{ offset: 0, length: 17, type: "bot_command" }],
      },
    });

    expect(submit).not.toHaveBeenCalled();
    await surface.stop();
    await output.close();
  });

  it("hides unexpected service errors from Telegram replies", async () => {
    const submit = vi.fn().mockRejectedValue(
      new Error("upstream failed with TOKEN=top-secret"),
    );
    const { surface, output, sentTexts } = createSurface(submit, vi.fn());

    await surface.bot.handleUpdate({
      update_id: 8,
      message: {
        message_id: 17,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "执行任务",
      },
    });

    expect(sentTexts).toContain("操作失败：Gateway 未能完成请求，请稍后重试。");
    expect(sentTexts.join("\n")).not.toContain("top-secret");
    await surface.stop();
    await output.close();
  });

  it("keeps explicitly user-facing validation errors actionable", async () => {
    const rename = vi.fn().mockRejectedValue(
      new UserFacingError(
        "conversation.name.invalid",
        "this fallback must not be rendered",
      ),
    );
    const { surface, output, sentTexts } = createSurface(vi.fn(), vi.fn(), { rename });

    await surface.bot.handleUpdate({
      update_id: 9,
      message: {
        message_id: 18,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "/rename",
        entities: [{ offset: 0, length: 7, type: "bot_command" }],
      },
    });

    expect(sentTexts).toContain("操作失败：会话名称必须为 1–64 个字符。");
    await surface.stop();
    await output.close();
  });

  it("notifies configured recipients about configuration lifecycle changes", async () => {
    const { surface, output, sentTexts } = createSurface(vi.fn(), vi.fn());
    surface.replaceNotificationRecipients(new Set([123]));

    await surface.deliverConfigurationChange({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{
        id: "codex-channels",
        name: "codex-channels",
        cwd: "/Users/msola/Documents/GitHub/codex-channels",
      }],
    });
    surface.configurationChanged({
      action: "restarting",
      changes: [{ code: "surface.telegram.token", scope: "telegram" }],
      addedWorkspaces: [],
    });

    await surface.stop();
    expect(sentTexts.join("\n")).toContain("Workspace 已添加");
    expect(sentTexts.join("\n")).toContain("codex-channels");
    expect(sentTexts.join("\n")).toContain("Gateway 配置需要重启");
    expect(sentTexts.join("\n")).toContain("Telegram Bot Token");
    await output.close();
  });

  it("switches Workspace from a notification button through the shared command service", async () => {
    const selectWorkspace = vi.fn().mockResolvedValue({
      id: "docs",
      name: "Docs",
      cwd: "/workspace/docs",
    });
    const { surface, output, apiCalls, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      {
        listWorkspaces: () => [{
          id: "docs",
          name: "Docs",
          cwd: "/workspace/docs",
        }],
        status: () => ({ model: "gpt-test", modelProvider: "openai" }),
        selectWorkspace,
      },
    );

    await surface.bot.handleUpdate({
      update_id: 10,
      callback_query: {
        id: "workspace-switch",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `ws:${createHash("sha256").update("docs").digest("base64url")}`,
        message: {
          message_id: 20,
          date: 1,
          chat: telegramChat(),
          text: "Workspace 已添加",
        },
      },
    });

    expect(selectWorkspace).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "docs",
    );
    expect(apiCalls).toContain("answerCallbackQuery");
    expect(sentTexts.join("\n")).toContain("已切换 Workspace");
    await surface.stop();
    await output.close();
  });

  it("applies a reasoning effort selected from the post-model buttons", async () => {
    const state = {
      models: [{
        id: "gpt-test",
        model: "gpt-test",
        displayName: "GPT Test",
        supportedReasoningEfforts: [
          { effort: "medium", description: "Medium" },
          { effort: "high", description: "High" },
        ],
        defaultReasoningEffort: "medium",
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
        inputModalities: ["text" as const],
      }],
      model: "gpt-test",
      modelProvider: "openai",
      effort: "medium",
      serviceTier: null,
      pending: true,
      modelPending: true,
      effortPending: true,
      serviceTierPending: false,
    };
    const selectEffort = vi.fn().mockResolvedValue({ ...state, effort: "high" });
    const { surface, output, apiCalls, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      {
        modelState: vi.fn().mockResolvedValue(state),
        selectEffort,
      },
    );

    await surface.bot.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "model-effort",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `me:2:${telegramModelSelectionToken("gpt-test", "openai")}`,
        message: {
          message_id: 20,
          date: 1,
          chat: telegramChat(),
          text: "选择思考等级",
        },
      },
    });

    expect(selectEffort).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "high",
    );
    expect(apiCalls).toContain("editMessageReplyMarkup");
    expect(sentTexts.join("\n")).toContain("high（下一次 Turn 生效）");
    await surface.stop();
    await output.close();
  });

  it("collects a selected Plugin task through one exact ForceReply message", async () => {
    const invokePlugin = vi.fn().mockResolvedValue({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
      pluginName: "GitHub",
    });
    const { surface, output, apiCalls, apiPayloads } = createSurface(
      vi.fn(),
      vi.fn(),
      {
        listPlugins: vi.fn().mockResolvedValue({
          plugins: [
            telegramPlugin("slack@local", "slack", "Slack"),
            telegramPlugin("github@local", "github", "GitHub"),
          ],
          loadErrorCount: 0,
        }),
        invokePlugin,
      },
    );

    await surface.bot.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "plugin-select",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: "plugin:select:KJV9Ut1pei2MHRjX-Hp6Eak7zSnaNGeVAK2Bhk0mAMA",
        message: {
          message_id: 20,
          date: 1,
          chat: telegramChat(),
          text: "Plugin 列表",
        },
      },
    });
    await surface.bot.handleUpdate({
      update_id: 12,
      message: {
        message_id: 21,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "检查当前 PR",
        reply_to_message: {
          message_id: 99,
          date: 1,
          chat: telegramChat(),
          text: "已选择 GitHub",
          reply_to_message: undefined as never,
        },
      },
    });

    expect(apiPayloads).toContainEqual(expect.objectContaining({
      method: "sendMessage",
      payload: expect.objectContaining({
        reply_markup: { force_reply: true, selective: true },
      }),
    }));
    expect(apiCalls.indexOf("answerCallbackQuery")).toBeLessThan(
      apiCalls.indexOf("sendMessage"),
    );
    expect(invokePlugin).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "github@local",
      "检查当前 PR",
    );
    await surface.stop();
    await output.close();
  });

  it("pages the current Plugin catalog through a Telegram callback", async () => {
    const plugins = Array.from({ length: 10 }, (_, index) =>
      telegramPlugin(
        `plugin-${index + 1}@local`,
        `plugin-${index + 1}`,
        `Plugin ${index + 1}`,
      ));
    const { surface, output, apiCalls, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      {
        listPlugins: vi.fn().mockResolvedValue({
          plugins,
          loadErrorCount: 0,
        }),
      },
    );

    await surface.bot.handleUpdate({
      update_id: 14,
      callback_query: {
        id: "plugin-page",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: "plugin:page:2",
        message: {
          message_id: 23,
          date: 1,
          chat: telegramChat(),
          text: "Plugin 列表",
        },
      },
    });

    expect(apiCalls).toContain("answerCallbackQuery");
    expect(sentTexts.join("\n")).toContain("Plugin 9");
    expect(sentTexts.join("\n")).toContain("Plugin 10");
    await surface.stop();
    await output.close();
  });

  it("re-resolves a Thread Section callback before moving the current Thread", async () => {
    const section = {
      id: "section-project",
      name: "项目",
      builtIn: null,
      currentWorkspaceActiveCount: 1,
      currentWorkspaceArchivedCount: 0,
    };
    const listThreadSections = vi.fn().mockResolvedValue([section]);
    const moveCurrentThreadToSection = vi.fn().mockResolvedValue(section);
    const { surface, output, apiCalls, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      { listThreadSections, moveCurrentThreadToSection },
    );

    await surface.bot.handleUpdate({
      update_id: 15,
      callback_query: {
        id: "section-move",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `section:move:${createHash("sha256").update(section.id).digest("base64url")}`,
        message: {
          message_id: 24,
          date: 1,
          chat: telegramChat(),
          text: "会话分区",
        },
      },
    });

    expect(listThreadSections).toHaveBeenCalled();
    expect(moveCurrentThreadToSection).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      section.id,
      undefined,
    );
    expect(apiCalls).toContain("answerCallbackQuery");
    expect(sentTexts.join("\n")).toContain("已移动当前会话到会话分区");
    await surface.stop();
    await output.close();
  });

  it("routes the built-in Pinned Thread Section button through /pin", async () => {
    const setPinned = vi.fn().mockResolvedValue(true);
    const { surface, output, apiCalls, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      { setPinned },
    );

    await surface.bot.handleUpdate({
      update_id: 16,
      callback_query: {
        id: "section-pin",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: "section:pin",
        message: {
          message_id: 25,
          date: 1,
          chat: telegramChat(),
          text: "会话分区",
        },
      },
    });

    expect(setPinned).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      true,
    );
    expect(apiCalls).toContain("answerCallbackQuery");
    expect(sentTexts.join("\n")).toContain("已固定当前会话");
    await surface.stop();
    await output.close();
  });

  it("opens a Queue item and requires delete confirmation before deletion", async () => {
    const item = {
      id: "01a02373-1bd5-7661-aa48-fc0ff087f0d8",
      clientUserMessageId: "client-queue-1",
      inputType: "text" as const,
      textPreview: "继续检查 Queue 按钮",
      editable: true,
    };
    const queueList = vi.fn(async () => ({
      items: [item],
      selectors: ["1"],
      page: 1,
      pageCount: 1,
      totalItemCount: 1,
    }));
    const queueDelete = vi.fn(async () => ({ deleted: true }));
    const { surface, output, apiCalls, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      { queueList, queueDelete },
    );

    await surface.bot.handleUpdate({
      update_id: 17,
      callback_query: {
        id: "queue-item",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `queue:item:1:${item.id}`,
        message: {
          message_id: 26,
          date: 1,
          chat: telegramChat(),
          text: "App Server Queue",
        },
      },
    });
    expect(queueList).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      1,
    );
    expect(sentTexts.join("\n")).toContain("请选择操作");
    expect(apiCalls).toContain("answerCallbackQuery");

    await surface.bot.handleUpdate({
      update_id: 18,
      callback_query: {
        id: "queue-delete-confirm",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `queue:delete-confirm:1:${item.id}`,
        message: {
          message_id: 27,
          date: 1,
          chat: telegramChat(),
          text: "Queue 条目",
        },
      },
    });
    expect(sentTexts.join("\n")).toContain("确认删除 Queue 条目");
    expect(queueDelete).not.toHaveBeenCalled();

    await surface.bot.handleUpdate({
      update_id: 19,
      callback_query: {
        id: "queue-delete",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `queue:delete:1:${item.id}`,
        message: {
          message_id: 28,
          date: 1,
          chat: telegramChat(),
          text: "确认删除 Queue 条目？",
        },
      },
    });
    expect(queueDelete).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      item.id,
    );
    expect(sentTexts.join("\n")).toContain("已删除 App Server Queue 条目");
    await surface.stop();
    await output.close();
  });

  it("confirms a scheduled task from the native Telegram button", async () => {
    const token = "12345678-1234-1234-1234-123456789abc";
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
      reasoningEffort: "medium",
      serviceTier: null,
      sandbox: "workspace-write" as const,
      permissions: null,
      promptPreview: "检查项目",
    };
    const confirm = vi.fn(() => ({ action: "created" as const, task }));
    const { surface, output, apiCalls, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      {},
      vi.fn(),
      vi.fn(),
      undefined,
      false,
      { confirm } as unknown as ScheduledTaskUseCases,
    );

    await surface.bot.handleUpdate({
      update_id: 20,
      callback_query: {
        id: "schedule-confirm",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `schedule:confirm:${token}`,
        message: {
          message_id: 30,
          date: 1,
          chat: telegramChat(),
          text: "计划任务创建预览",
        },
      },
    });

    expect(confirm).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "123",
      token,
    );
    expect(apiCalls).toContain("answerCallbackQuery");
    expect(apiCalls).toContain("editMessageReplyMarkup");
    expect(sentTexts.join("\n")).toContain("已创建 Gateway 计划任务");
    await surface.stop();
    await output.close();
  });

  it("presents a schedule_task preview with native Telegram buttons", async () => {
    const { surface, output, apiPayloads } = createSurface(vi.fn(), vi.fn());
    const preview = scheduledTaskPreview();

    await surface.presentScheduledTaskConfirmation(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "123",
      preview,
    );

    const sent = apiPayloads.find(({ method }) => method === "sendMessage");
    expect(sent?.payload.reply_markup).toEqual({
      inline_keyboard: [[
        {
          text: "确认",
          callback_data: `schedule:confirm:${preview.token}`,
        },
        { text: "取消", callback_data: "schedule:cancel" },
      ]],
    });
    await surface.stop();
    await output.close();
  });

  it("fails closed when a Queue item button no longer resolves", async () => {
    const itemId = "01a02373-1bd5-7661-aa48-fc0ff087f0d8";
    const queueList = vi.fn(async () => ({
      items: [],
      selectors: [],
      page: 1,
      pageCount: 1,
      totalItemCount: 0,
    }));
    const { surface, output, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      { queueList },
    );

    await surface.bot.handleUpdate({
      update_id: 20,
      callback_query: {
        id: "queue-stale",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `queue:item:1:${itemId}`,
        message: {
          message_id: 29,
          date: 1,
          chat: telegramChat(),
          text: "App Server Queue",
        },
      },
    });

    expect(sentTexts.join("\n")).toContain("找不到指定 Queue 条目");
    await surface.stop();
    await output.close();
  });

  it("rejects replies to stale Plugin prompts after in-memory state is gone", async () => {
    const submit = vi.fn();
    const { surface, output, sentTexts } = createSurface(submit, vi.fn());

    await surface.bot.handleUpdate({
      update_id: 13,
      message: {
        message_id: 22,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "不要进入普通 Turn",
        reply_to_message: {
          message_id: 99,
          date: 1,
          from: {
            id: 999,
            is_bot: true,
            first_name: "Test Bot",
            username: "test_bot",
          },
          chat: telegramChat(),
          text: "已选择 GitHub。请回复此消息输入任务；提示 10 分钟内有效。",
          reply_to_message: undefined as never,
        },
      },
    });

    expect(submit).not.toHaveBeenCalled();
    expect(sentTexts).toContain("Plugin 任务提示已过期，请重新使用 /plugin 选择。");
    await surface.stop();
    await output.close();
  });
});

function scheduledTaskPreview(): ScheduledTaskConfirmation {
  return {
    action: "create",
    token: "12345678-1234-1234-1234-123456789abc",
    expiresAt: 2,
    task: {
      taskId: "task-preview",
      name: "检查 CI",
      status: "active",
      schedule: { type: "interval", intervalMinutes: 60, anchorAt: 1 },
      timezone: "Asia/Shanghai",
      nextRunAt: 2,
      workspaceId: "main",
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      sandbox: "workspace-write",
      permissions: null,
      promptPreview: "检查 CI",
    },
  };
}

function createSurface(
  submit: ReturnType<typeof vi.fn>,
  download: ReturnType<typeof vi.fn>,
  serviceOverrides: Record<string, unknown> = {},
  downloadTextFile: ReturnType<typeof vi.fn> = vi.fn(),
  downloadAudio: ReturnType<typeof vi.fn> = vi.fn(),
  now?: () => number,
  debugEnabled = false,
  scheduledTasks?: ScheduledTaskUseCases,
): {
  surface: TelegramSurface;
  output: EventBus<OutputEvent>;
  apiCalls: string[];
  sentTexts: string[];
  apiPayloads: Array<{ method: string; payload: Record<string, unknown> }>;
  rememberActor: ReturnType<typeof vi.fn>;
} {
  const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
  const apiCalls: string[] = [];
  const sentTexts: string[] = [];
  const apiPayloads: Array<{
    method: string;
    payload: Record<string, unknown>;
  }> = [];
  const imageStore: TelegramImagePort = {
    start: async () => undefined,
    close: () => undefined,
    download: download as unknown as TelegramImagePort["download"],
  };
  const audioStore: TelegramAudioPort = {
    start: async () => undefined,
    close: () => undefined,
    download: downloadAudio as unknown as TelegramAudioPort["download"],
  };
  const directory = mkdtempSync(join(tmpdir(), "codex-telegram-surface-"));
  const rememberActor = vi.fn();
  directories.push(directory);
  const surfaceOptions = {
    gatewayVersion: "0.146.0",
    inputQuietWindowMs: 0,
    imageStore,
    audioStore,
    textFileInput: {
      download: downloadTextFile as unknown as TelegramTextFilePort["download"],
    },
    actorRegistry: {
      actors: () => [],
      rememberActor,
    },
    threadSectionAccess: new ThreadSectionAccessPolicy(new Set(["telegram:123"])),
    ...(now === undefined ? {} : { now }),
    debugEnabled,
    ...(scheduledTasks === undefined ? {} : { scheduledTasks }),
  };
  const surface = new TelegramSurface(
    "123:token",
    undefined,
    { submit, ...serviceOverrides } as unknown as ConversationUseCases,
    new TelegramAccessPolicy(new Set([123]), "default"),
    new Set(),
    [{ id: "main", name: "Main", cwd: "/workspace" }],
    directory,
    pino({ level: "silent" }),
    surfaceOptions,
  );
  output.subscribe("telegram-test-output", (event) => {
    surface.output.handle(event);
  });
  surface.bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "Test Bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  surface.bot.api.config.use(async (_previous, method, payload) => {
    apiCalls.push(method);
    apiPayloads.push({
      method,
      payload: payload as Record<string, unknown>,
    });
    if (method === "sendMessage") {
      const text = (payload as { text?: unknown }).text;
      if (typeof text === "string") {
        sentTexts.push(text);
      }
      return {
        ok: true,
        result: {
          message_id: 99,
          date: 1,
          chat: telegramChat(),
          text: "ok",
        },
      } as never;
    }
    return { ok: true, result: true } as never;
  });
  return {
    surface,
    output,
    apiCalls,
    sentTexts,
    apiPayloads,
    rememberActor,
  };
}

function telegramUser() {
  return { id: 123, is_bot: false, first_name: "User" };
}

function telegramChat() {
  return { id: 100, type: "private" as const, first_name: "User" };
}

function telegramPlugin(id: string, name: string, displayName: string) {
  return {
    id,
    name,
    displayName,
    marketplaceName: "local",
    description: null,
    enabled: true,
    available: true,
    version: null,
    localVersion: null,
    source: "local" as const,
    installedAt: null,
    developerName: null,
    category: null,
    capabilities: [],
    authPolicy: "onUse" as const,
    eligiblePlanTypes: [],
    disabledReason: null,
  };
}
