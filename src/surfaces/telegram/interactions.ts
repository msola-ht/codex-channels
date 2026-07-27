import { randomBytes } from "node:crypto";

import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Logger } from "pino";

import {
  safeInteractionDecision,
  type InteractionDecision,
  type InteractionPort,
  type InteractionRequest,
} from "../../approval/index.js";
import type { ConversationTarget } from "../../conversation-core/index.js";
import { TelegramApiExecutor } from "./api-executor.js";
import {
  formatTelegramExpandableQuotePanelChunks,
  formatTelegramPanelChunks,
} from "./html-format.js";
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

const maximumConcurrentInteractions = 100;

export class TelegramInteractionPort implements InteractionPort {
  private readonly pendingByToken = new Map<string, PendingInteraction>();
  private readonly tokenByRequest = new Map<string, string>();
  private readonly textTokenByChat = new Map<string, string>();
  private readonly latestTokenByChat = new Map<string, string>();
  private readonly resolvedBeforePending = new Set<string>();
  private readonly preparations = new Set<Promise<
    Awaited<ReturnType<Bot["api"]["sendMessage"]>> | undefined
  >>();
  private readonly preparationCancellations = new Set<() => void>();
  private readonly statusUpdates = new Set<Promise<void>>();
  private closed = false;

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
    if (
      this.closed
      ||
      this.tokenByRequest.has(request.requestId)
      || this.tokenByRequest.size >= maximumConcurrentInteractions
    ) {
      return safeInteractionDecision(request);
    }
    const token = randomBytes(12).toString("base64url");
    const keyboard = this.keyboard(request, token);
    const chunks = request.type === "approval"
      ? formatTelegramExpandableQuotePanelChunks(request.title, request.detail, 3_600)
      : formatTelegramPanelChunks(formatInteraction(request), 3_600);
    this.tokenByRequest.set(request.requestId, token);
    this.queue.prepareInteraction(target.conversationId, request);
    const preparation = this.prepareInteraction(
      target,
      request,
      token,
      chunks,
      keyboard,
    );
    this.preparations.add(preparation);
    void preparation.then(
      () => this.preparations.delete(preparation),
      () => this.preparations.delete(preparation),
    );
    let cancelPreparation!: () => void;
    const cancelled = new Promise<{ type: "closed" }>((resolve) => {
      cancelPreparation = () => resolve({ type: "closed" });
    });
    this.preparationCancellations.add(cancelPreparation);
    const result = await Promise.race([
      preparation.then(
        (message) => ({ type: "prepared" as const, message }),
        (error: unknown) => ({ type: "failed" as const, error }),
      ),
      cancelled,
    ]);
    this.preparationCancellations.delete(cancelPreparation);
    if (result.type !== "prepared") {
      if (this.tokenByRequest.get(request.requestId) === token) {
        this.tokenByRequest.delete(request.requestId);
      }
      this.resolvedBeforePending.delete(token);
      if (result.type === "failed") {
        throw result.error;
      }
      return safeInteractionDecision(request);
    }
    const message = result.message;
    if (!message) {
      return safeInteractionDecision(request);
    }
    if (this.closed) {
      await this.finishPreparedAfterClose(
        target,
        request,
        token,
        message.message_id,
        chunks.at(-1)!,
      );
      return safeInteractionDecision(request);
    }

