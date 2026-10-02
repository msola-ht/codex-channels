import { GrammyError, HttpError, InputFile, Api, type Bot, type Context } from "grammy";
import type { InputRichMessage } from "grammy/types";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OutputEvent } from "../src/conversation-core/events.js";
import { TelegramOutbox } from "../src/surfaces/telegram/outbox.js";
import { TelegramInteractionPort } from "../src/surfaces/telegram/interactions.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
const turnStartedPanel = "<b>已开始处理。</b>";
const turnCompletedTitle = "<b>本次运行 · 已完成</b>";
const turnCompletedPanel = [
  turnCompletedTitle,
  "",
  "<b>当前会话</b>",
  "• <b>Session：</b>测试会话",
  "• <b>Session ID：</b>thread-1",
].join("\n");

class FakeTelegramApi {
  readonly actions: string[] = [];
  readonly sent: string[] = [];
  readonly sendOptions: unknown[] = [];
  readonly edits: string[] = [];
  readonly editOptions: unknown[] = [];
  readonly richMessages: InputRichMessage[] = [];
  readonly richEdits: InputRichMessage[] = [];
  readonly deleted: number[] = [];
  readonly documents: Array<{
    filename: string | undefined;
    options: unknown;
    content: string;
  }> = [];
  readonly photos: Array<{
    filename: string | undefined;
    options: unknown;
    content: Buffer;
  }> = [];
  rejectRichMessages = false;
  rejectHtmlMessages = false;
  rejectDocuments = false;
  private nextMessageId = 1;

  async sendChatAction(_chatId: string, action: string): Promise<true> {
    this.actions.push(action);
    return true;
  }

  async sendMessage(_chatId: string, text: string, options?: unknown): Promise<{ message_id: number }> {
    if (this.rejectHtmlMessages && hasHtmlParseMode(options)) {
      throw badRequest("Bad Request: can't parse entities");
    }
    this.sent.push(text);
    this.sendOptions.push(options);
    return { message_id: this.nextMessageId++ };
  }

  async sendRichMessage(
    _chatId: string,
    richMessage: InputRichMessage,
    options?: unknown,
  ): Promise<{ message_id: number }> {
    this.richMessages.push(richMessage);
    if (this.rejectRichMessages) {
      throw badRequest("Bad Request: can't parse rich message");
    }
    this.sent.push(richMessage.markdown ?? richMessage.html ?? "[rich blocks]");
    this.sendOptions.push(options);
    return { message_id: this.nextMessageId++ };
  }

  async editMessageText(
    _chatId: string,
    _messageId: number,
    text: string | InputRichMessage,
    options?: unknown,
  ): Promise<true> {
    if (typeof text === "string") {
      if (this.rejectHtmlMessages && hasHtmlParseMode(options)) {
        throw badRequest("Bad Request: can't parse entities");
      }
      this.edits.push(text);
    } else {
      this.richEdits.push(text);
      if (this.rejectRichMessages) {
        throw badRequest("Bad Request: can't parse rich message");
      }
      this.edits.push(text.markdown ?? text.html ?? "[rich blocks]");
    }
    this.editOptions.push(options);
    return true;
  }

  async deleteMessage(_chatId: string, messageId: number): Promise<true> {
    this.deleted.push(messageId);
    return true;
  }

  async sendDocument(
    _chatId: string,
    document: InputFile,
    options?: unknown,
  ): Promise<{ message_id: number }> {
    if (this.rejectDocuments) {
      throw badRequest("Bad Request: document upload failed");
    }
    const raw = await document.toRaw();
    if (!(raw instanceof Uint8Array)) {
      throw new Error("Fake Telegram API only accepts in-memory documents");
    }
    this.documents.push({
      filename: document.filename,
      options,
      content: Buffer.from(raw).toString("utf8"),
    });
    return { message_id: this.nextMessageId++ };
  }

  async sendPhoto(
    _chatId: string,
    photo: InputFile,
    options?: unknown,
  ): Promise<{ message_id: number }> {
    const raw = await photo.toRaw();
    if (!(raw instanceof Uint8Array)) {
      throw new Error("Fake Telegram API only accepts in-memory photos");
    }
    this.photos.push({
      filename: photo.filename,
      options,
      content: Buffer.from(raw),
    });
    return { message_id: this.nextMessageId++ };
  }

}

afterEach(() => {
  vi.useRealTimers();
});

