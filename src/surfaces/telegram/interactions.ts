import { randomBytes } from "node:crypto";

import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Logger } from "pino";

import type { InteractionDecision, InteractionPort, InteractionRequest } from "../../approval/index.js";
import type { ConversationTarget } from "../../conversation-core/index.js";
import { TelegramApiExecutor } from "./api-executor.js";
import { formatTelegramPanelChunks } from "./html-format.js";
import { telegramErrorMetadata } from "./error-metadata.js";

interface PendingInteraction {
  requestId: string;
  target: ConversationTarget;
  request: InteractionRequest;
  resolve(decision: InteractionDecision): void;
  timer: NodeJS.Timeout;
  messageId: number;
  messageText: string;
}

export interface TelegramInteractionQueue {
  prepareInteraction(chatId: string, request: InteractionRequest): void;
  finishInteraction(
    chatId: string,
    request: InteractionRequest,
    decision: InteractionDecision,
  ): void;
  runOrdered<T>(chatId: string, run: () => Promise<T>): Promise<T>;
}

const directInteractionQueue: TelegramInteractionQueue = {
  prepareInteraction: () => undefined,
  finishInteraction: () => undefined,
  runOrdered: (_chatId, run) => run(),
};

export class TelegramInteractionPort implements InteractionPort {
  private readonly pendingByToken = new Map<string, PendingInteraction>();
  private readonly tokenByRequest = new Map<string, string>();
  private readonly textTokenByChat = new Map<string, string>();
  private readonly latestTokenByChat = new Map<string, string>();
  private readonly resolvedBeforePending = new Set<string>();
  private readonly statusUpdates = new Set<Promise<void>>();

  constructor(
    private readonly bot: Bot,
    private readonly logger: Logger,
    private readonly executor = new TelegramApiExecutor(logger),
    private readonly queue: TelegramInteractionQueue = directInteractionQueue,
  ) {
    bot.callbackQuery(/^ix:/, (context) => this.onCallback(context));
  }

