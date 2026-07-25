import {
  ConversationCommandService,
  isConversationCommandName,
  type ConversationService,
} from "../../application/index.js";
import { UserFacingError } from "../../conversation-core/index.js";

import type { FeishuInboxMessage } from "./inbox.js";
import type { FeishuOutbox } from "./outbox.js";
import {
  renderFeishuCommandResult,
  renderFeishuHelp,
  renderFeishuIdentity,
  renderFeishuUserFacingError,
} from "./renderer.js";

export class FeishuConversationAdapter {
  private readonly commands: ConversationCommandService;

  constructor(
    private readonly conversations: ConversationService,
    private readonly outbox: Pick<
      FeishuOutbox,
      "notifyPost" | "notifyText"
    >,
  ) {
    this.commands = new ConversationCommandService(conversations);
  }

  async handle(message: FeishuInboxMessage): Promise<void> {
    try {
      const command = parseFeishuCommand(message.text);
      if (command !== null) {
        if (command.name === "start" || command.name === "help") {
          this.notifyPost(
            message.target.conversationId,
            renderFeishuHelp(),
          );
          return;
        }
        if (command.name === "whoami") {
          this.notifyPost(
            message.target.conversationId,
            renderFeishuIdentity(message),
          );
          return;
        }
        if (command.name === "cancel") {
          this.notifyText(
            message.target.conversationId,
            "当前没有待处理的交互请求。",
          );
          return;
        }
        if (!isConversationCommandName(command.name)) {
          throw new UserFacingError(
            "command.unsupported",
            "飞书命令不受支持",
          );
        }
        const result = await this.commands.execute(
          message.target,
          command.name,
          command.argumentsText,
        );
        this.notifyPost(
          message.target.conversationId,
          renderFeishuCommandResult(result),
        );
        return;
      }
      const submission = await this.conversations.submit(
        message.target,
        message.text,
      );
      if (!submission.steered) {
        return;
      }
      this.notifyText(
        message.target.conversationId,
        "已将补充要求追加到当前 Turn。",
      );
    } catch (error) {
      if (error instanceof FeishuOutputQueueError) {
        throw error;
      }
      const detail = error instanceof UserFacingError
        ? renderFeishuUserFacingError(error)
        : "Gateway 未能完成请求，请稍后重试";
      this.notifyText(
        message.target.conversationId,
        `操作失败：${detail}。`,
      );
      throw error;
    }
  }

  private notifyText(chatId: string, text: string): void {
    if (!this.outbox.notifyText(chatId, text)) {
      throw new FeishuOutputQueueError();
    }
  }

  private notifyPost(chatId: string, markdown: string): void {
    if (!this.outbox.notifyPost(chatId, markdown)) {
      throw new FeishuOutputQueueError();
    }
  }
}

class FeishuOutputQueueError extends Error {
  constructor() {
    super("飞书输出队列拒绝消息");
    this.name = "FeishuOutputQueueError";
  }
}

interface ParsedFeishuCommand {
  name: string;
  argumentsText: string;
}

function parseFeishuCommand(text: string): ParsedFeishuCommand | null {
  const normalized = text.trim();
  if (!normalized.startsWith("/")) {
    return null;
  }
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/u.exec(normalized);
  if (match === null) {
    throw new UserFacingError(
      "command.unsupported",
      "飞书命令不受支持",
    );
  }
  const name = match[1]!;
  return {
    name,
    argumentsText: match[2] ?? "",
  };
}
