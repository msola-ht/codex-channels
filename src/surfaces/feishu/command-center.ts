import { randomBytes } from "node:crypto";

import type { Logger } from "pino";

import {
  isConversationCommandName,
  type ConversationCommandName,
} from "../../application/index.js";
import type { ConversationTarget } from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import { surfaceErrorMetadata } from "../error-metadata.js";
import {
  feishuCardElements,
  type FeishuCardDocument,
} from "./approval-card.js";
import type { FeishuCardAction } from "./card-action.js";
import type { FeishuOutbox } from "./outbox.js";

export const feishuCommandMenuEventKey = "codexc_home";

const feishuLocalCommandActions = [
  "help",
  "whoami",
  "feishu-status",
  "feishu-doctor",
  "goal-set",
  "workspace-perm-profile",
  "review-branch",
  "review-commit",
  "review-custom",
  "sessions-search",
  "archived-search",
] as const;

export type FeishuCommandCenterAction =
  | ConversationCommandName
  | typeof feishuLocalCommandActions[number];

const directStateChangingActions = new Set<FeishuCommandCenterAction>([
  "new",
  "stop",
  "archive",
  "pin",
  "unpin",
  "compact",
  "fork",
  "plan",
]);

export const feishuCommandCenterActions = [
  "new",
  "resume",
  "status",
  "fast",
  "usage",
  "metrics",
  "limits",
  "model",
  "effort",
  "workspace",
  "goal",
  "plan",
  "help",
] as const satisfies ReadonlyArray<FeishuCommandCenterAction>;

export type FeishuCommandCenterActionResult =
  | "accepted"
  | "ignored"
  | "invalid";

export interface FeishuCommandCenterChoices {
  title: string;
  description?: string;
  choices: ReadonlyArray<{
    label: string;
    action: FeishuCommandCenterAction;
    input: string;
  }>;
}

export interface FeishuCommandCenterForm {
  kind: "form";
  title: string;
  description?: string;
  action: FeishuCommandCenterAction;
  fieldLabel: string;
  placeholder?: string;
  inputPrefix?: string;
  multiline?: boolean;
}

export type FeishuCommandCenterResponse =
  | FeishuCommandCenterChoices
  | FeishuCommandCenterForm;

interface PendingCommandCenter {
  target: ConversationTarget;
  actorId: string;
  messageId: string;
  expiresAt: number;
  allowedSelections: ReadonlySet<string>;
  form?: FeishuCommandCenterForm;
  consumeOnUse: boolean;
}

interface FeishuCommandCenterOptions {
  tokenTtlMs?: number;
  capacity?: number;
  eventDeduplicationTtlMs?: number;
  eventDeduplicationCapacity?: number;
  closeTimeoutMs?: number;
  now?: () => number;
}

