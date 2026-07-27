import {
  ConversationCommandService,
  isConversationCommandName,
  type ConversationService,
} from "../../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
} from "../../conversation-core/index.js";
import { parseSlashCommand } from "../slash-command.js";
import {
  formatWeixinCommandText,
  renderWeixinCommandResult,
  renderWeixinHelp,
  renderWeixinIdentity,
  renderWeixinUserFacingError,
} from "./command-renderer.js";
import type { WeixinOutbox } from "./outbox.js";

export interface WeixinConversationMessage {
  target: ConversationTarget;
  actorId: string;
  text: string;
}

export class WeixinConversationAdapter {
  private readonly commands: ConversationCommandService;

  constructor(
    private readonly conversations: ConversationService,
    private readonly outbox: Pick<WeixinOutbox, "notifyText">,
  ) {
    this.commands = new ConversationCommandService(conversations);
  }

  async handle(message: WeixinConversationMessage): Promise<void> {
    try {
      const command = parseSlashCommand(message.text);
      if (command === null) {
        await this.conversations.submit(message.target, message.text);
        return;
      }
      if (command.name === "start" || command.name === "help") {
        this.notify(message.target, renderWeixinHelp());
        return;
      }
      if (command.name === "whoami") {
        this.notify(message.target, renderWeixinIdentity(message));
        return;
      }
      if (!isConversationCommandName(command.name)) {
        throw new UserFacingError(
          "command.unsupported",
          "微信命令不受支持",
          { command: command.name },
        );
      }
      const result = await this.commands.execute(
        message.target,
        command.name,
        command.argumentsText,
      );
      this.notify(message.target, renderWeixinCommandResult(result));
    } catch (error) {
      if (error instanceof WeixinOutputQueueError) {
        throw error;
      }
      if (!(error instanceof UserFacingError)) {
        throw error;
      }
      this.notify(
        message.target,
        `操作失败：${renderWeixinUserFacingError(error)}。`,
      );
    }
  }

  private notify(target: ConversationTarget, text: string): void {
    if (!this.outbox.notifyText(target, formatWeixinCommandText(text))) {
      throw new WeixinOutputQueueError();
    }
  }
}

class WeixinOutputQueueError extends Error {
  constructor() {
    super("微信输出队列拒绝消息");
    this.name = "WeixinOutputQueueError";
  }
}
