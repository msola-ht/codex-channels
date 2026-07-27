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
  FeishuCommandCenterForm,
  FeishuCommandCenterResponse,
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
    private readonly interactions?: {
      stopForActor(target: ConversationTarget, actorId: string): boolean;
    },
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
        if (
          command.name === "stop"
          && this.interactions?.stopForActor(message.target, message.actorId)
        ) {
          this.notifyText(
            message.target.conversationId,
            "已停止当前交互请求。",
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
  ): Promise<FeishuCommandCenterResponse | void> {
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
      const initialChoices = input === ""
        ? renderCommandCenterInitialChoices(action)
        : undefined;
      if (initialChoices) {
        return initialChoices;
      }
      const form = input === "" ? renderCommandCenterForm(action) : undefined;
      if (form) {
        return form;
      }
      if (!isConversationCommandName(action)) {
        throw new UserFacingError(
          "command.unsupported",
          "飞书命令不受支持",
        );
      }
      if (
        action === "stop"
        && this.interactions?.stopForActor(target, actorId)
      ) {
        this.notifyText(
          target.conversationId,
          "已停止当前交互请求。",
        );
        return;
      }
      const result = action === "fast" && input === ""
        ? await this.commands.execute(target, "model")
        : await this.commands.execute(target, action, input);
      const choices = (
        input === ""
        || action === "sessions"
        || action === "archived"
      )
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
        text: message.text?.trim().length
          ? message.text
          : "请查看这张图片并根据图片内容协助我。",
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

function renderCommandCenterInitialChoices(
  action: FeishuCommandCenterAction,
): FeishuCommandCenterChoices | undefined {
  if (action === "rules") {
    return {
      title: "项目规则",
      description: "仅操作当前已授权 Workspace 的项目规则。",
      choices: [
        { label: "生成并检查", action, input: "init" },
        { label: "仅检查", action, input: "check" },
      ],
    };
  }
  if (action === "review") {
    return {
      title: "开始 Review",
      description: "选择共享 Review 命令已有的目标类型。",
      choices: [
        { label: "未提交改动", action, input: " " },
        { label: "对比分支", action: "review-branch", input: "" },
        { label: "指定提交", action: "review-commit", input: "" },
        { label: "自定义说明", action: "review-custom", input: "" },
      ],
    };
  }
  if (action === "goal") {
    return {
      title: "Thread Goal",
      choices: [
        { label: "查看当前", action, input: " " },
        { label: "设置 Goal", action: "goal-set", input: "" },
        { label: "清除 Goal", action, input: "clear" },
      ],
    };
  }
  return undefined;
}

function renderCommandCenterForm(
  action: FeishuCommandCenterAction,
): FeishuCommandCenterForm | undefined {
  if (action === "sessions-search") {
    return {
      kind: "form",
      title: "搜索会话",
      description: "按会话名称、预览或 Thread ID 搜索。",
      action: "sessions",
      fieldLabel: "搜索词",
      placeholder: "请输入搜索词",
    };
  }
  if (action === "archived-search") {
    return {
      kind: "form",
      title: "搜索已归档会话",
      description: "按会话名称、预览或 Thread ID 搜索。",
      action: "archived",
      fieldLabel: "搜索词",
      placeholder: "请输入搜索词",
    };
  }
  if (action === "rename") {
    return {
      kind: "form",
      title: "重命名会话",
      description: "输入新的会话名称。",
      action,
      fieldLabel: "会话名称",
      placeholder: "例如：飞书私聊收口",
    };
  }
  if (action === "queue") {
    return {
      kind: "form",
      title: "追加下一 Turn",
      description: "内容会进入当前 Conversation 的有界内存队列。",
      action,
      fieldLabel: "补充要求",
      placeholder: "请输入下一轮需要继续处理的内容",
      multiline: true,
    };
  }
  if (action === "review-branch") {
    return {
      kind: "form",
      title: "Review 分支",
      action: "review",
      fieldLabel: "基准分支",
      placeholder: "例如：main",
      inputPrefix: "branch ",
    };
  }
  if (action === "review-commit") {
    return {
      kind: "form",
      title: "Review 提交",
      action: "review",
      fieldLabel: "Commit SHA",
      placeholder: "请输入提交 SHA",
      inputPrefix: "commit ",
    };
  }
  if (action === "review-custom") {
    return {
      kind: "form",
      title: "自定义 Review",
      action: "review",
      fieldLabel: "Review 说明",
      placeholder: "请输入审查范围和要求",
      inputPrefix: "custom ",
      multiline: true,
    };
  }
  if (action === "goal-set") {
    return {
      kind: "form",
      title: "设置 Thread Goal",
      action: "goal",
      fieldLabel: "目标",
      placeholder: "请输入当前 Thread 的目标",
      inputPrefix: "set ",
      multiline: true,
    };
  }
  return undefined;
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
      choices: [
        {
          label: "搜索会话…",
          action: "sessions-search",
          input: "",
        },
        ...result.sessions.map((session) => ({
          label: `${session.id === result.currentThreadId ? "✓ " : ""}${(session.name ?? session.preview) || "未命名"}`,
          action: "resume" as const,
          input: session.id,
        })),
      ],
    };
  }
  if (action === "archived" && result.kind === "sessions" && result.archived) {
    if (result.sessions.length === 0) {
      return undefined;
    }
    return {
      title: "恢复已归档会话",
      description: "点击后取消归档并切换到对应 Codex Thread。",
      choices: [
        {
          label: "搜索归档…",
          action: "archived-search",
          input: "",
        },
        ...result.sessions.map((session) => ({
          label: (session.name ?? session.preview) || "未命名",
          action: "unarchive" as const,
          input: session.id,
        })),
      ],
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