  async request(
    target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    const token = randomBytes(12).toString("base64url");
    const keyboard = this.keyboard(request, token);
    const formatted = formatInteraction(request);
    const chunks = formatTelegramPanelChunks(formatted, 3_600);
    this.tokenByRequest.set(request.requestId, token);
    let message: Awaited<ReturnType<typeof this.bot.api.sendMessage>> | undefined;
    this.queue.prepareInteraction(target.conversationId, request);
    try {
      message = await this.queue.runOrdered(target.conversationId, async () => {
        let sent: Awaited<ReturnType<typeof this.bot.api.sendMessage>> | undefined;
        for (const [index, chunk] of chunks.entries()) {
          const isLast = index === chunks.length - 1;
          const options = isLast
            ? interactionOptions(request, keyboard)
            : { parse_mode: "HTML" as const, disable_notification: true };
          sent = await this.executor.call(
            { chatId: target.conversationId, operation: "sendMessage", critical: true },
            () => this.bot.api.sendMessage(target.conversationId, chunk, options),
          );
        }
        return sent;
      });
    } catch (error) {
      if (this.tokenByRequest.get(request.requestId) === token) {
        this.tokenByRequest.delete(request.requestId);
      }
      this.resolvedBeforePending.delete(token);
      throw error;
    }
    if (!message) {
      throw new Error("Telegram 交互消息为空");
    }

    return new Promise<InteractionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(token, timeoutDecision(request));
      }, request.expiresInMs);
      timer.unref();
      this.pendingByToken.set(token, {
        requestId: request.requestId,
        target,
        request,
        resolve,
        timer,
        messageId: message.message_id,
        messageText: chunks.at(-1)!,
      });
      this.latestTokenByChat.set(target.conversationId, token);
      if (request.type === "user-input" || (request.type === "elicitation" && request.mode === "form")) {
        this.textTokenByChat.set(target.conversationId, token);
      }
      if (this.resolvedBeforePending.delete(token)) {
        this.finish(token, timeoutDecision(request), "已在其他客户端处理");
      }
    });
  }

  resolved(requestId: string): void {
    const token = this.tokenByRequest.get(requestId);
    if (token) {
      const pending = this.pendingByToken.get(token);
      if (pending) {
        this.finish(token, timeoutDecision(pending.request), "已在其他客户端处理");
      } else {
        this.resolvedBeforePending.add(token);
      }
    }
  }

  async handleText(context: Context): Promise<boolean> {
    const chatId = context.chat?.id;
    const text = context.message?.text;
    if (chatId === undefined || !text || text.startsWith("/")) {
      return false;
    }
    const token = this.textTokenByChat.get(String(chatId));
    const pending = token ? this.pendingByToken.get(token) : undefined;
    if (!pending) {
      return false;
    }
    if (context.message?.reply_to_message?.message_id !== pending.messageId) {
      return false;
    }
    if (pending.request.type === "user-input") {
      const answers = parseAnswers(pending.request, text);
      this.finish(token!, { type: "user-input", answers }, "已提交回答");
      return true;
    }
    if (pending.request.type === "elicitation" && pending.request.mode === "form") {
      try {
        const content = JSON.parse(text) as unknown;
        this.finish(token!, { type: "elicitation", action: "accept", content }, "已提交表单");
      } catch {
        await this.queue.runOrdered(
          pending.target.conversationId,
          () => this.executor.call(
            { chatId: pending.target.conversationId, operation: "sendMessage", critical: true },
            () => context.reply("表单必须回复为有效 JSON 对象；发送 /cancel 取消。", {
              reply_parameters: { message_id: pending.messageId },
            }),
          ),
        );
      }
      return true;
    }
    return false;
  }

  cancelForChat(chatId: string): boolean {
    const token = this.latestTokenByChat.get(chatId);
    const pending = token ? this.pendingByToken.get(token) : undefined;
    if (!pending) {
      return false;
    }
    this.finish(token!, timeoutDecision(pending.request), "已取消");
    return true;
  }

  async close(): Promise<void> {
    this.cancelAll("Gateway 已停止");
    this.resolvedBeforePending.clear();
    const updates = Promise.allSettled([...this.statusUpdates]);
    await waitAtMost(updates, 5_000);
  }

  cancelAll(outcome = "连接已断开"): void {
    for (const [token, pending] of this.pendingByToken) {
      this.finish(token, timeoutDecision(pending.request), outcome);
    }
  }

  private keyboard(request: InteractionRequest, token: string): InlineKeyboard | undefined {
    if (request.type === "approval") {
      return new InlineKeyboard()
        .text("批准一次", `ix:a:${token}`)
        .text("拒绝", `ix:d:${token}`);
    }
    if (request.type === "elicitation" && request.mode === "url") {
      const keyboard = new InlineKeyboard();
      if (request.url) {
        keyboard.url("打开链接", request.url).row();
      }
      return keyboard.text("完成", `ix:a:${token}`).text("取消", `ix:c:${token}`);
    }
    return undefined;
  }

  private async onCallback(context: Context): Promise<void> {
    const data = context.callbackQuery?.data;
    if (!data) {
      return;
    }
    const [, action, token] = data.split(":");
    const pending = token ? this.pendingByToken.get(token) : undefined;
    if (!pending || String(context.chat?.id) !== pending.target.conversationId) {
      await context.answerCallbackQuery({ text: "该请求已失效" });
      return;
    }
    if (pending.request.type === "approval") {
      this.finish(token!, { type: "approval", approved: action === "a" }, action === "a" ? "已批准一次" : "已拒绝");
    } else if (pending.request.type === "elicitation") {
      this.finish(
        token!,
        { type: "elicitation", action: action === "a" ? "accept" : "cancel", content: null },
        action === "a" ? "已确认" : "已取消",
      );
    }
    await context.answerCallbackQuery();
  }

  private finish(token: string, decision: InteractionDecision, outcome = "请求已超时"): void {
    const pending = this.pendingByToken.get(token);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingByToken.delete(token);
    this.tokenByRequest.delete(pending.requestId);
    if (this.textTokenByChat.get(pending.target.conversationId) === token) {
      const previousText = this.previousPendingToken(
        pending.target.conversationId,
        (candidate) => candidate.request.type === "user-input" ||
          (candidate.request.type === "elicitation" && candidate.request.mode === "form"),
      );
      if (previousText) {
        this.textTokenByChat.set(pending.target.conversationId, previousText);
      } else {
        this.textTokenByChat.delete(pending.target.conversationId);
      }
    }
    if (this.latestTokenByChat.get(pending.target.conversationId) === token) {
      const previous = this.previousPendingToken(pending.target.conversationId);
      if (previous) {
        this.latestTokenByChat.set(pending.target.conversationId, previous);
      } else {
        this.latestTokenByChat.delete(pending.target.conversationId);
      }
    }
    const statusUpdate = this.queue.runOrdered(pending.target.conversationId, () =>
      this.executor.call(
        { chatId: pending.target.conversationId, operation: "editMessageText", critical: true },
        () => this.bot.api.editMessageText(
          pending.target.conversationId,
          pending.messageId,
          `${pending.messageText}\n\n处理结果：${outcome}`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] },
          },
        ),
      )
    ).then(() => undefined).catch((error) => {
      this.logger.warn(
        {
          chatId: pending.target.conversationId,
          requestId: pending.requestId,
          ...telegramErrorMetadata(error),
        },
        "Telegram 交互消息状态更新失败",
      );
    }).then(() => {
      this.queue.finishInteraction(pending.target.conversationId, pending.request, decision);
      pending.resolve(decision);
    });
    this.statusUpdates.add(statusUpdate);
    void statusUpdate.finally(() => this.statusUpdates.delete(statusUpdate));
  }

  private previousPendingToken(
    conversationId: string,
    predicate: (pending: PendingInteraction) => boolean = () => true,
  ): string | undefined {
    return [...this.pendingByToken.entries()]
      .reverse()
      .find(([, candidate]) =>
        candidate.target.conversationId === conversationId && predicate(candidate),
      )?.[0];
  }
}

