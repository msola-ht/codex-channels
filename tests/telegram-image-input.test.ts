import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationService } from "../src/application/conversation-service.js";
import { UserFacingError, type OutputEvent } from "../src/conversation-core/index.js";
import { EventBus } from "../src/event-bus/event-bus.js";
import { TelegramAccessPolicy } from "../src/policy/telegram-access.js";
import { TelegramSurface, type TelegramImagePort } from "../src/surfaces/telegram/bot.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Telegram image input", () => {
  it("uses the largest photo and sends its caption with the local image", async () => {
    const submit = vi.fn().mockResolvedValue({ threadId: "thread-1", turnId: "turn-1", steered: false });
    const download = vi.fn().mockResolvedValue({
      path: "/private/uploads/photo.jpg",
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
        localImages: [{ path: "/private/uploads/photo.jpg" }],
      },
    );
    expect(rememberActor).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "123",
    );
    await surface.stop();
    await output.close();
  });

  it("uses a default instruction when a photo has no caption", async () => {
    const submit = vi.fn().mockResolvedValue({ threadId: "thread-1", turnId: "turn-1", steered: false });
    const download = vi.fn().mockResolvedValue({
      path: "/private/uploads/photo.jpg",
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

  it("rejects non-image documents before downloading them", async () => {
    const submit = vi.fn();
    const download = vi.fn();
    const { surface, output, apiCalls } = createSurface(submit, download);

    await surface.bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 12,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        document: {
          file_id: "document",
          file_unique_id: "document-u",
          file_name: "notes.txt",
          mime_type: "text/plain",
        },
      },
    });

    expect(download).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(apiCalls).toContain("sendMessage");
    await surface.stop();
    await output.close();
  });

  it("accepts PNG/JPEG documents by filename and validates contents in the image store", async () => {
    const submit = vi.fn().mockResolvedValue({ threadId: "thread-1", turnId: "turn-1", steered: false });
    const download = vi.fn().mockResolvedValue({
      path: "/private/uploads/diagram.png",
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
          file_name: "architecture.PNG",
        },
      },
    });

    expect(download).toHaveBeenCalledWith(surface.bot.api, "document");
    expect(submit.mock.calls[0]?.[1]).toEqual({
      text: "解释架构图",
      localImages: [{ path: "/private/uploads/diagram.png" }],
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

    expect(sentTexts).toContain("操作失败：会话名称必须为 1–64 个字符");
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
});

function createSurface(
  submit: ReturnType<typeof vi.fn>,
  download: ReturnType<typeof vi.fn>,
  serviceOverrides: Record<string, unknown> = {},
): {
  surface: TelegramSurface;
  output: EventBus<OutputEvent>;
  apiCalls: string[];
  sentTexts: string[];
  rememberActor: ReturnType<typeof vi.fn>;
} {
  const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
  const apiCalls: string[] = [];
  const sentTexts: string[] = [];
  const imageStore: TelegramImagePort = {
    start: async () => undefined,
    close: () => undefined,
    download: download as unknown as TelegramImagePort["download"],
  };
  const directory = mkdtempSync(join(tmpdir(), "codex-telegram-surface-"));
  const rememberActor = vi.fn();
  directories.push(directory);
  const surface = new TelegramSurface(
    "123:token",
    undefined,
    { submit, ...serviceOverrides } as unknown as ConversationService,
    new TelegramAccessPolicy(new Set([123]), "default"),
    new Set(),
    [{ id: "main", name: "Main", cwd: "/workspace" }],
    directory,
    pino({ level: "silent" }),
    { imageStore, actorRegistry: { rememberActor } },
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
  return { surface, output, apiCalls, sentTexts, rememberActor };
}

function telegramUser() {
  return { id: 123, is_bot: false, first_name: "User" };
}

function telegramChat() {
  return { id: 100, type: "private" as const, first_name: "User" };
}