describe("TelegramOutbox", () => {
  it.each(["full", "compact", "hidden"] as const)("delivers compaction start before completion without timer merging in %s mode", async (display) => {
    const api = new FakeTelegramApi();
    const outbox = new TelegramOutbox(api as unknown as Api, pino({ level: "silent" }), undefined, { operationUpdateDisplay: display });
    for (const status of ["running", "running", "completed", "completed", "running"] as const) {
      outbox.handle(operationUpdated("compact-1", status, "contextCompaction"));
    }
    await outbox.close();
    expect(api.sent).toEqual(["开始压缩上下文…", "上下文压缩已完成。"]);
    expect(api.edits).toEqual([]);
  });

  it("skips empty leading HTML chunks while retaining the first actual message identity", async () => {
    const api = new FakeTelegramApi();
    const logger = pino({ level: "silent" });
    const info = vi.spyOn(logger, "info");
    const outbox = new TelegramOutbox(api as unknown as Api, logger);
    outbox.handle(textCompleted("final", "\n".repeat(3000) + "正文".repeat(3000)));
    await drain();
    await outbox.close();
    expect(api.sent.every((text) => text.trim().length > 0)).toBe(true);
    expect(api.sent.join("").trim()).toBe("正文".repeat(3000));
    expect(info.mock.calls.find((call) => call[1] === "Telegram 完成正文投递完成")?.[0])
      .toMatchObject({ itemId: "final", messageId: 1 });
  });

  it("does not implicitly resend an uncertain first stream message on later deltas or completion", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const send = vi.spyOn(api, "sendMessage").mockRejectedValueOnce(new HttpError("lost", new Error("response lost")));
    outbox.handle(textDelta("final", "开头"));
    await vi.advanceTimersByTimeAsync(1000);
    outbox.handle(textDelta("final", "后续"));
    await vi.advanceTimersByTimeAsync(1000);
    outbox.handle(textCompleted("final", "## 最终正文"));
    outbox.handle(turnCompleted());
    await vi.waitFor(() => expect(api.sent.at(-1)).toBe(turnCompletedPanel));
    await outbox.close();
    expect(send).toHaveBeenCalledTimes(2); // 首次尝试和独立的 Turn 完成卡。
    expect(api.sent).toEqual([turnCompletedPanel]);
  });

  it.each(["short", "long", "rich"] as const)("replaces an explicitly deleted streaming message for %s final output", async (kind) => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api, kind === "rich" ? "rich" : "html");
    outbox.handle(textDelta("final", "预览"));
    await vi.advanceTimersByTimeAsync(1000);
    vi.spyOn(api, "editMessageText").mockRejectedValueOnce(badRequest("Bad Request: message to edit not found"));
    outbox.handle(textCompleted("final", "## 标题\n" + (kind === "long" ? "内容\n".repeat(1800) : "最终正文")));
    outbox.handle(turnCompleted());
    await vi.waitFor(() => expect(api.sent.at(-1)).toBe(turnCompletedPanel));
    await outbox.close();
    expect(api.sent[1]).toContain(kind === "rich" ? "## 标题" : "<b>标题</b>");
  });

  it("does not report an operation flush as successful final body delivery", async () => {
    const api = new FakeTelegramApi();
    const logger = pino({ level: "silent" });
    const info = vi.spyOn(logger, "info");
    const outbox = new TelegramOutbox(api as unknown as Api, logger);
    const send = api.sendMessage.bind(api);
    vi.spyOn(api, "sendMessage").mockImplementation((chat, text, options) => {
      if (!text.includes("操作过程")) throw new HttpError("failed", new Error("timeout"));
      return send(chat, text, options);
    });
    outbox.handle(operationUpdated("op", "running", "command", "echo test"));
    outbox.handle(textCompleted("final", "## 最终正文"));
    await drain();
    await outbox.close();
    expect(api.sent).toHaveLength(1);
    expect(info.mock.calls.some((call) => call[1] === "Telegram 完成正文投递完成")).toBe(false);
    expect(info.mock.calls.some((call) => call[1] === "Surface 终态输出投递完成")).toBe(false);
    expect(info.mock.calls.find((call) => call[1] === "Surface 输出任务处理完成")?.[0])
      .toMatchObject({ purpose: "operation-log", itemId: "final" });
  });

  it("retains a completion arriving inside the running debounce window under pressure", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    let release!: () => void;
    const blocked = outbox.runOrdered("100", () => new Promise<void>((resolve) => { release = resolve; }));
    await settle();
    outbox.handle(operationUpdated("fast", "running", "command", "echo fast"));
    outbox.handle(operationUpdated("fast", "completed", "command", "echo fast"));
    await vi.advanceTimersByTimeAsync(800);
    for (let index = 0; index < 201; index++) {
      outbox.handle({ type: "warning", target, threadId: "thread-1", message: "排队通知" });
    }
    release();
    await blocked;
    await outbox.close();
    expect(api.sent.filter((text) => text.includes("操作过程"))).toHaveLength(1);
    expect(api.sent[0]).toContain("已完成");
  });

  it("falls back only the rejected HTML chunk without duplicating accepted chunks", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const send = api.sendMessage.bind(api);
    let attempts = 0;
    vi.spyOn(api, "sendMessage").mockImplementation((chat, text, options) => {
      if (++attempts === 3) throw badRequest("Bad Request: can't parse entities");
      return send(chat, text, options);
    });
    const text = Array.from({ length: 180 }, (_, index) => `段落${index}：` + "内容".repeat(25)).join("\n");
    outbox.handle(textCompleted("final", text));
    await drain();
    await outbox.close();
    expect(api.sent.join("")).toBe(text);
    expect(api.sendOptions[2]).not.toHaveProperty("parse_mode");
    expect(api.sendOptions[0]).toHaveProperty("parse_mode", "HTML");
    expect(api.edits).toHaveLength(0);
  });

  it.each([false, true])("does not replay partial long output after ambiguous failure (streamed=%s)", async (streamed) => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const logger = pino({ level: "silent" });
    const info = vi.spyOn(logger, "info");
    const outbox = new TelegramOutbox(api as unknown as Api, logger);
    if (streamed) {
      outbox.handle(textDelta("final", "预览"));
      await vi.advanceTimersByTimeAsync(1000);
    }
    const send = api.sendMessage.bind(api);
    let attempts = 0;
    vi.spyOn(api, "sendMessage").mockImplementation((chat, text, options) => {
      if (!text.includes("本次运行") && ++attempts === 2) {
        throw new HttpError("failed", new Error("response lost"));
      }
      return send(chat, text, options);
    });
    outbox.handle(textCompleted("final", "## 长文\n" + "正文内容\n".repeat(1800)));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();
    expect(attempts).toBe(2);
    expect(api.sent.at(-1)).toBe(turnCompletedPanel);
    expect(info.mock.calls.some((call) => call[1] === "Telegram 完成正文投递完成")).toBe(false);
  });

  it("does not downgrade or resend an ambiguously accepted document", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const sendDocument = vi.spyOn(api, "sendDocument").mockRejectedValue(new HttpError("failed", new Error("response lost")));
    outbox.handle(textCompleted("final", "文".repeat(17000)));
    outbox.handle(turnCompleted());
    await drain();
    await outbox.close();
    expect(sendDocument).toHaveBeenCalledOnce();
    expect(api.sent).toHaveLength(2);
    expect(api.edits).toHaveLength(0);
  });

  it.each(["html", "rich"] as const)("does not downgrade an ambiguously accepted short %s reply", async (format) => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api, format);
    const send = vi.spyOn(api, format === "html" ? "sendMessage" : "sendRichMessage")
      .mockRejectedValue(new HttpError("failed", new Error("response lost")));
    outbox.handle(textCompleted("final", "## 最终正文"));
    await drain();
    await outbox.close();
    expect(send).toHaveBeenCalledOnce();
    expect(api.sent).toHaveLength(0);
  });

  it("delivers and formats a reply completed before the first streaming interval", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    outbox.handle(textDelta("fast", "## 标题"));
    outbox.handle(textCompleted("fast", "## 标题\n\n最终回复"));
    outbox.handle(turnCompleted());
    try {
      await settle();
      await vi.waitFor(() => expect(api.sent).toContain(turnCompletedPanel));
      expect(api.sent[0]).toContain("<b>标题</b>");
      expect(api.sendOptions[0]).toMatchObject({ parse_mode: "HTML" });
      expect(api.edits).toEqual([]);
      expect(api.sent).toHaveLength(2);
    } finally {
      await outbox.close();
    }
  });

  it.each(["html", "rich"] as const)("keeps ordinary matching headings replyable through %s output and edits", async (format) => {
    for (const streamed of [false, true]) {
      vi.useFakeTimers();
      const api = new FakeTelegramApi();
      const outbox = createOutbox(api, format);
      const markdown = "## Codex 交互回复\n\n这里解释交互回复的工作方式。";
      if (streamed) {
        outbox.handle(textDelta("final", "正在说明", "final_answer"));
        await vi.advanceTimersByTimeAsync(1_000);
        await settle();
      }
      outbox.handle(textCompleted("final", markdown, "final_answer"));
      await outbox.close();
      const html = streamed ? api.edits.at(-1)! : api.sent.at(-1)!;
      expect(html).toBe("Codex 交互回复\n\n这里解释交互回复的工作方式。");
      expect(api.richMessages).toHaveLength(0);
      expect(api.richEdits).toHaveLength(0);
      const bot = { callbackQuery: vi.fn(), api } as unknown as Bot;
      const interactions = new TelegramInteractionPort(bot, pino({ level: "silent" }));
      expect(await interactions.handleText({ me: { id: 7 }, chat: { id: 100 }, message: {
        text: "请继续解释", reply_to_message: { message_id: 1, from: { id: 7, is_bot: true }, text: html, entities: [] },
      } } as unknown as Context)).toBe(false);
      await interactions.close();
      vi.useRealTimers();
    }
  });

  it.each(["html", "rich"] as const)("passes native cancellation through the SDK for typing and %s edits", async (format) => {
    vi.useFakeTimers();
    const api = new Api("123:token");
    const calls: Array<{ method: string; signal: unknown; payload: unknown }> = [];
    api.config.use(async (_previous, method, payload, signal) => {
      calls.push({ method, payload, signal });
      return { ok: true, result: { message_id: 1 } } as never;
    });
    const outbox = new TelegramOutbox(api, pino({ level: "silent" }), undefined, {
      finalMessageFormat: format,
    });
    try {
      outbox.handle(turnStarted());
      await vi.advanceTimersByTimeAsync(400);
      outbox.handle(textDelta("final", "# 标题", "final_answer"));
      await vi.advanceTimersByTimeAsync(1_000);
      outbox.handle(textDelta("final", "\n内容", "final_answer"));
      await vi.advanceTimersByTimeAsync(1_000);
      outbox.handle(textCompleted("final", "# 标题\n内容", "final_answer"));
      await settle();
      expect(calls.some((call) => call.method === "sendChatAction")).toBe(true);
      expect(calls.filter((call) => call.method === "editMessageText").length).toBeGreaterThanOrEqual(2);
      for (const call of calls) {
        expect(call.signal, call.method).toBeInstanceOf(AbortSignal);
        expect(call.payload).not.toHaveProperty("aborted");
      }
    } finally {
      await outbox.close();
    }
  });

  it("shows one initial plan and one message for each completed step", async () => {
    const api = new FakeTelegramApi();
    const outbox = new TelegramOutbox(
      api as unknown as Api,
      pino({ level: "silent" }),
      undefined,
      { planUpdatesEnabled: true },
    );

    outbox.handle(planUpdated([
      { step: "检查实现", status: "inProgress" },
      { step: "补充测试", status: "pending" },
    ]));
    outbox.handle(planUpdated([
      { step: "检查实现", status: "completed" },
      { step: "补充测试", status: "inProgress" },
    ]));
    outbox.handle(planUpdated([
      { step: "检查实现", status: "completed" },
      { step: "补充测试", status: "inProgress" },
    ]));
    outbox.handle(planUpdated([
      { step: "检查实现", status: "completed" },
      { step: "补充测试", status: "completed" },
    ]));
    await outbox.close();

    expect(api.sent).toHaveLength(3);
    expect(api.sent[0]).toContain("任务计划 · 0/2");
    expect(api.sent[1]).toContain("计划进度 · 1/2");
    expect(api.sent[1]).toContain("第 1 步完成：检查实现");
    expect(api.sent[2]).toContain("计划进度 · 2/2");
    expect(api.sent[2]).toContain("第 2 步完成：补充测试");
    expect(api.edits).toEqual([]);
  });

  it("hides automatic plan updates by default", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(planUpdated([
      { step: "不应展示", status: "inProgress" },
    ]));
    await outbox.close();

    expect(api.sent).toEqual([]);
  });

  it("delivers a thread rename through the Conversation queue", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "thread.name",
      target,
      threadId: "thread-1",
      name: "新名称",
    });
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent[0]).toContain("Session 名称已更新：新名称");
    expect(api.sent[1]).toEqual(turnCompletedPanel);
  });

  it("replies to the originating input when acknowledging Turn start", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.prepareTurnReplyTarget(target.conversationId, 42);
    outbox.handle(turnStarted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([turnStartedPanel]);
    expect(api.sendOptions[0]).toMatchObject({
      reply_parameters: {
        message_id: 42,
        allow_sending_without_reply: true,
      },
    });
  });

  it("identifies the Plugin in the unified Turn start reply", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      ...turnStarted(),
      identity: { kind: "plugin", name: "GitHub" },
    });
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["<b>已使用 GitHub Plugin 开始处理。</b>"]);
  });

  it("streams the thinking status as a panel updated in place", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      elapsedMs: 0,
    });
    await drain();
    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      elapsedMs: 3_000,
    });
    await drain();
    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      elapsedMs: 15_000,
      final: true,
    });
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["<b>思考中…</b>"]);
    expect(api.edits).toEqual([
      "<b>思考中…</b>\n\n<b>耗时：</b>3 s",
      "<b>思考完成</b>\n\n<b>耗时：</b>15 s",
    ]);
  });

  it("coalesces unprocessed reasoning snapshots for the same Turn", async () => {
    const api = new FakeTelegramApi();
    const originalSendMessage = api.sendMessage.bind(api);
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    api.sendMessage = async (chatId, text, options) => {
      await sendGate;
      return originalSendMessage(chatId, text, options);
    };
    const outbox = createOutbox(api);
    const reasoning = (elapsedMs: number): Extract<OutputEvent, { type: "turn.reasoning" }> => ({
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      elapsedMs,
    });

    // 首条快照正在创建“思考中”消息时，后续快照都还在队列里等待。
    outbox.handle(reasoning(3_000));
    await settle();
    outbox.handle(reasoning(6_000));
    outbox.handle(reasoning(9_000));
    await settle();
    // 平台持续变慢导致同一 Turn 的快照在队列里等待时，只保留最新一份中间状态。
    expect(api.edits).toEqual([]);
    releaseSend();
    await outbox.close();

    expect(api.sent).toEqual(["<b>思考中…</b>\n\n<b>耗时：</b>3 s"]);
    expect(api.edits).toEqual(["<b>思考中…</b>\n\n<b>耗时：</b>9 s"]);
  });

  it("starts an independent thinking message after tool execution begins", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      elapsedMs: 0,
    });
    await settle();

    outbox.handle(operationUpdated("command-1", "running", "command", "git status --short"));
    outbox.handle(operationUpdated("command-1", "completed", "command", "git status --short"));
    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      elapsedMs: 3_000,
    });
    await settle();

    await vi.waitFor(() => expect(api.edits).toEqual(["<b>思考完成</b>"]));
    expect(api.sent.filter((text) => !text.includes("操作过程"))).toEqual([
      "<b>思考中…</b>",
      "<b>思考中…</b>\n\n<b>耗时：</b>3 s",
    ]);
    expect(api.edits).toEqual([
      "<b>思考完成</b>",
    ]);

    await outbox.close();
  });

  it("keeps command workflow messages separate within one Turn", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(operationUpdated("command-1", "completed", "command", "git status --short"));
    outbox.handle(operationUpdated("file-1", "completed", "fileChange", "README.md"));
    await vi.advanceTimersByTimeAsync(750);
    await settle();
    await outbox.close();

    expect(api.sent).toHaveLength(2);
    expect(api.sent[0]).toContain("运行命令 · 已完成");
    expect(api.sent[1]).toContain("修改文件 · 已完成");
  });

  it("does not send thinking status when reasoning display is disabled", async () => {
    const api = new FakeTelegramApi();
    const outbox = new TelegramOutbox(
      api as unknown as Api,
      pino({ level: "silent" }),
      undefined,
      { reasoningEnabled: false },
    );

    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      elapsedMs: 0,
    });
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([]);
    expect(api.edits).toEqual([]);
  });

  it("queues a Workspace notification with direct switch buttons", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    expect(outbox.notifyPanel(
      target.conversationId,
      "Workspace 已添加\n\n│ codex-channels · codex-channels\n│ /workspace/codex-channels",
      {
        inline_keyboard: [[{
          text: "切换到 codex-channels",
          callback_data: "ws:codex-channels",
        }]],
      },
    )).toBe(true);
    await settle();
    await outbox.close();

    expect(api.sent[0]).toContain("<b>Workspace 已添加</b>");
    expect(api.sendOptions[0]).toMatchObject({
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{
          text: "切换到 codex-channels",
          callback_data: "ws:codex-channels",
        }]],
      },
    });
  });

  it("waits for persistent panel delivery and propagates API failures", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    await expect(outbox.deliverPanel(
      target.conversationId,
      "Workspace 已添加",
    )).resolves.toBeUndefined();
    api.rejectHtmlMessages = true;
    await expect(outbox.deliverPanel(
      target.conversationId,
      "Workspace 已添加",
    )).rejects.toThrow("can't parse entities");

    await outbox.close();
  });

  it("ignores output for another Surface or Telegram account", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "warning",
      target: { surface: "feishu", accountId: "tenant-a", conversationId: "100" },
      message: "飞书事件",
    });
    outbox.handle({
      type: "warning",
      target: { surface: "telegram", accountId: "other", conversationId: "100" },
      message: "其他 Bot 事件",
    });
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([]);
  });

  it("delivers the global idle notice", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "warning",
      target,
      message: "所有模型连接已空闲，空闲的 App Server 即将停止；使用中的实例保持运行，下次消息或恢复会话时会自动启动。",
      globalIdle: true,
    });
    await settle();
    await outbox.close();

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toContain("所有模型连接已空闲，空闲的 App Server 即将停止");
  });

  it("renders an idle release as a compact recovery panel", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "conversation.idle.released",
      target,
      threadId: "thread-idle-123",
      minutes: 15,
    });
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([[
      "<b>会话已自动解除占用</b>",
      "",
      "15 分钟内没有输入或输出。",
      "",
      "<b>恢复会话</b>",
      "<code>/r thread-idle-123</code>",
      "",
      "直接发送消息将开始新会话。",
    ].join("\n")]);
    expect(api.sendOptions[0]).toMatchObject({
      parse_mode: "HTML",
      disable_notification: true,
    });
    expect(api.sent[0]).not.toContain("Session ID");
  });

  it("sends completed generated images even when operation summaries are hidden", async () => {
    const api = new FakeTelegramApi();
    const image = Buffer.from("validated-image");
    const outbox = new TelegramOutbox(
      api as unknown as Api,
      pino({ level: "silent" }),
      undefined,
      {
        operationUpdateDisplay: "hidden",
        readGeneratedImage: vi.fn(async () => ({
          bytes: image,
          format: "png" as const,
        })),
      },
    );

    outbox.handle({
      ...operationUpdated("image-1", "completed", "imageGeneration"),
      operation: {
        ...operationUpdated(
          "image-1",
          "completed",
          "imageGeneration",
        ).operation,
        imagePath: "/private/generated/image.png",
      },
    });
    await outbox.close();

    expect(api.photos).toEqual([{
      filename: "codex-generated-image.png",
      options: { disable_notification: true },
      content: image,
    }]);
    expect(api.sent).toEqual([]);
  });

  it("sends a channel image through the ordered delivery queue", async () => {
    const api = new FakeTelegramApi();
    const image = Buffer.from("validated-image");
    const outbox = new TelegramOutbox(
      api as unknown as Api,
      pino({ level: "silent" }),
      undefined,
      {
        readGeneratedImage: vi.fn(async () => ({
          bytes: image,
          format: "png" as const,
        })),
      },
    );

    await outbox.sendChannelImage("100", "/private/generated/image.png");
    await outbox.close();

    expect(api.photos).toEqual([{
      filename: "codex-generated-image.png",
      options: { disable_notification: true },
      content: image,
    }]);
  });

  it("keeps Telegram typing active while a turn is running and stops on completion", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    const stopRequestTyping = outbox.beginTyping(target.conversationId);
    outbox.handle(turnStarted());
    stopRequestTyping();
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    expect(api.actions).toEqual(["typing"]);

    await vi.advanceTimersByTimeAsync(4_000);
    await settle();
    expect(api.actions).toEqual(["typing", "typing"]);

    outbox.handle(turnCompleted());
    await settle();
    await vi.advanceTimersByTimeAsync(8_000);
    await settle();
    expect(api.actions).toEqual(["typing", "typing"]);

    await outbox.close();
  });

  it("stops typing and reports a failed turn after finalizing streamed text", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(turnStarted());
    outbox.handle(textCompleted("commentary", "执行到一半。"));
    outbox.handle({
      ...turnCompleted(),
      status: "failed",
      error: "命令执行失败，TOKEN=[REDACTED]",
    });
    await settle();
    await vi.advanceTimersByTimeAsync(8_000);
    await settle();

    expect(api.sent).toEqual([
      turnStartedPanel,
      "执行到一半。",
      [
        "<b>本次运行 · 失败</b>",
        "",
        "• <b>错误：</b>命令执行失败，TOKEN=[已隐藏]",
        "",
        "<b>当前会话</b>",
        "• <b>Session：</b>测试会话",
        "• <b>Session ID：</b>thread-1",
      ].join("\n"),
    ]);
    expect(api.actions).toEqual([]);

    await outbox.close();
  });

  it("renders each agent message item from one turn as a separate Telegram message", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(turnStarted());
    outbox.setTurnReplyTarget(target.conversationId, "thread-1", "turn-1", 42);
    outbox.handle(textDelta("commentary", "正在检查", "commentary"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    outbox.handle(textCompleted("commentary", "正在检查。", "commentary"));
    outbox.handle(textDelta("final", "检查完成。", "final_answer"));
    outbox.handle(textCompleted("final", "检查完成。", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([
      turnStartedPanel,
      "正在检查",
      "检查完成。",
      turnCompletedPanel,
    ]);
    expect(api.edits).toContain("正在检查。");
    expect(api.sendOptions[0]).toEqual({
      parse_mode: "HTML",
      disable_notification: true,
      reply_parameters: {
        message_id: 42,
        allow_sending_without_reply: true,
      },
    });
    expect(api.sendOptions[1]).toEqual({
      disable_notification: true,
      reply_parameters: {
        message_id: 42,
        allow_sending_without_reply: true,
      },
    });
    expect(api.sendOptions[2]).toMatchObject({
      reply_parameters: { message_id: 42 },
    });
    expect(api.sendOptions[2]).not.toHaveProperty("disable_notification");
    expect(api.richMessages).toEqual([]);
    expect(api.sendOptions[2]).toMatchObject({ parse_mode: "HTML" });
  });

  it("bounds the number of active non-terminal Telegram streams", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    for (let index = 0; index < 101; index += 1) {
      outbox.handle(textDelta(`item-${index}`, `增量 ${index}`, "commentary"));
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    await outbox.close();

    expect(api.sent).toHaveLength(100);
  });

  it("delivers an authoritative completion after its non-terminal delta was dropped", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    for (let index = 0; index < 101; index += 1) {
      outbox.handle(textDelta(`item-${index}`, `增量 ${index}`, "commentary"));
    }
    outbox.handle(textCompleted(
      "item-100",
      "最终校正",
      "final_answer",
    ));
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["最终校正"]);
  });

  it("bounds buffered text for one Telegram stream and marks truncation", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textCompleted(
      "oversized",
      "x".repeat(1_000_100),
      "final_answer",
    ));
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(api.documents).toHaveLength(1);
    expect(api.documents[0]?.content).toContain("内容过长，已截断");
    expect(Array.from(api.documents[0]?.content ?? "")).toHaveLength(1_000_000);
  });

  it("renders final answers as compatible Telegram HTML by default", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const markdown = [
      "# 服务职责",
      "",
      "- App Server",
      "- Gateway",
      "",
      "```text",
      "App Server -> Gateway -> Telegram",
      "```",
    ].join("\n");

    outbox.handle(textCompleted("final", markdown, "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.richMessages).toEqual([]);
    expect(api.sent).toEqual([
      "<b>服务职责</b>\n\n• App Server\n• Gateway\n\n" +
      "<pre><code class=\"language-text\">App Server -&gt; Gateway -&gt; Telegram</code></pre>",
      turnCompletedPanel,
    ]);
    expect(api.sendOptions).toEqual([
      { parse_mode: "HTML" },
      { parse_mode: "HTML", disable_notification: true },
    ]);
  });

  it("shows the shared fallback for a blank final answer", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textCompleted("blank", " \n ", "final_answer"));
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(api.sent).toEqual([
      "Codex 返回了空消息。",
      turnCompletedPanel,
    ]);
  });

  it("sends command-only text fences as clickable Telegram commands", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const markdown = [
      "```text",
      "/status",
      "/goal unknown",
      "/fast status",
      "```",
    ].join("\n");

    outbox.handle(textCompleted("final", markdown, "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([
      "/status\n/goal unknown\n/fast status",
      turnCompletedPanel,
    ]);
    expect(api.sendOptions).toEqual([
      { parse_mode: "HTML" },
      { parse_mode: "HTML", disable_notification: true },
    ]);
  });

  it("collapses long final text regardless of where the turn started", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const text = Array.from({ length: 500 }, (_, index) => `第 ${index + 1} 行说明`).join("\n");

    outbox.handle({
      type: "user.message",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "external-input",
      text: "终端发起的请求",
    });
    outbox.handle(textCompleted("final", text));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent[0]).toContain("CLI 输入");
    expect(api.sendOptions[0]).toMatchObject({ disable_notification: true });
    expect(api.sent.slice(1).length).toBeGreaterThan(1);
    expect(api.sendOptions.slice(1, -1).every((options) =>
      hasHtmlParseMode(options)
    )).toBe(true);
    expect(api.sendOptions[1]).not.toHaveProperty("disable_notification");
    expect(api.sendOptions.slice(2).every(isSilent)).toBe(true);
    expect(api.documents).toEqual([]);
  });

  it("continues expanded long replies when the first edited chunk is already visible", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    outbox.handle(textDelta("final", "开头"));
    await vi.advanceTimersByTimeAsync(1_000);
    vi.spyOn(api, "editMessageText").mockRejectedValueOnce(new GrammyError("unchanged", {
      ok: false, error_code: 400, description: "Bad Request: message is not modified",
    }, "editMessageText", {}));
    const text = "## 报告\n" + "字段： `output_tokens`\n".repeat(350);
    await outbox.deliver(textCompleted("final", text), new AbortController().signal, async () => {});
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();
    expect(api.sent.slice(1, -1).length).toBeGreaterThan(0);
    expect(api.sent.slice(1, -1).join("")).toContain("<code>output_tokens</code>");
    expect(api.sendOptions.slice(1, -1).every(hasHtmlParseMode)).toBe(true);
    expect(api.sent.at(-1)).toBe(turnCompletedPanel);
  });

  it("previews large code and sends the complete response as a Markdown document", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const text = [
      "```ts",
      ...Array.from({ length: 100 }, (_, index) =>
        `export const value${index} = "${"x".repeat(40)}";`
      ),
      "```",
    ].join("\n");

    outbox.handle(textCompleted("final", text, "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toHaveLength(2);
    expect(api.sent[0]).toContain("以下为内容预览");
    expect(api.sent[1]).toBe(turnCompletedPanel);
    expect(api.documents).toHaveLength(1);
    expect(api.documents[0]?.filename).toBe("codex-response.md");
    expect(api.documents[0]?.options).toMatchObject({
      caption: "完整回复 · 102 行",
      disable_notification: true,
      reply_parameters: {
        message_id: 1,
        allow_sending_without_reply: true,
      },
    });
  });

  it("falls back to expanded HTML when the complete response file cannot be sent", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    api.rejectDocuments = true;
    const outbox = createOutbox(api);
    const text = [
      "```ts",
      ...Array.from({ length: 100 }, (_, index) =>
        `export const value${index} = "${"x".repeat(40)}";`
      ),
      "```",
    ].join("\n");

    outbox.handle(textCompleted("final", text, "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await vi.waitFor(() => expect(api.sent.at(-1)).toBe(turnCompletedPanel));
    await outbox.close();

    expect(api.documents).toEqual([]);
    expect(api.edits.length).toBeGreaterThan(0);
    expect(hasHtmlParseMode(api.editOptions[0])).toBe(true);
    expect(api.sendOptions.slice(1, -1).every((options) =>
      hasHtmlParseMode(options)
    )).toBe(true);
  });

  it.each([undefined, null] as const)("formats completed streamed Markdown with phase %s", async (phase) => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const markdown = "## 公式\n\n`output_tokens`\n\n| 口径 | 公式 |\n| --- | --- |\n| 生成 | `a / b` |\n\n```sql\nSELECT 1;\n```";
    outbox.handle({ ...textDelta("final", "## 公式"), ...(phase === null ? { phase } : {}) });
    await vi.advanceTimersByTimeAsync(1_000);
    outbox.handle({ ...textCompleted("final", markdown), ...(phase === null ? { phase } : {}) });
    await vi.waitFor(() => expect(api.edits.at(-1)).toContain("<b>公式</b>"));
    await outbox.close();
    expect(api.edits.at(-1)).toContain("<b>公式</b>");
    expect(api.edits.at(-1)).toContain("<code>output_tokens</code>");
    expect(api.edits.at(-1)).toContain("<b>口径 · 公式</b>");
    expect(api.edits.at(-1)).toContain('<pre><code class="language-sql">SELECT 1;</code></pre>');
    expect(api.editOptions.at(-1)).toMatchObject({ parse_mode: "HTML" });
  });

  it("keeps native Telegram Rich Markdown as an opt-in format", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api, "rich");
    const markdown = "# 标题\n\n- Rich Message";

    outbox.handle(textCompleted("final", markdown, "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.richMessages).toEqual([{ markdown }]);
    expect(api.sent).toEqual([markdown, turnCompletedPanel]);
  });

  it("upgrades a streamed final answer to Rich Markdown when completed", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api, "rich");

    outbox.handle(textDelta("final", "# 标题", "final_answer"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    outbox.handle(textCompleted("final", "# 标题\n\n最终内容", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["# 标题", turnCompletedPanel]);
    expect(api.richEdits).toEqual([{ markdown: "# 标题\n\n最终内容" }]);
    expect(api.edits).toContain("# 标题\n\n最终内容");
  });

  it("falls back to plain text when Telegram rejects a Rich Message", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    api.rejectRichMessages = true;
    const outbox = createOutbox(api, "rich");

    outbox.handle(textCompleted("final", "# 无法解析的内容", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await vi.waitFor(() => expect(api.sent.at(-1)).toBe(turnCompletedPanel));
    await outbox.close();

    expect(api.richMessages).toEqual([{ markdown: "# 无法解析的内容" }]);
    expect(api.sent).toEqual(["# 无法解析的内容", turnCompletedPanel]);
  });

  it("falls back to plain text when Telegram rejects compatible HTML", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    api.rejectHtmlMessages = true;
    const outbox = createOutbox(api);

    outbox.handle(textCompleted("final", "# 无法解析的内容", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await vi.waitFor(() => expect(api.sent).toContain("# 无法解析的内容"));
    await outbox.close();

    expect(api.sent).toEqual(["# 无法解析的内容"]);
    expect(api.sendOptions).toEqual([{}]);
  });

  it("renders external user input before the mirrored reply", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "user.message",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-1",
      text: "从 Desktop 发来的输入\nDESKTOP\\_TO\\_CHANNEL\\_OK",
    });
    outbox.handle(textCompleted(
      "final",
      "DESKTOP\\_TO\\_CHANNEL\\_OK",
      "final_answer",
    ));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([
      "<b>CLI 输入</b>\n\n<blockquote>从 Desktop 发来的输入\nDESKTOP_TO_CHANNEL_OK</blockquote>",
      "DESKTOP_TO_CHANNEL_OK",
      turnCompletedPanel,
    ]);
    expect(api.sendOptions[0]).toEqual({
      parse_mode: "HTML",
      disable_notification: true,
    });
    expect(api.sendOptions[1]).toMatchObject({
      reply_parameters: {
        message_id: 1,
        allow_sending_without_reply: true,
      },
    });
  });

  it("does not re-edit historical operations or delay the final reply behind unchanged records", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    for (let index = 0; index < 25; index++) {
      outbox.handle(operationUpdated(`command-${index}`, "running", "command", `echo ${index}`));
      await vi.advanceTimersByTimeAsync(750);
      outbox.handle(operationUpdated(`command-${index}`, "completed", "command", `echo ${index}`));
      await vi.advanceTimersByTimeAsync(750);
    }
    expect(api.sent).toHaveLength(25);
    expect(api.edits).toHaveLength(25);
    outbox.handle(textCompleted("final", "## 完成\n所有操作已完成"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();
    expect(api.edits).toHaveLength(25);
    expect(api.sent.at(-2)).toContain("<b>完成</b>");
    expect(api.sent.at(-1)).toBe(turnCompletedPanel);
  });

  it("retries changed operation text after an unsuccessful edit", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    outbox.handle(operationUpdated("command", "running", "command", "echo test"));
    await vi.advanceTimersByTimeAsync(750);
    const edit = vi.spyOn(api, "editMessageText").mockRejectedValueOnce(new Error("temporary failure"));
    outbox.handle(operationUpdated("command", "completed", "command", "echo test"));
    await vi.advanceTimersByTimeAsync(750);
    outbox.handle(textCompleted("final", "done"));
    await settle();
    await outbox.close();
    expect(edit).toHaveBeenCalledTimes(2);
    expect(api.edits[0]).toContain("已完成");
  });

  it("coalesces pending running-operation refreshes without losing completion", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const logger = pino({ level: "silent" });
    const debug = vi.spyOn(logger, "debug");
    const outbox = new TelegramOutbox(api as unknown as Api, logger);
    let release!: () => void;
    const blocked = outbox.runOrdered("100", () => new Promise<void>((resolve) => { release = resolve; }));
    await settle();
    for (let index = 0; index < 10; index++) {
      outbox.handle(operationUpdated("command", "running", "command", `echo ${index}`));
      await vi.advanceTimersByTimeAsync(750);
    }
    outbox.handle(operationUpdated("command", "completed", "command", "echo final"));
    outbox.handle(textCompleted("final", "done"));
    release();
    await blocked;
    await settle();
    await outbox.close();
    expect(api.sent.filter((text) => text.includes("操作过程"))).toHaveLength(1);
    expect(api.sent[0]).toContain("已完成");
    expect(api.sent[0]).toContain("echo final");
    expect(api.edits).toHaveLength(0);
    expect(debug.mock.calls.filter((call) => call[1] === "Surface 中间输出已合并")).toHaveLength(9);
  });

  it("keeps each operation in its own editable workflow message", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.setTurnReplyTarget(target.conversationId, "thread-1", "turn-1", 42);
    outbox.handle(operationUpdated("command-1", "running", "command", "TOKEN=[REDACTED] git status --short"));
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(api.sent).toEqual([
      "<b>操作过程</b>\n\n💻 ⏳ <b>运行命令 · 运行中</b>\n" +
      "<pre><code class=\"language-shell\">TOKEN=[已隐藏] git status --short</code></pre>",
    ]);
    expect(api.sendOptions[0]).toEqual({
      parse_mode: "HTML",
      disable_notification: true,
    });

    outbox.handle({
      ...operationUpdated("command-1", "completed", "command", "TOKEN=[REDACTED] git status --short"),
      operation: {
        ...operationUpdated("command-1", "completed", "command", "TOKEN=[REDACTED] git status --short").operation,
        durationMs: 125,
        exitCode: 0,
      },
    });
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(api.edits.at(-1)).toContain(
      "💻 <b>运行命令 · 已完成</b> · 125 ms · exit 0",
    );
    expect(api.editOptions.at(-1)).toEqual({ parse_mode: "HTML" });

    outbox.handle(operationUpdated("file-1", "completed", "fileChange", "README.md"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toHaveLength(3);
    expect(api.sent.at(-2)).toContain(
      "🔧 <b>修改文件 · 已完成</b>\n<blockquote>README.md</blockquote>",
    );
    expect(api.edits.at(-1)).toContain("运行命令 · 已完成");
    expect(api.sent.at(-1)).toBe(turnCompletedPanel);
  });

  it("groups identical consecutive file operations and escapes Telegram HTML", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(operationUpdated("file-1", "completed", "fileChange", "src/a<b>.ts & README.md"));
    outbox.handle(operationUpdated("file-2", "completed", "fileChange", "src/a<b>.ts & README.md"));
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(api.sent).toHaveLength(2);
    expect(api.sent[0]).toContain(
      "🔧 <b>修改文件 · 已完成</b>\n"
      + "<blockquote>src/a&lt;b&gt;.ts &amp; README.md</blockquote>",
    );
    expect(api.sent[1]).toContain(
      "🔧 <b>修改文件 · 已完成</b>\n"
      + "<blockquote>src/a&lt;b&gt;.ts &amp; README.md</blockquote>",
    );
    await outbox.close();
  });

  it("summarizes repeated query operations once before the final reply", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(operationUpdated("mcp-1", "completed", "mcpTool", "docs.read"));
    outbox.handle(operationUpdated("mcp-2", "completed", "mcpTool", "docs.read"));
    outbox.handle(operationUpdated("tool-1", "completed", "dynamicTool", "docs.search"));
    await vi.advanceTimersByTimeAsync(750);
    await settle();
    expect(api.sent).toEqual([]);

    outbox.handle(textCompleted("final", "查询完成", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([
      "<b>操作过程</b>\n\n<b>工具查询 · 已完成</b>\n"
      + "• MCP 工具：2 次\n"
      + "  ◦ <code>docs.read · 读写属性未知</code>：2 次\n"
      + "• 动态工具：1 次\n"
      + "  ◦ <code>docs.search</code>：1 次",
      "查询完成",
      turnCompletedPanel,
    ]);
  });

  it("flushes pending streamed text before a visible operation update", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textDelta("commentary", "先说明，再执行命令。", "commentary"));
    outbox.handle(operationUpdated("command-1", "completed", "command", "git status --short"));
    await vi.advanceTimersByTimeAsync(750);
    await settle();
    await outbox.close();

    expect(api.sent).toHaveLength(2);
    expect(api.sent[0]).toBe("先说明，再执行命令。");
    expect(api.sent[1]).toContain("💻 <b>运行命令 · 已完成</b>");
  });

  it("segments operations around agent replies in chronological order", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(operationUpdated("command-1", "completed", "command", "git status --short"));
    outbox.handle(textCompleted("commentary", "第一段回复", "commentary"));
    outbox.handle(operationUpdated("file-1", "completed", "fileChange", "README.md"));
    outbox.handle(textCompleted("final", "第二段回复", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toHaveLength(5);
    expect(api.sent[0]).toContain("💻 <b>运行命令 · 已完成</b>");
    expect(api.sent[1]).toBe("第一段回复");
    expect(api.sent[2]).toContain("🔧 <b>修改文件 · 已完成</b>");
    expect(api.sent[3]).toBe("第二段回复");
    expect(api.sent[4]).toBe(turnCompletedPanel);
  });

  it("flushes pending replies before an ordered interaction", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textDelta("commentary", "批准前说明", "commentary"));
    outbox.prepareInteraction(target.conversationId, userInputInteraction());
    const sent = outbox.runOrdered(target.conversationId, async () => {
      api.sent.push("审批卡片");
      return 7;
    });
    await settle();

    await expect(sent).resolves.toBe(7);
    expect(api.sent).toEqual(["批准前说明", "审批卡片"]);

    await outbox.close();
  });

  it("shows an approval-gated command only after approval", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const request = commandApprovalInteraction();

    outbox.handle(operationUpdated("command-1", "running", "command", "npm install -g ."));
    outbox.prepareInteraction(target.conversationId, request);
    const card = outbox.runOrdered(target.conversationId, async () => {
      api.sent.push("审批卡片");
      return true;
    });
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    await expect(card).resolves.toBe(true);
    expect(api.sent).toEqual(["审批卡片"]);

    outbox.finishInteraction(target.conversationId, request, {
      type: "approval",
      approved: true,
      scope: "once",
    });
    await settle();

    expect(api.sent).toHaveLength(2);
    expect(api.sent[1]).toContain("运行命令");
    await outbox.close();
  });

  it("withdraws an operation message when its approval request arrives after the flush", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const request = commandApprovalInteraction();

    outbox.handle(operationUpdated("command-1", "running", "command", "npm install -g ."));
    await vi.advanceTimersByTimeAsync(750);
    await settle();
    expect(api.sent[0]).toContain("npm install");

    outbox.prepareInteraction(target.conversationId, request);
    const card = outbox.runOrdered(target.conversationId, async () => {
      api.sent.push("审批卡片");
      return true;
    });
    await settle();

    await expect(card).resolves.toBe(true);
    expect(api.deleted).toEqual([1]);
    expect(api.sent.at(-1)).toBe("审批卡片");

    outbox.finishInteraction(target.conversationId, request, {
      type: "approval",
      approved: true,
      scope: "once",
    });
    await settle();
    expect(api.sent.at(-1)).toContain("运行命令");

    await outbox.close();
  });

  it("does not show an approval-gated command after rejection", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const request = commandApprovalInteraction();

    outbox.handle(operationUpdated("command-1", "running", "command", "npm install -g ."));
    outbox.prepareInteraction(target.conversationId, request);
    outbox.finishInteraction(target.conversationId, request, {
      type: "approval",
      approved: false,
    });
    outbox.handle(operationUpdated("command-1", "declined", "command", "npm install -g ."));
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(api.sent).toEqual([]);
    await outbox.close();
  });

  it("keeps a command hidden when its item starts after the approval card", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const request = commandApprovalInteraction();

    outbox.prepareInteraction(target.conversationId, request);
    outbox.handle(operationUpdated("command-1", "running", "command", "npm install -g ."));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(api.sent).toEqual([]);
    outbox.finishInteraction(target.conversationId, request, {
      type: "approval",
      approved: true,
      scope: "once",
    });
    await settle();
    expect(api.sent[0]).toContain("运行命令");

    await outbox.close();
  });

  it("does not mix a pending approval command into another command's progress", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const request = commandApprovalInteraction();

    outbox.handle(operationUpdated(
      "command-1",
      "running",
      "command",
      "npx vitest run tests/codexc-cli.test.ts",
    ));
    outbox.prepareInteraction(target.conversationId, request);
    const card = outbox.runOrdered(target.conversationId, async () => {
      api.sent.push("审批卡片");
      return true;
    });
    outbox.handle(operationUpdated(
      "command-2",
      "completed",
      "command",
      "npm run check",
    ));
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    await expect(card).resolves.toBe(true);
    expect(api.sent).toHaveLength(2);
    expect(api.sent[0]).toBe("审批卡片");
    expect(api.sent[1]).toContain("npm run check");
    expect(api.sent[1]).not.toContain("npx vitest");

    outbox.finishInteraction(target.conversationId, request, {
      type: "approval",
      approved: false,
    });
    await settle();
    expect(api.sent.join("\n")).not.toContain("npx vitest");

    await outbox.close();
  });

  it("bounds long operation histories and keeps the most recent records", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    for (let index = 0; index < 101; index += 1) {
      outbox.handle(operationUpdated(
        `command-${index}`,
        index === 100 ? "failed" : "completed",
        "command",
        `命令 ${index}`,
      ));
    }
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(api.sent).toHaveLength(100);
    expect(api.sent.some((text) => text.includes("命令 0\n"))).toBe(false);
    expect(api.sent.at(-1)).toContain(
      "💻 ❌ <b>运行命令 · 失败</b>\n"
      + "<pre><code class=\"language-shell\">命令 100</code></pre>",
    );

    await outbox.close();
  });

  it("replies to the Telegram message that started the turn", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.setTurnReplyTarget(target.conversationId, "thread-1", "turn-1", 42);
    outbox.handle(textCompleted("final-1", "来自 Codex 的回复", "final_answer"));
    outbox.handle(textCompleted("final-2", "补充说明", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([
      "来自 Codex 的回复",
      "补充说明",
      turnCompletedPanel,
    ]);
    expect(api.sendOptions[0]).toMatchObject({
      reply_parameters: {
        message_id: 42,
        allow_sending_without_reply: true,
      },
    });
    expect(api.sendOptions[1]).toEqual({
      parse_mode: "HTML",
      disable_notification: true,
      reply_parameters: {
        message_id: 42,
        allow_sending_without_reply: true,
      },
    });
  });

  it("reports current context usage after the turn's final reply", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textCompleted("final", "处理完成", "final_answer"));
    outbox.handle({
      ...turnCompleted(),
      tokenUsage: {
        total: tokenBreakdown(80_000),
        last: tokenBreakdown(24_600),
        modelContextWindow: 258_000,
      },
      model: "gpt-5.6-sol",
      effort: "medium",
      serviceTier: "fast",
      gitBranch: "feature/weixin-surface",
      contextCompactionCount: 2,
      weeklyLimit: {
        usedPercent: 42,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
      goal: {
        threadId: "thread-1",
        objective: "完成 Gateway",
        status: "active",
        tokenBudget: 100_000,
        tokensUsed: 12_500,
        timeUsedSeconds: 90,
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([
      "处理完成",
      [
        turnCompletedTitle,
        "",
        "• <b>模型：</b>gpt-5.6-sol · medium · Fast 开启",
        "• <b>提供商：</b>OpenAI 官方",
        "• <b>最近请求缓存命中率：</b>2.07%",
        "",
        "<b>当前会话</b>",
        "• <b>Session：</b>测试会话",
        "• <b>Session ID：</b>thread-1",
        "• <b>上下文：</b>24.6 K / 258 K（9.5%）",
        "• <b>上下文压缩：</b>2 次",
        "• <b>Goal：</b>进行中 · 12.5 K / 100 K",
        "• <b>Git 分支：</b>feature/weixin-surface",
        "",
        "<b>账户状态</b>",
        "• <b>周限：</b>剩余：58%",
      ].join("\n"),
    ]);
    expect(api.sendOptions[1]).toEqual({
      parse_mode: "HTML",
      disable_notification: true,
    });
  });

  it("reports the Git branch after a completed turn without token usage", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      ...turnCompleted(),
      gitBranch: "feature/weixin-surface",
    });
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([
      [
        turnCompletedTitle,
        "",
        "<b>当前会话</b>",
        "• <b>Session：</b>测试会话",
        "• <b>Session ID：</b>thread-1",
        "• <b>Git 分支：</b>feature/weixin-surface",
      ].join("\n"),
    ]);
  });

  it("finalizes completed stream content during graceful shutdown", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textCompleted("final", "关闭前已经完成", "final_answer"));
    await outbox.close();

    expect(api.sent).toEqual(["关闭前已经完成"]);
  });

  it("does not persist an incomplete stream during graceful shutdown", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textDelta("final", "仍在生成", "final_answer"));
    await outbox.close();

    expect(api.sent).toEqual([]);
  });

  it("clears pending typing and stream output after the App Server disconnects", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(turnStarted());
    await vi.advanceTimersByTimeAsync(400);
    outbox.handle(textDelta("commentary", "尚未完成", "commentary"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    outbox.handle({
      type: "connection.lost",
      target,
      threadId: "thread-1",
      message: "连接已断开",
    });
    await settle();
    await vi.advanceTimersByTimeAsync(8_000);
    await settle();

    expect(api.actions).toEqual(["typing"]);
    expect(api.sent).toEqual([
      turnStartedPanel,
      "尚未完成",
      "Codex 连接已中断：连接已断开",
    ]);
    expect(api.sendOptions.at(-1)).not.toHaveProperty("disable_notification");

    await outbox.close();
  });

  it("cleans live state before a deferred disconnect notice and does not clear a newer turn on replay", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const lost = { type: "connection.lost" as const, target, threadId: "thread-1", message: "连接已断开" };
    try {
      outbox.handle(turnStarted());
      await vi.advanceTimersByTimeAsync(400);
      outbox.observe(lost);
      await vi.advanceTimersByTimeAsync(8000);
      expect(api.actions).toEqual(["typing"]);
      expect(api.sent).toEqual([turnStartedPanel]);
      outbox.observe({ ...turnStarted(), turnId: "new-turn" });
      await outbox.deliver(lost, new AbortController().signal, async () => {});
      await vi.advanceTimersByTimeAsync(4000);
      expect(api.actions).toEqual(["typing", "typing"]);
      expect(api.sent.at(-1)).toBe("Codex 连接已中断：连接已断开");
    } finally { await outbox.close(); }
  });

  it("sends a connection restore notice without clearing stream output", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textDelta("commentary", "尚未完成", "commentary"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    outbox.handle({
      type: "connection.restored",
      target,
      threadId: "thread-1",
      message: "openai App Server 已重新连接",
    });
    await settle();
    await vi.advanceTimersByTimeAsync(8_000);
    await settle();

    expect(api.sent).toEqual([
      "尚未完成",
      "Codex 连接已恢复：openai App Server 已重新连接",
    ]);

    await outbox.close();
  });

  it("sends non-critical Codex warnings silently", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "warning",
      target,
      message: "代理连接失败，TOKEN=[REDACTED]",
    });
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["Codex 警告：代理连接失败，TOKEN=[已隐藏]"]);
    expect(api.sendOptions).toEqual([{ disable_notification: true }]);
  });

  it("renders idle release as a Telegram panel with the resume command", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "conversation.idle.released",
      target,
      threadId: "thread-idle-123",
      minutes: 15,
    });
    await settle();
    await outbox.close();

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toContain("thread-idle-123");
    expect(api.sent[0]).toContain("/r thread-idle-123");
    expect(api.sendOptions[0]).toMatchObject({ disable_notification: true, parse_mode: "HTML" });
  });

  it("sends MCP OAuth failures as critical status panels", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "mcp.oauth.completed",
      target,
      threadId: "thread-1",
      name: "docs",
      success: false,
      error: "OAuth denied",
    });
    await settle();
    await outbox.close();

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toContain("MCP OAuth");
    expect(api.sent[0]).toContain("登录失败");
    expect(api.sent[0]).toContain("OAuth denied");
    expect(api.sendOptions[0]).not.toHaveProperty("disable_notification");
  });

  it("does not send operation updates in hidden mode", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = new TelegramOutbox(
      api as unknown as Api,
      pino({ level: "silent" }),
      undefined,
      { operationUpdateDisplay: "hidden" },
    );

    outbox.handle(operationUpdated("command-1", "running", "command", "git status --short"));
    outbox.handle(operationUpdated("command-1", "completed", "command", "git status --short"));
    await settle();

    expect(api.sent).toEqual([]);
    expect(api.edits).toEqual([]);

    outbox.handle({
      type: "warning",
      target,
      message: "仍显示关键警告",
    });
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["Codex 警告：仍显示关键警告"]);
  });

  it("renders operation updates as one-line summaries in compact mode", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = new TelegramOutbox(
      api as unknown as Api,
      pino({ level: "silent" }),
      undefined,
      { operationUpdateDisplay: "compact" },
    );

    outbox.handle({
      ...operationUpdated("command-1", "completed", "command", "git status --short\nsecond line"),
      operation: {
        ...operationUpdated(
          "command-1",
          "completed",
          "command",
          "git status --short\nsecond line",
        ).operation,
        durationMs: 125,
        exitCode: 0,
      },
    });
    await vi.advanceTimersByTimeAsync(750);
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([
      "<b>操作过程</b>\n\n"
      + "💻 <b>运行命令 · 已完成</b> · 125 ms · exit 0"
      + " · <code>git status --short second line</code>",
    ]);
  });

  it("hides successful wait calls but keeps subagent failures in compact mode", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = new TelegramOutbox(
      api as unknown as Api,
      pino({ level: "silent" }),
      undefined,
      { operationUpdateDisplay: "compact" },
    );

    outbox.handle({
      ...operationUpdated("wait-1", "completed", "subagent"),
      operation: {
        ...operationUpdated("wait-1", "completed", "subagent").operation,
        action: "wait",
      },
    });
    outbox.handle({
      ...operationUpdated("wait-2", "failed", "subagent"),
      operation: {
        ...operationUpdated("wait-2", "failed", "subagent").operation,
        action: "wait",
      },
    });
    await vi.advanceTimersByTimeAsync(750);
    await settle();
    await outbox.close();

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toContain("等待子代理 · 失败");
    expect(api.sent[0]).not.toContain("等待子代理 · 已完成");
  });

  it("sends one compact subagent start notice", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "subagent.spawned",
      target,
      threadId: "parent-thread",
      turnId: "parent-turn",
      agentThreadId: "agent-thread-secret",
      agentPath: "/root/review_task",
    });
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["<b>子代理开始 · review_task</b>"]);
    expect(api.sent[0]).not.toContain("agent-thread-secret");
  });

  it("sends one compact subagent follow-up notice", async () => {
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "subagent.contacted",
      target,
      threadId: "parent-thread",
      turnId: "parent-turn",
      agentThreadId: "agent-thread-secret",
      agentPath: "/root/review_task",
    });
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["<b>子代理继续 · review_task</b>"]);
    expect(api.sent[0]).not.toContain("agent-thread-secret");
  });
});