function timeoutDecision(request: InteractionRequest): InteractionDecision {
  if (request.type === "approval") {
    return { type: "approval", approved: false };
  }
  if (request.type === "user-input") {
    return { type: "user-input", answers: {} };
  }
  return { type: "elicitation", action: "cancel", content: null };
}

function formatInteraction(request: InteractionRequest): string {
  if (request.type === "approval") {
    const detail = request.detail
      .split("\n")
      .map((line) => `│ ${line}`)
      .join("\n");
    return `${request.title}\n\n${detail}`;
  }
  if (request.type === "user-input") {
    const questions = request.questions.map((question) => {
      const options = question.options.length ? `\n选项：${question.options.join(" / ")}` : "";
      return `${question.id}: ${question.question}${options}`;
    });
    const secretWarning = request.questions.some((question) => question.secret)
      ? "\n\n安全提示：Telegram 回复会保留在聊天记录中，请勿发送密钥、Token 或其他敏感凭据。"
      : "";
    return `${request.title}\n\n${questions.join("\n\n")}\n\n请回复本消息。多个问题使用“问题ID=回答”，每行一个。${secretWarning}`;
  }
  const instruction = request.mode === "form" ? "请回复有效 JSON 对象，或发送 /cancel。" : "请打开链接完成操作，然后点击“完成”。";
  return `${request.title}\n\n${request.message}\n\n${instruction}`;
}

function interactionOptions(
  request: InteractionRequest,
  keyboard: InlineKeyboard | undefined,
): Parameters<Bot["api"]["sendMessage"]>[2] {
  if (keyboard) {
    return { parse_mode: "HTML", reply_markup: keyboard };
  }
  if (request.type === "user-input" || (request.type === "elicitation" && request.mode === "form")) {
    return {
      parse_mode: "HTML",
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: "请回复此请求",
      },
    };
  }
  return { parse_mode: "HTML" };
}

function parseAnswers(
  request: Extract<InteractionRequest, { type: "user-input" }>,
  text: string,
): Record<string, string[]> {
  if (request.questions.length === 1 && !text.includes("=")) {
    const question = request.questions[0]!;
    return { [question.id]: [text.trim()] };
  }
  const answers: Record<string, string[]> = {};
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const id = line.slice(0, separator).trim();
    const answer = line.slice(separator + 1).trim();
    if (request.questions.some((question) => question.id === id) && answer) {
      answers[id] = [answer];
    }
  }
  return answers;
}

async function waitAtMost<T>(operation: Promise<T>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