    return new Promise<InteractionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(token, safeInteractionDecision(request));
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
        this.finish(token, safeInteractionDecision(request), "已在其他客户端处理");
      }
    });
  }

  private async prepareInteraction(
    target: ConversationTarget,
    request: InteractionRequest,
    token: string,
    chunks: string[],
    keyboard: InlineKeyboard | undefined,
  ): Promise<Awaited<ReturnType<Bot["api"]["sendMessage"]>> | undefined> {
    let message: Awaited<ReturnType<Bot["api"]["sendMessage"]>> | undefined;
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
      this.logger.warn(
        {
          ...interactionLogMetadata(target, request),
          ...telegramErrorMetadata(error),
        },
        "Telegram 交互请求发送失败",
      );
      throw error;
    }
    if (!message) {
      throw new Error("Telegram 交互消息为空");
    }
    this.logger.info(
      {
        ...interactionLogMetadata(target, request),
        messageId: message.message_id,
      },
      "Telegram 交互请求已送达",
    );
    if (!this.closed) {
      return message;
    }
    await this.finishPreparedAfterClose(
      target,
      request,
      token,
      message.message_id,
      chunks.at(-1)!,
    );
    return undefined;
  }

  private async finishPreparedAfterClose(
    target: ConversationTarget,
    request: InteractionRequest,
    token: string,
    messageId: number,
    messageText: string,
  ): Promise<void> {
    if (this.tokenByRequest.get(request.requestId) === token) {
      this.tokenByRequest.delete(request.requestId);
    }
    await this.updateInteractionMessage(
      target,
      request.requestId,
      messageId,
      messageText,
      "Gateway 已停止",
    );
    this.queue.finishInteraction(
      target.conversationId,
      request,
      safeInteractionDecision(request),
    );
  }

  resolved(requestId: string): void {
    const token = this.tokenByRequest.get(requestId);
    if (token) {
      const pending = this.pendingByToken.get(token);
      if (pending) {
        this.finish(
          token,
          safeInteractionDecision(pending.request),
          "已在其他客户端处理",
        );
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
      if (!answers) {
        await this.queue.runOrdered(
          pending.target.conversationId,
          () => this.executor.call(
            { chatId: pending.target.conversationId, operation: "sendMessage", critical: true },
            () => context.reply(
              "回答不完整或不符合可选值，请按原请求重新回复；发送 /stop 可停止当前请求。",
              { reply_parameters: { message_id: pending.messageId } },
            ),
          ),
        );
        return true;
      }
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
            () => context.reply("表单必须回复为有效 JSON 对象；发送 /stop 停止当前请求。", {
              reply_parameters: { message_id: pending.messageId },
            }),
          ),
        );
      }
      return true;
    }
    return false;
  }

  stopForChat(chatId: string): boolean {
    const token = this.latestTokenByChat.get(chatId);
    const pending = token ? this.pendingByToken.get(token) : undefined;
    if (!pending) {
      return false;
    }
    this.finish(token!, safeInteractionDecision(pending.request), "已取消");
    return true;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const cancel of this.preparationCancellations) {
        cancel();
      }
      this.preparationCancellations.clear();
    }
    this.cancelAll("Gateway 已停止");
    this.resolvedBeforePending.clear();
    await waitAtMost(Promise.allSettled([...this.preparations]), 5_000);
    const updates = Promise.allSettled([...this.statusUpdates]);
    await waitAtMost(updates, 5_000);
  }

  cancelAll(outcome = "连接已断开"): void {
    for (const [token, pending] of this.pendingByToken) {
      this.finish(token, safeInteractionDecision(pending.request), outcome);
    }
  }

  private keyboard(request: InteractionRequest, token: string): InlineKeyboard | undefined {
    if (request.type === "approval") {
      const keyboard = new InlineKeyboard().text("批准一次", `ix:a:${token}`);
      if (request.execPolicyAmendment) {
        keyboard.text("始终允许此前缀", `ix:p:${token}`).row();
      }
      for (const [index, amendment] of (request.networkPolicyAmendments ?? []).entries()) {
        const action = amendment.action === "allow" ? "允许" : "拒绝";
        keyboard.text(`始终${action} ${amendment.host}`, `ix:n${index}:${token}`).row();
      }
      if (request.allowSession) {
        keyboard.text(
          request.networkApprovalContext
            ? `本会话允许 ${request.networkApprovalContext.host}`
            : "本次会话始终同意",
          `ix:s:${token}`,
        ).row();
      }
      return keyboard.text("拒绝", `ix:d:${token}`);
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
    if (this.closed) {
      await context.answerCallbackQuery({ text: "该请求已失效" });
      return;
    }
    const [, action, token] = data.split(":");
    const pending = token ? this.pendingByToken.get(token) : undefined;
    if (!pending || String(context.chat?.id) !== pending.target.conversationId) {
      await context.answerCallbackQuery({ text: "该请求已失效" });
      return;
    }
    if (pending.request.type === "approval") {
      if (action === "s" && !pending.request.allowSession) {
        await context.answerCallbackQuery({ text: "该请求不支持会话授权" });
        return;
      }
      if (action === "p" && !pending.request.execPolicyAmendment) {
        await context.answerCallbackQuery({ text: "该请求不支持持久规则" });
        return;
      }
      const networkMatch = /^n(\d+)$/.exec(action ?? "");
      const networkPolicyAmendment = networkMatch
        ? pending.request.networkPolicyAmendments?.[Number(networkMatch[1])]
        : undefined;
      if (networkMatch && !networkPolicyAmendment) {
        await context.answerCallbackQuery({ text: "该请求不支持持久网络规则" });
        return;
      }
      if (action === "a") {
        this.finish(token!, { type: "approval", approved: true, scope: "once" }, "已批准一次");
      } else if (action === "p") {
        this.finish(
          token!,
          { type: "approval", approved: true, scope: "execpolicy" },
          "已保存命令前缀规则",
        );
      } else if (networkPolicyAmendment) {
        const action = networkPolicyAmendment.action === "allow" ? "允许" : "拒绝";
        this.finish(
          token!,
          {
            type: "approval",
            approved: true,
            scope: "networkpolicy",
            networkPolicyAmendment,
          },
          `已保存网络${action}规则`,
        );
      } else if (action === "s") {
        this.finish(
          token!,
          { type: "approval", approved: true, scope: "session" },
          pending.request.networkApprovalContext
            ? `本会话已允许 ${pending.request.networkApprovalContext.host}`
            : "已在本次会话中始终同意",
        );
      } else {
        this.finish(token!, { type: "approval", approved: false }, "已拒绝");
      }
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
    const statusUpdate = this.updateInteractionMessage(
      pending.target,
      pending.requestId,
      pending.messageId,
      pending.messageText,
      outcome,
    ).then(() => {
      this.queue.finishInteraction(pending.target.conversationId, pending.request, decision);
      pending.resolve(decision);
    });
    this.statusUpdates.add(statusUpdate);
    void statusUpdate.finally(() => this.statusUpdates.delete(statusUpdate));
  }

  private updateInteractionMessage(
    target: ConversationTarget,
    requestId: string,
    messageId: number,
    messageText: string,
    outcome: string,
  ): Promise<void> {
    return this.queue.runOrdered(target.conversationId, () =>
      this.executor.call(
        { chatId: target.conversationId, operation: "editMessageText", critical: true },
        () => this.bot.api.editMessageText(
          target.conversationId,
          messageId,
          `${messageText}\n\n处理结果：${outcome}`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] },
          },
        ),
      )
    ).then(() => undefined).catch((error) => {
      this.logger.warn(
        {
          chatId: target.conversationId,
          requestId,
          ...telegramErrorMetadata(error),
        },
        "Telegram 交互消息状态更新失败",
      );
    });
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

