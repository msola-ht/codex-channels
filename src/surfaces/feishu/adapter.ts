import {
  ConversationCommandService,
  isConversationCommandName,
  type ConversationService,
} from "../../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
} from "../../conversation-core/index.js";

import type {
  FeishuCommandCenter,
  FeishuCommandCenterAction,
} from "./command-center.js";
import type { FeishuApplicationSetupController } from "./application-setup.js";
import type { FeishuInboxMessage } from "./inbox.js";
import type { FeishuImagePort } from "./media.js";
import type { FeishuOutbox } from "./outbox.js";
import type { FeishuOAuthControllerPort } from "./oauth.js";
import {
  renderFeishuDoctor,
  renderFeishuPermissionHelp,
  renderFeishuPermissionStatus,
  type FeishuPermissionRuntimeStatus,
} from "./permissions.js";
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
      "notifyMarkdown" | "notifyText"
    >,
    private readonly images: Pick<FeishuImagePort, "download">,
    private readonly permissionStatus: () => FeishuPermissionRuntimeStatus =
      () => ({
        connectionReady: false,
        cardActionObserved: false,
        menuEventObserved: false,
      }),
    private readonly oauth?: FeishuOAuthControllerPort,
    private readonly commandCenter?: Pick<FeishuCommandCenter, "open">,
    private readonly applicationSetup?: Pick<
      FeishuApplicationSetupController,
      "openDoctor"
    >,
  ) {
    this.commands = new ConversationCommandService(conversations);
  }

  async handle(message: FeishuInboxMessage): Promise<void> {
    try {
      if (message.kind === "image") {
        await this.handleImage(message);
        return;
      }
      const command = parseFeishuCommand(message.text);
      if (command !== null) {
        if (command.name === "start" || command.name === "help") {
          if (this.commandCenter) {
            await this.commandCenter.open(message.target, message.actorId);
          } else {
            this.notifyMarkdown(
              message.target.conversationId,
              renderFeishuHelp(),
            );
          }
          return;
        }
        if (command.name === "whoami") {
          this.notifyMarkdown(
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
        if (command.name === "feishu") {
          await this.handleFeishuCommand(
            message.actorId,
            message.target.accountId,
            message.target.conversationId,
            command.argumentsText,
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
        this.notifyMarkdown(
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

  async handleCommandCenterAction(
    target: ConversationTarget,
    action: FeishuCommandCenterAction,
  ): Promise<void> {
    try {
      if (action === "help") {
        this.notifyMarkdown(target.conversationId, renderFeishuHelp());
        return;
      }
      const result = await this.commands.execute(target, action);
      this.notifyMarkdown(
        target.conversationId,
        renderFeishuCommandResult(result),
      );
    } catch (error) {
      if (error instanceof FeishuOutputQueueError) {
        throw error;
      }
      const detail = error instanceof UserFacingError
        ? renderFeishuUserFacingError(error)
        : "Gateway 未能完成请求，请稍后重试";
      this.notifyText(
        target.conversationId,
        `操作失败：${detail}。`,
      );
      throw error;
    }
  }

  private async handleFeishuCommand(
    actorId: string,
    appId: string,
    chatId: string,
    argumentsText: string,
  ): Promise<void> {
    const action = argumentsText.trim();
    const status = this.permissionStatus();
    if (action === "") {
      this.notifyMarkdown(chatId, renderFeishuPermissionHelp());
      return;
    }
    if (action === "status") {
      const userAuthorization = this.oauth
        ? await this.oauth.status(actorId)
        : "unavailable";
      this.notifyMarkdown(
        chatId,
        renderFeishuPermissionStatus(appId, status, userAuthorization),
      );
      return;
    }
    if (action === "doctor") {
      if (this.applicationSetup) {
        await this.applicationSetup.openDoctor(
          {
            surface: "feishu",
            accountId: appId,
            conversationId: chatId,
          },
          actorId,
          status,
        );
        return;
      }
      this.notifyMarkdown(
        chatId,
        renderFeishuDoctor(status),
      );
      return;
    }
    if (action === "revoke") {
      if (!this.oauth) {
        this.notifyText(chatId, "飞书用户授权模块尚未启用。");
        return;
      }
      const removed = await this.oauth.revoke(actorId);
      this.notifyText(
        chatId,
        removed
          ? "已清除当前飞书账号保存的本地授权凭据。"
          : "当前飞书账号没有已保存的授权凭据。",
      );
      return;
    }
    this.notifyText(
      chatId,
      "用法：/feishu <status|doctor|revoke>",
    );
  }

  private async handleImage(
    message: Extract<FeishuInboxMessage, { kind: "image" }>,
  ): Promise<void> {
    const image = await this.images.download(
      message.messageId,
      message.imageKey,
    );
    const submission = await this.conversations.submit(
      message.target,
      {
        text: "请查看这张图片并根据图片内容协助我。",
        localImages: [{ path: image.path }],
      },
    );
    if (submission.steered) {
      this.notifyText(
        message.target.conversationId,
        "已将图片追加到当前 Turn。",
      );
    }
  }

  private notifyText(chatId: string, text: string): void {
    if (!this.outbox.notifyText(chatId, text)) {
      throw new FeishuOutputQueueError();
    }
  }

  private notifyMarkdown(chatId: string, markdown: string): void {
    if (!this.outbox.notifyMarkdown(chatId, markdown)) {
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
