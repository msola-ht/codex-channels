import { randomBytes } from "node:crypto";

import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Logger } from "pino";

import {
  resolveApprovalChoice,
  safeInteractionDecision,
  type ApprovalChoice,
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
  answers: Record<string, string[]>;
  questionIndex: number;
  awaitingOther: boolean;
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
    const keyboard = this.keyboard(request, token, 0);
    const chunks = request.type === "approval"
      ? formatTelegramExpandableQuotePanelChunks(request.title, request.detail, 3_600)
      : formatTelegramPanelChunks(formatInteraction(request, 0), 3_600);
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
        answers: {},
        questionIndex: 0,
        awaitingOther: false,
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
      const completeAnswers = parseAnswers(pending.request, text);
      if (completeAnswers) {
        this.finish(
          token!,
          { type: "user-input", answers: completeAnswers },
          "已提交回答",
        );
        return true;
      }
      const question = pending.request.questions[pending.questionIndex];
      const answer = text.trim();
      if (
        !question
        || (
          !pending.awaitingOther
          && question.options.length > 0
          && !question.options.includes(answer)
        )
        || !isValidAnswer(question, answer)
      ) {
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
      pending.answers[question.id] = [answer];
      const nextQuestion = nextUnansweredQuestion(
        pending.request,
        pending.answers,
      );
      if (nextQuestion === undefined) {
        this.finish(
          token!,
          { type: "user-input", answers: pending.answers },
          "已提交回答",
        );
        return true;
      }
      await this.tryMoveToUserInputQuestion(
        pending,
        token!,
        nextQuestion,
        false,
        "已回答",
      );
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

  private keyboard(
    request: InteractionRequest,
    token: string,
    questionIndex: number,
    awaitingOther = false,
  ): InlineKeyboard | undefined {
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
    if (request.type === "user-input" && !awaitingOther) {
      const question = request.questions[questionIndex];
      if (question && question.options.length > 0) {
        const keyboard = new InlineKeyboard();
        for (const [optionIndex, option] of question.options.entries()) {
          keyboard.text(
            option,
            `ix:q${questionIndex}.${optionIndex}:${token}`,
          ).row();
        }
        if (question.allowOther) {
          keyboard.text(
            "其他内容",
            `ix:q${questionIndex}.o:${token}`,
          ).row();
        }
        return keyboard;
      }
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
      const choice = telegramApprovalChoice(action);
      const resolution = choice
        ? resolveApprovalChoice(pending.request, choice)
        : undefined;
      if (!resolution) {
        await context.answerCallbackQuery({
          text: unsupportedApprovalChoiceMessage(choice),
        });
        return;
      }
      this.finish(token!, resolution.decision, resolution.outcome);
    } else if (pending.request.type === "elicitation") {
      this.finish(
        token!,
        { type: "elicitation", action: action === "a" ? "accept" : "cancel", content: null },
        action === "a" ? "已确认" : "已取消",
      );
    } else if (pending.request.type === "user-input") {
      await this.handleUserInputCallback(context, pending, token!, action);
      return;
    }
    await context.answerCallbackQuery();
  }

  private async handleUserInputCallback(
    context: Context,
    pending: PendingInteraction,
    token: string,
    action: string | undefined,
  ): Promise<void> {
    if (pending.request.type !== "user-input") {
      await context.answerCallbackQuery({ text: "该请求已失效" });
      return;
    }
    const request = pending.request;
    const match = /^q(\d+)\.(\d+|o)$/u.exec(action ?? "");
    const questionIndex = match ? Number(match[1]) : -1;
    const answerIndex = match?.[2];
    const question = request.questions[questionIndex];
    if (
      !question
      || questionIndex !== pending.questionIndex
      || pending.awaitingOther
    ) {
      await context.answerCallbackQuery({ text: "该问题已处理" });
      return;
    }
    if (answerIndex === "o") {
      if (!question.allowOther) {
        await context.answerCallbackQuery({ text: "该问题不支持其他内容" });
        return;
      }
      await context.answerCallbackQuery({ text: "请回复其他内容" });
      await this.tryMoveToUserInputQuestion(
        pending,
        token,
        questionIndex,
        true,
        "已选择其他内容",
      );
      return;
    }
    const optionIndex = Number(answerIndex);
    const answer = question.options[optionIndex];
    if (!answer) {
      await context.answerCallbackQuery({ text: "该选项已失效" });
      return;
    }
    pending.answers[question.id] = [answer];
    const nextQuestion = nextUnansweredQuestion(
      request,
      pending.answers,
    );
    if (nextQuestion === undefined) {
      this.finish(
        token,
        { type: "user-input", answers: pending.answers },
        "已提交回答",
      );
      await context.answerCallbackQuery({ text: `已选择：${answer}` });
      return;
    }
    await context.answerCallbackQuery({ text: `已选择：${answer}` });
    await this.tryMoveToUserInputQuestion(
      pending,
      token,
      nextQuestion,
      false,
      `已选择：${answer}`,
    );
  }

  private async tryMoveToUserInputQuestion(
    pending: PendingInteraction,
    token: string,
    questionIndex: number,
    awaitingOther: boolean,
    outcome: string,
  ): Promise<void> {
    try {
      await this.moveToUserInputQuestion(
        pending,
        token,
        questionIndex,
        awaitingOther,
        outcome,
      );
    } catch (error) {
      this.logger.warn(
        {
          surface: pending.target.surface,
          accountId: pending.target.accountId,
          conversationId: pending.target.conversationId,
          requestId: pending.requestId,
          requestType: pending.request.type,
          threadId: pending.request.threadId,
          turnId: pending.request.turnId,
          ...telegramErrorMetadata(error),
        },
        "Telegram 下一项输入请求发送失败",
      );
      this.finish(
        token,
        safeInteractionDecision(pending.request),
        "Codex 输入请求无法继续，已安全取消",
      );
    }
  }

  private async moveToUserInputQuestion(
    pending: PendingInteraction,
    token: string,
    questionIndex: number,
    awaitingOther: boolean,
    outcome: string,
  ): Promise<void> {
    if (pending.request.type !== "user-input") {
      throw new Error("Telegram 用户输入状态不匹配");
    }
    await this.updateInteractionMessage(
      pending.target,
      pending.requestId,
      pending.messageId,
      pending.messageText,
      outcome,
    );
    const { message, messageText } = await this.sendUserInputQuestion(
      pending.target,
      pending.request,
      token,
      questionIndex,
      awaitingOther,
    );
    pending.messageId = message.message_id;
    pending.messageText = messageText;
    pending.questionIndex = questionIndex;
    pending.awaitingOther = awaitingOther;
  }

  private async sendUserInputQuestion(
    target: ConversationTarget,
    request: Extract<InteractionRequest, { type: "user-input" }>,
    token: string,
    questionIndex: number,
    awaitingOther: boolean,
  ): Promise<{
    message: Awaited<ReturnType<Bot["api"]["sendMessage"]>>;
    messageText: string;
  }> {
    const chunks = formatTelegramPanelChunks(
      formatInteraction(request, questionIndex, awaitingOther),
      3_600,
    );
    const keyboard = this.keyboard(
      request,
      token,
      questionIndex,
      awaitingOther,
    );
    const message = await this.queue.runOrdered(
      target.conversationId,
      async () => {
        let sent: Awaited<ReturnType<typeof this.bot.api.sendMessage>>
          | undefined;
        for (const [index, chunk] of chunks.entries()) {
          const isLast = index === chunks.length - 1;
          sent = await this.executor.call(
            {
              chatId: target.conversationId,
              operation: "sendMessage",
              critical: true,
            },
            () => this.bot.api.sendMessage(
              target.conversationId,
              chunk,
              isLast
                ? interactionOptions(request, keyboard)
                : { parse_mode: "HTML", disable_notification: true },
            ),
          );
        }
        return sent;
      },
    );
    if (!message) {
      throw new Error("Telegram 用户输入消息为空");
    }
    return {
      message,
      messageText: chunks.at(-1)!,
    };
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

function telegramApprovalChoice(
  action: string | undefined,
): ApprovalChoice | undefined {
  switch (action) {
    case "a":
      return { type: "once" };
    case "s":
      return { type: "session" };
    case "p":
      return { type: "execpolicy" };
    case "d":
      return { type: "reject" };
    default: {
      const match = /^n(\d+)$/u.exec(action ?? "");
      return match
        ? { type: "networkpolicy", amendmentIndex: Number(match[1]) }
        : undefined;
    }
  }
}

function unsupportedApprovalChoiceMessage(
  choice: ApprovalChoice | undefined,
): string {
  switch (choice?.type) {
    case "session":
      return "该请求不支持会话授权";
    case "execpolicy":
      return "该请求不支持持久规则";
    case "networkpolicy":
      return "该请求不支持持久网络规则";
    case "once":
    case "reject":
    case undefined:
      return "该请求已失效";
  }
}

function formatInteraction(
  request: Exclude<InteractionRequest, { type: "approval" }>,
  questionIndex = 0,
  awaitingOther = false,
): string {
  if (request.type === "user-input") {
    const question = request.questions[questionIndex]!;
    const title = question.header.trim() || `问题 ${questionIndex + 1}`;
    const instruction = awaitingOther
      ? "请输入其他内容并回复本消息。"
      : question.options.length > 0
        ? "请选择下方按钮。"
        : "请回复本消息。";
    const secretWarning = request.questions.some((question) => question.secret)
      ? "\n\n安全提示：Telegram 回复会保留在聊天记录中，请勿发送密钥、Token 或其他敏感凭据。"
      : "";
    return [
      request.title,
      "",
      `问题 ${questionIndex + 1}/${request.questions.length}：${title}`,
      question.question,
      "",
      instruction,
      "发送 /stop 可停止当前请求。",
    ].join("\n") + secretWarning;
  }
  const instruction = request.mode === "form" ? "请回复有效 JSON 对象，或发送 /stop 停止当前请求。" : "请打开链接完成操作，然后点击“完成”。";
  return `${request.title}\n\n${request.message}\n\n${instruction}`;
}

function nextUnansweredQuestion(
  request: Extract<InteractionRequest, { type: "user-input" }>,
  answers: Readonly<Record<string, string[]>>,
): number | undefined {
  const index = request.questions.findIndex((question) =>
    answers[question.id] === undefined
  );
  return index < 0 ? undefined : index;
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