function formatInteraction(request: Exclude<InteractionRequest, { type: "approval" }>): string {
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
  const instruction = request.mode === "form" ? "请回复有效 JSON 对象，或发送 /stop 停止当前请求。" : "请打开链接完成操作，然后点击“完成”。";
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

function interactionLogMetadata(
  target: ConversationTarget,
  request: InteractionRequest,
): Record<string, unknown> {
  return {
    surface: target.surface,
    accountId: target.accountId,
    conversationId: target.conversationId,
    requestId: request.requestId,
    requestType: request.type,
    threadId: request.threadId,
    turnId: request.turnId,
  };
}

function parseAnswers(
  request: Extract<InteractionRequest, { type: "user-input" }>,
  text: string,
): Record<string, string[]> | undefined {
  if (request.questions.length === 1 && !text.includes("=")) {
    const question = request.questions[0]!;
    const answer = text.trim();
    return isValidAnswer(question, answer)
      ? { [question.id]: [answer] }
      : undefined;
  }
  const answers: Record<string, string[]> = {};
  for (const line of text.split("\n").filter((candidate) => candidate.trim())) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      return undefined;
    }
    const id = line.slice(0, separator).trim();
    const answer = line.slice(separator + 1).trim();
    const question = request.questions.find((candidate) => candidate.id === id);
    if (!question || id in answers || !isValidAnswer(question, answer)) {
      return undefined;
    }
    answers[id] = [answer];
  }
  return Object.keys(answers).length === request.questions.length
    ? answers
    : undefined;
}

function isValidAnswer(
  question: Extract<InteractionRequest, { type: "user-input" }>["questions"][number],
  answer: string,
): boolean {
  return answer.length > 0
    && (
      question.options.length === 0
      || question.allowOther
      || question.options.includes(answer)
    );
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