function createOutbox(
  api: FakeTelegramApi,
  finalMessageFormat: "html" | "rich" = "html",
  debugEnabled = false,
): TelegramOutbox {
  return new TelegramOutbox(
    api as unknown as Api,
    pino({ level: "silent" }),
    undefined,
    {
      finalMessageFormat,
      ...(debugEnabled ? { debugEnabled: true } : {}),
    },
  );
}

function turnStarted(): Extract<OutputEvent, { type: "turn.started" }> {
  return { type: "turn.started", target, threadId: "thread-1", turnId: "turn-1" };
}

function planUpdated(
  steps: Extract<OutputEvent, { type: "plan.updated" }>["steps"],
): Extract<OutputEvent, { type: "plan.updated" }> {
  return {
    type: "plan.updated",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    explanation: null,
    steps,
  };
}

function turnCompleted(): Extract<OutputEvent, { type: "turn.completed" }> {
  return {
    type: "turn.completed",
    target,
    threadId: "thread-1",
    sessionName: "测试会话",
    turnId: "turn-1",
    status: "completed",
  };
}

function textDelta(
  itemId: string,
  text: string,
  phase?: "commentary" | "final_answer",
): Extract<OutputEvent, { type: "text.delta" }> {
  return {
    type: "text.delta",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    text,
    ...(phase ? { phase } : {}),
  };
}