export class FeishuCommandCenter {
  private readonly pending = new Map<string, PendingCommandCenter>();
  private readonly seenMenuEvents = new Map<string, number>();
  private readonly tokenTtlMs: number;
  private readonly capacity: number;
  private readonly eventDeduplicationTtlMs: number;
  private readonly eventDeduplicationCapacity: number;
  private readonly closeTimeoutMs: number;
  private readonly now: () => number;
  private readonly tasks = new Set<Promise<unknown>>();
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly outbox: Pick<FeishuOutbox, "deliverCard">,
    private readonly access: SurfaceAccessPolicy,
    private readonly execute: (
      target: ConversationTarget,
      action: FeishuCommandCenterAction,
      actorId: string,
      input: string,
    ) => Promise<FeishuCommandCenterResponse | void>,
    private readonly logger: Logger,
    options: FeishuCommandCenterOptions = {},
  ) {
    this.tokenTtlMs = options.tokenTtlMs ?? 10 * 60_000;
    this.capacity = options.capacity ?? 100;
    this.eventDeduplicationTtlMs =
      options.eventDeduplicationTtlMs ?? 10 * 60_000;
    this.eventDeduplicationCapacity =
      options.eventDeduplicationCapacity ?? 1_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  async open(
    target: ConversationTarget,
    actorId: string,
  ): Promise<void> {
    return this.openCard(
      target,
      actorId,
      renderFeishuCommandCenterCard,
    );
  }

  private async openCard(
    target: ConversationTarget,
    actorId: string,
    render: (token: string) => FeishuCardDocument,
    form?: FeishuCommandCenterForm,
    consumeOnUse = false,
  ): Promise<void> {
    if (
      this.closed
      || !this.access.isAllowed({ target, actorId })
    ) {
      return;
    }
    this.prune();
    const token = randomBytes(18).toString("base64url");
    const card = render(token);
    const messageId = await this.outbox.deliverCard(
      target.conversationId,
      card,
    );
    if (this.closed) {
      return;
    }
    this.pending.set(token, {
      target,
      actorId,
      messageId,
      expiresAt: this.now() + this.tokenTtlMs,
      allowedSelections: collectCommandSelections(card, token),
      ...(form ? { form } : {}),
      consumeOnUse,
    });
    this.trimOldest(this.pending, this.capacity);
  }

  openFromMenu(
    target: ConversationTarget,
    actorId: string,
    eventId: string,
  ): Promise<void> {
    return this.track(this.openFromMenuOnce(target, actorId, eventId));
  }

  private async openFromMenuOnce(
    target: ConversationTarget,
    actorId: string,
    eventId: string,
  ): Promise<void> {
    this.prune();
    if (this.seenMenuEvents.has(eventId)) {
      return;
    }
    this.seenMenuEvents.set(
      eventId,
      this.now() + this.eventDeduplicationTtlMs,
    );
    this.trimOldest(
      this.seenMenuEvents,
      this.eventDeduplicationCapacity,
    );
    try {
      await this.open(target, actorId);
    } catch (error) {
      this.seenMenuEvents.delete(eventId);
      throw error;
    }
  }

  handleCardAction(
    action: FeishuCardAction,
  ): FeishuCommandCenterActionResult {
    const token = action.value.codexc_command_token;
    const command = action.value.codexc_command;
    const input = action.value.codexc_command_input ?? "";
    const isFormAction = action.formValues !== undefined;
    if (token === undefined && command === undefined) {
      return "ignored";
    }
    this.prune();
    const pending = token === undefined
      ? undefined
      : this.pending.get(token);
    const resolvedCommand = command
      ?? (isFormAction ? pending?.form?.action : undefined);
    if (
      this.closed
      || (action.tag !== "button" && action.tag !== "form_submit")
      || token === undefined
      || resolvedCommand === undefined
      || input.length > 256
      || !isCommandCenterAction(resolvedCommand)
    ) {
      return "invalid";
    }
    const submittedInput = !isFormAction
      ? input
      : resolveFormInput(
          pending?.form,
          resolvedCommand,
          action.formValues!,
        );
    if (
      !pending
      || pending.messageId !== action.messageId
      || pending.target.conversationId !== action.chatId
      || pending.actorId !== action.actorOpenId
      || (
        !isFormAction
          ? !pending.allowedSelections.has(
              selectionKey(resolvedCommand, input),
            )
          : submittedInput === undefined
      )
      || !this.access.isAllowed({
        target: pending.target,
        actorId: action.actorOpenId,
      })
    ) {
      return "invalid";
    }
    if (
      pending.consumeOnUse
      || directStateChangingActions.has(resolvedCommand)
    ) {
      this.pending.delete(token);
    }
    void this.track(
      (resolvedCommand === "help"
        ? this.openCard(
            pending.target,
            pending.actorId,
            renderFeishuCategorizedCommandsCard,
          )
        : this.execute(
            pending.target,
            resolvedCommand,
            pending.actorId,
            submittedInput!,
          ).then((response) =>
            response
              ? this.openCard(
                  pending.target,
                  pending.actorId,
                  (nextToken) => "choices" in response
                    ? renderFeishuCommandChoicesCard(nextToken, response)
                    : renderFeishuCommandFormCard(nextToken, response),
                  "choices" in response ? undefined : response,
                  true,
                )
              : undefined
          )
      ).catch((error: unknown) => {
        this.logger.warn(
          {
            surface: pending.target.surface,
            accountId: pending.target.accountId,
            conversationId: pending.target.conversationId,
            action: resolvedCommand,
            ...surfaceErrorMetadata(error),
          },
          "飞书命令中心动作执行失败",
        );
      }),
    );
    return "accepted";
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    this.pending.clear();
    this.seenMenuEvents.clear();
    if (this.tasks.size === 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const completed = Promise.allSettled([...this.tasks]);
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.closeTimeoutMs);
    });
    await Promise.race([completed, timedOut]);
    if (timer) {
      clearTimeout(timer);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [token, pending] of this.pending) {
      if (pending.expiresAt <= now) {
        this.pending.delete(token);
      }
    }
    for (const [eventId, expiresAt] of this.seenMenuEvents) {
      if (expiresAt <= now) {
        this.seenMenuEvents.delete(eventId);
      }
    }
  }

  private trimOldest<K, V>(map: Map<K, V>, capacity: number): void {
    while (map.size > capacity) {
      const first = map.keys().next();
      if (first.done) {
        return;
      }
      map.delete(first.value);
    }
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
}

