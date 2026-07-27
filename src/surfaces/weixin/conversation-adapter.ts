import {
  ConversationCommandService,
  type ConversationCommandName,
  type ConversationCommandResult,
  type ConversationService,
} from "../../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
} from "../../conversation-core/index.js";
import {
  formatConversationCommandOutcome,
  formatConversationStatus,
} from "../conversation-command-format.js";
import { parseSlashCommand } from "../slash-command.js";
import type { WeixinOutbox } from "./outbox.js";

const weixinConversationCommandNames = [
  "status",
  "new",
  "stop",
] as const satisfies readonly ConversationCommandName[];

type WeixinConversationCommandName =
  typeof weixinConversationCommandNames[number];

const weixinConversationCommandNameSet = new Set<string>(
  weixinConversationCommandNames,
);

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
      if (!isWeixinConversationCommandName(command.name)) {
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

function isWeixinConversationCommandName(
  value: string,
): value is WeixinConversationCommandName {
  return weixinConversationCommandNameSet.has(value);
}

function renderWeixinHelp(): string {
  return [
    "微信 Codex 基础命令",
    "/status 查看当前 Workspace、Thread 与运行状态",
    "/new 退出当前会话，下一条普通消息新建 Thread",
    "/stop 停止当前任务",
    "/whoami 查看当前微信连接身份",
    "/start · /help 查看本说明",
  ].join("\n");
}

function renderWeixinIdentity(message: WeixinConversationMessage): string {
  return [
    "微信身份",
    `用户 ID：${message.actorId}`,
    `会话 ID：${message.target.conversationId}`,
    `账号 ID：${message.target.accountId}`,
  ].join("\n");
}

function renderWeixinCommandResult(
  result: ConversationCommandResult,
): string {
  if (result.kind === "outcome") {
    return formatConversationCommandOutcome(result.outcome);
  }
  if (result.kind === "status") {
    return formatConversationStatus(result.status);
  }
  throw new Error("微信基础命令收到了不支持的结果类型");
}

function renderWeixinUserFacingError(error: UserFacingError): string {
  switch (error.code) {
    case "command.unsupported":
      return "不支持该微信命令，请发送 /help 查看可用命令";
    case "conversation.missing":
      return "当前还没有 Codex Thread";
    case "conversation.busy":
      return "当前任务运行中，请先使用 /stop 停止当前任务";
    default:
      return "Gateway 无法完成请求，请稍后重试";
  }
}

function formatWeixinCommandText(text: string): string {
  return text.replace(/(?:\r?\n)+/gu, "\n\n");
}

class WeixinOutputQueueError extends Error {
  constructor() {
    super("微信输出队列拒绝消息");
    this.name = "WeixinOutputQueueError";
  }
}
