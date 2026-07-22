import { randomBytes } from "node:crypto";

import { Bot, InlineKeyboard, type Context } from "grammy";

import type { InteractionDecision, InteractionPort, InteractionRequest } from "../../approval/types.js";
import type { ConversationTarget } from "../../conversation-core/events.js";

interface PendingInteraction {
  requestId: string;
  target: ConversationTarget;
  request: InteractionRequest;
  resolve(decision: InteractionDecision): void;
  timer: NodeJS.Timeout;
  messageId: number;
}

export class TelegramInteractionPort implements InteractionPort {
  private readonly pendingByToken = new Map<string, PendingInteraction>();
  private readonly tokenByRequest = new Map<string, string>();
  private readonly tokenByChat = new Map<string, string>();

  constructor(private readonly bot: Bot) {
    bot.callbackQuery(/^ix:/, (context) => this.onCallback(context));
  }

  async request(
    target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    const token = randomBytes(12).toString("base64url");
    const keyboard = this.keyboard(request, token);
    const message = await this.bot.api.sendMessage(
      target.conversationId,
      formatInteraction(request),
      keyboard ? { reply_markup: keyboard } : {},
    );

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
      });
      this.tokenByRequest.set(request.requestId, token);
      if (request.type === "user-input" || (request.type === "elicitation" && request.mode === "form")) {
        this.tokenByChat.set(target.conversationId, token);
      }
    });
  }

  resolved(requestId: string): void {
    const token = this.tokenByRequest.get(requestId);
    if (token) {
      const pending = this.pendingByToken.get(token);
      if (pending) {
        this.finish(token, timeoutDecision(pending.request), "已在其他客户端处理");
      }
    }
  }

  async handleText(context: Context): Promise<boolean> {
    const chatId = context.chat?.id;
    const text = context.message?.text;
    if (chatId === undefined || !text || text.startsWith("/")) {
      return false;
    }
    const token = this.tokenByChat.get(String(chatId));
    const pending = token ? this.pendingByToken.get(token) : undefined;
    if (!pending) {
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
        await context.reply("表单必须回复为有效 JSON 对象；发送 /cancel 取消。", {
          reply_parameters: { message_id: pending.messageId },
        });
      }
      return true;
    }
    return false;
  }

  cancelForChat(chatId: string): boolean {
    const token = this.tokenByChat.get(chatId);
    const pending = token ? this.pendingByToken.get(token) : undefined;
    if (!pending) {
      return false;
    }
    this.finish(token!, timeoutDecision(pending.request), "已取消");
    return true;
  }

  close(): void {
    this.cancelAll("Gateway 已停止");
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
    if (this.tokenByChat.get(pending.target.conversationId) === token) {
      this.tokenByChat.delete(pending.target.conversationId);
    }
    pending.resolve(decision);
    void this.bot.api
      .editMessageText(pending.target.conversationId, pending.messageId, `${formatInteraction(pending.request)}\n\n处理结果：${outcome}`)
      .catch(() => undefined);
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
    return `${request.title}\n\n${request.detail}`;
  }
  if (request.type === "user-input") {
    const questions = request.questions.map((question) => {
      const options = question.options.length ? `\n选项：${question.options.join(" / ")}` : "";
      return `${question.id}: ${question.question}${options}`;
    });
    return `${request.title}\n\n${questions.join("\n\n")}\n\n请回复本消息。多个问题使用“问题ID=回答”，每行一个。`;
  }
  const instruction = request.mode === "form" ? "请回复有效 JSON 对象，或发送 /cancel。" : "请打开链接完成操作，然后点击“完成”。";
  return `${request.title}\n\n${request.message}\n\n${instruction}`;
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