function renderFeishuCommandChoicesCard(
  token: string,
  selection: FeishuCommandCenterChoices,
): FeishuCardDocument {
  const choices = selection.choices.slice(0, 18);
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: selection.title,
      },
    },
    elements: [
      ...(selection.description
        ? [{
            tag: "div",
            text: {
              tag: "plain_text",
              content: selection.description,
            },
          }]
        : []),
      ...chunkChoices(choices, 3).map((row) =>
        actionRow(
          token,
          row.map((choice) => [
            truncateChoiceLabel(choice.label),
            choice.action,
            "default",
            choice.input,
          ]),
        )
      ),
      ...(selection.choices.length > choices.length
        ? [{
            tag: "div",
            text: {
              tag: "plain_text",
              content: `仅显示前 ${choices.length} 项，请使用对应聊天命令查看更多选项。`,
            },
          }]
        : []),
    ],
  };
}

function renderFeishuCommandFormCard(
  token: string,
  form: FeishuCommandCenterForm,
): FeishuCardDocument {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: form.title,
      },
    },
    body: {
      elements: [
        ...(form.description
          ? [{
              tag: "markdown",
              content: form.description,
            }]
          : []),
        {
          tag: "form",
          name: "codexc_command_form",
          elements: [
            {
              tag: "input",
              name: "input",
              required: true,
              input_type: "multiline_text",
              rows: form.multiline ? 3 : 1,
              auto_resize: true,
              max_rows: form.multiline ? 8 : 1,
              max_length: 1_000,
              width: "fill",
              label: {
                tag: "plain_text",
                content: form.fieldLabel,
              },
              label_position: "top",
              ...(form.placeholder
                ? {
                    placeholder: {
                      tag: "plain_text",
                      content: form.placeholder,
                    },
                  }
                : {}),
            },
            {
              tag: "button",
              type: "primary",
              text: {
                tag: "plain_text",
                content: "确认",
              },
              name: `codexc_command_submit_${token}`,
              form_action_type: "submit",
              value: {
                codexc_command_token: token,
                codexc_command: form.action,
              },
            },
          ],
        },
      ],
    },
  };
}

function renderFeishuCategorizedCommandsCard(
  token: string,
): FeishuCardDocument {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "更多 Codex 命令",
      },
    },
    elements: [
      sectionTitle("会话查询"),
      actionRow(token, [
        ["会话列表", "sessions", "primary"],
        ["已归档", "archived", "default"],
      ]),
      sectionTitle("会话操作"),
      actionRow(token, [
        ["停止任务", "stop", "default"],
        ["归档当前", "archive", "default"],
        ["压缩上下文", "compact", "default"],
      ]),
      actionRow(token, [
        ["分叉会话", "fork", "default"],
        ["重命名", "rename", "default"],
        ["写入 App Server Queue", "queue", "default"],
        ["释放占用", "release", "default"],
      ]),
      actionRow(token, [
        ["固定会话", "pin", "default"],
        ["取消固定", "unpin", "default"],
        ["Thread 分区", "section", "default"],
      ]),
      sectionTitle("能力与集成"),
      actionRow(token, [
        ["子代理", "agents", "default"],
        ["Skills", "skill", "default"],
        ["MCP", "mcp", "default"],
        ["Plugin", "plugin", "default"],
      ]),
      sectionTitle("当前内容"),
      actionRow(token, [
        ["工作区权限", "workspaceperm", "default"],
        ["权限", "permissions", "default"],
        ["Diff", "diff", "default"],
        ["项目规则", "rules", "default"],
        ["Review", "review", "default"],
      ]),
      sectionTitle("飞书"),
      actionRow(token, [
        ["我的身份", "whoami", "default"],
        ["飞书状态", "feishu-status", "default"],
        ["Doctor", "feishu-doctor", "default"],
      ]),
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: "带文本参数的命令将在下一步打开输入卡片。",
        },
      },
    ],
  };
}

