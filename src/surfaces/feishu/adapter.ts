import {
  ConversationCommandService,
  fastServiceTierId,
  isConversationCommandName,
  isFastServiceTier,
  type ConversationCommandResult,
  type ConversationService,
} from "../../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
} from "../../conversation-core/index.js";

import type {
  FeishuCommandCenter,
  FeishuCommandCenterAction,
  FeishuCommandCenterChoices,
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
    actorId: string,
    input = "",
  ): Promise<FeishuCommandCenterChoices | void> {
    try {
      if (action === "help") {
        this.notifyMarkdown(target.conversationId, renderFeishuHelp());
        return;
      }
      if (action === "whoami") {
        this.notifyMarkdown(
          target.conversationId,
          renderFeishuIdentity({ target, actorId }),
        );
        return;
      }
      if (action === "feishu-status") {
        await this.handleFeishuCommand(
          actorId,
          target.accountId,
          target.conversationId,
          "status",
        );
        return;
      }
      if (action === "feishu-doctor") {
        await this.handleFeishuCommand(
          actorId,
          target.accountId,
          target.conversationId,
          "doctor",
        );
        return;
      }
      if (!isConversationCommandName(action)) {
        throw new UserFacingError(
          "command.unsupported",
          "飞书命令不受支持",
        );
      }
      const result = action === "fast" && input === ""
        ? await this.commands.execute(target, "model")
        : await this.commands.execute(target, action, input);
      const choices = input === ""
        ? renderCommandCenterChoices(action, result)
        : undefined;
      if (choices) {
        return choices;
      }
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

function renderCommandCenterChoices(
  action: FeishuCommandCenterAction,
  result: ConversationCommandResult,
): FeishuCommandCenterChoices | undefined {
  if (
    (action === "resume" || action === "sessions")
    && result.kind === "sessions"
    && !result.archived
  ) {
    if (result.sessions.length === 0) {
      return undefined;
    }
    return {
      title: "选择会话",
      description: "点击后切换到对应 Codex Thread。",
      choices: result.sessions.map((session) => ({
        label: `${session.id === result.currentThreadId ? "✓ " : ""}${(session.name ?? session.preview) || "未命名"}`,
        action: "resume",
        input: session.id,
      })),
    };
  }
  if (action === "archived" && result.kind === "sessions" && result.archived) {
    if (result.sessions.length === 0) {
      return undefined;
    }
    return {
      title: "恢复已归档会话",
      description: "点击后取消归档并切换到对应 Codex Thread。",
      choices: result.sessions.map((session) => ({
        label: (session.name ?? session.preview) || "未命名",
        action: "unarchive",
        input: session.id,
      })),
    };
  }
  if (action === "workspace" && result.kind === "workspaces") {
    if (result.workspaces.length === 0) {
      return undefined;
    }
    return {
      title: "选择工作区",
      choices: result.workspaces.map((workspace) => ({
        label: `${workspace.id === result.currentWorkspaceId ? "✓ " : ""}${workspace.name}`,
        action: "workspace",
        input: workspace.id,
      })),
    };
  }
  if (result.kind !== "models") {
    return undefined;
  }
  const currentModel = result.state.models.find(
    (model) => model.model === result.state.model,
  );
  if (action === "model") {
    if (result.state.models.length === 0) {
      return undefined;
    }
    return {
      title: "选择模型",
      description: `当前：${result.state.model}`,
      choices: result.state.models.map((model) => ({
        label: `${model.model === result.state.model ? "✓ " : ""}${model.displayName}`,
        action: "model",
        input: model.model,
      })),
    };
  }
  if (action === "effort") {
    const efforts = currentModel?.supportedReasoningEfforts ?? [];
    if (efforts.length === 0) {
      return undefined;
    }
    return {
      title: "选择思考强度",
      description: `当前：${result.state.effort ?? currentModel?.defaultReasoningEffort ?? "模型默认"}`,
      choices: efforts.map(
        (option) => ({
          label: `${option.effort === result.state.effort ? "✓ " : ""}${option.effort}`,
          action: "effort",
          input: option.effort,
        }),
      ),
    };
  }
  if (action === "fast") {
    const enabled = isFastServiceTier(
      result.state.serviceTier,
      currentModel,
    );
    return {
      title: "切换 Fast 模式",
      description: `当前：${enabled ? "开启" : "关闭"} · ${currentModel && fastServiceTierId(currentModel) ? "当前模型支持 Fast" : "当前模型不支持 Fast"}`,
      choices: [
        {
          label: `${enabled ? "✓ " : ""}开启`,
          action: "fast",
          input: "on",
        },
        {
          label: `${enabled ? "" : "✓ "}关闭`,
          action: "fast",
          input: "off",
        },
      ],
    };
  }
  return undefined;
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