function textCompleted(
  itemId: string,
  text: string,
  phase?: "commentary" | "final_answer",
): Extract<OutputEvent, { type: "text.completed" }> {
  return {
    type: "text.completed",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    text,
    ...(phase ? { phase } : {}),
  };
}

function operationUpdated(
  itemId: string,
  status: "running" | "completed" | "failed" | "declined",
  kind: Extract<OutputEvent, { type: "operation.updated" }>["operation"]["kind"],
  detail?: string,
): Extract<OutputEvent, { type: "operation.updated" }> {
  return {
    type: "operation.updated",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    operation: {
      itemId,
      status,
      kind,
      ...(detail ? { detail } : {}),
    },
  };
}

function commandApprovalInteraction() {
  return {
    type: "approval" as const,
    requestId: "request-1",
    kind: "command" as const,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "command-1",
    title: "Codex 请求执行命令",
    detail: "npm install -g .",
    allowSession: true,
    expiresInMs: 30_000,
  };
}

function userInputInteraction() {
  return {
    type: "user-input" as const,
    requestId: "request-input",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "tool-1",
    title: "Codex 需要输入",
    questions: [],
    expiresInMs: 30_000,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function drain(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function tokenBreakdown(totalTokens: number) {
  return {
    totalTokens,
    inputTokens: totalTokens - 500,
    cachedInputTokens: 500,
    cacheWriteInputTokens: 0,
    outputTokens: 500,
    reasoningOutputTokens: 100,
  };
}

function hasHtmlParseMode(value: unknown): boolean {
  return typeof value === "object" &&
    value !== null &&
    "parse_mode" in value &&
    value.parse_mode === "HTML";
}

function isSilent(value: unknown): boolean {
  return typeof value === "object" &&
    value !== null &&
    "disable_notification" in value &&
    value.disable_notification === true;
}

function badRequest(description: string): GrammyError {
  return new GrammyError("rejected", { ok: false, error_code: 400, description }, "sendMessage", {});
}