export function renderFeishuCommandCenterCard(
  token: string,
): FeishuCardDocument {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "Codex 命令中心",
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: "选择操作；普通文本仍会发送到当前 Codex Thread。",
        },
      },
      sectionTitle("常用"),
      actionRow(token, [
        ["新会话", "new", "primary"],
        ["会话切换", "resume", "default"],
        ["当前状态", "status", "default"],
      ]),
      actionRow(token, [
        ["Fast", "fast", "primary"],
        ["账户用量", "usage", "default"],
        ["请求指标", "metrics", "default"],
        ["额度", "limits", "default"],
      ]),
      sectionTitle("模型与工作区"),
      actionRow(token, [
        ["模型设置", "model", "default"],
        ["思考等级", "effort", "default"],
        ["工作区", "workspace", "default"],
      ]),
      actionRow(token, [
        ["Goal", "goal", "default"],
        ["Plan 模式", "plan", "default"],
      ]),
      sectionTitle("更多"),
      actionRow(token, [
        ["更多命令", "help", "default"],
      ]),
    ],
  };
}

function sectionTitle(title: string): Record<string, unknown> {
  return {
    tag: "div",
    text: {
      tag: "lark_md",
      content: `**${title}**`,
    },
  };
}

function actionRow(
  token: string,
  actions: ReadonlyArray<readonly [
    label: string,
    action: FeishuCommandCenterAction,
    type: "primary" | "default",
    input?: string,
  ]>,
): Record<string, unknown> {
  return {
    tag: "action",
    actions: actions.map(([label, action, type, input]) => ({
      tag: "button",
      text: {
        tag: "plain_text",
        content: label,
      },
      type,
      value: {
        codexc_command_token: token,
        codexc_command: action,
        ...(input === undefined
          ? {}
          : { codexc_command_input: input }),
      },
    })),
  };
}

function chunkChoices<T>(
  values: readonly T[],
  size: number,
): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function truncateChoiceLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 32
    ? `${normalized.slice(0, 31)}…`
    : normalized;
}

function isCommandCenterAction(
  value: string,
): value is FeishuCommandCenterAction {
  return isConversationCommandName(value)
    || feishuLocalCommandActions.includes(
      value as typeof feishuLocalCommandActions[number],
    );
}

function collectCommandSelections(
  card: FeishuCardDocument,
  token: string,
): ReadonlySet<string> {
  const selections = new Set<string>();
  for (const element of feishuCardElements(card)) {
    const actions: readonly unknown[] = Array.isArray(element.actions)
      ? element.actions as unknown[]
      : [];
    if (actions.length === 0) {
      continue;
    }
    for (const action of actions) {
      if (
        !isUnknownRecord(action)
        || !isUnknownRecord(action.value)
      ) {
        continue;
      }
      const value = action.value;
      const command = value.codexc_command;
      const input = value.codexc_command_input ?? "";
      if (
        value.codexc_command_token === token
        && typeof command === "string"
        && isCommandCenterAction(command)
        && typeof input === "string"
        && input.length <= 256
      ) {
        selections.add(selectionKey(command, input));
      }
    }
  }
  return selections;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function selectionKey(
  action: FeishuCommandCenterAction,
  input: string,
): string {
  return `${action}\u0000${input}`;
}

function resolveFormInput(
  form: FeishuCommandCenterForm | undefined,
  action: FeishuCommandCenterAction,
  values: Readonly<Record<string, string>>,
): string | undefined {
  if (
    !form
    || form.action !== action
    || Object.keys(values).length !== 1
  ) {
    return undefined;
  }
  const value = values.input?.trim();
  if (!value || value.length > 1_000) {
    return undefined;
  }
  return `${form.inputPrefix ?? ""}${value}`;
}
