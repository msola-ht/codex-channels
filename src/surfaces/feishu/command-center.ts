import { randomBytes } from "node:crypto";

import type { Logger } from "pino";

import {
  isConversationCommandName,
  type ConversationCommandName,
  type ModelSelectionRequest,
} from "../../application/index.js";
import { UserFacingError, type ConversationTarget } from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import { surfaceErrorMetadata } from "../error-metadata.js";
import { DeliveryReceipt } from "../delivery-receipt.js";
import {
  feishuCardElements,
  type FeishuCardDocument,
} from "./approval-card.js";
import {
  feishuCardButton,
  feishuCardColumnSetRow,
  feishuCardMarkdown,
  feishuCardPlainText,
  feishuCardShell,
} from "./card-kit.js";
import type { FeishuCardAction } from "./card-action.js";
import { FeishuExpiredCardActions } from "./card-action-expiry.js";
import { formatFeishuCommandMarkdown } from "./command-format.js";
import { conversationMenuAction } from "../conversation-command-catalog.js";
import { formatSurfaceConfigurationChange } from "../configuration-change-format.js";
import type { SurfaceConfigurationChange } from "../types.js";
import type { FeishuOutbox } from "./outbox.js";
import { renderFeishuConversationIdleReleasedCard } from "./idle-release-card.js";

export const feishuCommandMenuEventKey = "codexc_home";

const feishuLocalCommandActions = [
  "help",
  "whoami",
  "feishu-status",
  "feishu-doctor",
  "goal-set",
  "review-branch",
  "review-commit",
  "review-custom",
  "sessions-search",
  "archived-search",
  "thread-autoreview-select",
  "workspace-select",
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

export type FeishuCommandCenterActionResult =
  | "accepted"
  | "ignored"
  | "invalid";

export interface FeishuCommandCenterChoices {
  assertActive?: () => void;
  title: string;
  description?: string;
  descriptionFormat?: "plain_text" | "lark_md" | "markdown";
  choices: ReadonlyArray<{
    label: string;
    action: FeishuCommandCenterAction;
    input: string;
    acceptedState?: FeishuCommandAcceptedState;
    modelSelection?: ModelSelectionRequest;
  }>;
}

export interface FeishuModelSelectionInteraction {
  selection: ModelSelectionRequest;
  assertActive: () => void;
}

export interface FeishuCommandAcceptedState {
  title: string;
  description: string;
  template: "green" | "grey";
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
  acceptedStates: ReadonlyMap<string, FeishuCommandAcceptedState>;
  modelSelections: ReadonlyMap<string, ModelSelectionRequest>;
  form?: FeishuCommandCenterForm;
  consumeOnUse: boolean;
  limitsQueryInFlight?: boolean;
  assertActive?: () => void;
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
  private readonly expiredActions = new FeishuExpiredCardActions();
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
  private readonly cancellation = new AbortController();

  constructor(
    private readonly outbox: Pick<FeishuOutbox, "deliverCard">
      & Partial<Pick<FeishuOutbox, "updateCard">>,
    private readonly access: SurfaceAccessPolicy,
    private readonly execute: (
      target: ConversationTarget,
      action: FeishuCommandCenterAction,
      actorId: string,
      input: string,
      modelSelection?: FeishuModelSelectionInteraction,
      assertActive?: () => void,
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

  async openResponse(
    target: ConversationTarget,
    actorId: string,
    response: FeishuCommandCenterResponse,
    assertActive?: () => void,
    replaceMessageId?: string,
  ): Promise<void> {
    const responseGuard = "choices" in response ? response.assertActive : undefined;
    const guard = assertActive || responseGuard ? (): void => { assertActive?.(); responseGuard?.(); } : undefined;
    return this.openCard(
      target,
      actorId,
      (token) => "choices" in response
        ? renderFeishuCommandChoicesCard(token, response)
        : renderFeishuCommandFormCard(token, response),
      "choices" in response ? undefined : response,
      true,
      "choices" in response
        ? new Map(response.choices.flatMap((choice) =>
            choice.acceptedState
              ? [[selectionKey(choice.action, choice.input), choice.acceptedState] as const]
              : []
          ))
        : undefined,
      "choices" in response && response.choices.some(choice => choice.action === "thread-autoreview-select")
        ? Math.min(this.tokenTtlMs, 5 * 60_000)
        : this.tokenTtlMs,
      replaceMessageId && this.outbox.updateCard ? async card => {
        await this.outbox.updateCard!(target.conversationId, replaceMessageId, card);
        return replaceMessageId;
      } : undefined,
      "choices" in response
        ? new Map(response.choices.slice(0, 18).flatMap(choice => choice.modelSelection
          ? [[selectionKey(choice.action, choice.input), {
              ...choice.modelSelection,
              snapshot: { ...choice.modelSelection.snapshot },
            }] as const]
          : []))
        : new Map(),
      guard,
      responseGuard,
    );
  }

  deliverWorkspaceAdded(
    target: ConversationTarget,
    actorId: string,
    change: SurfaceConfigurationChange,
  ): Promise<void> {
    return this.track((async () => {
      if (this.closed || !this.access.isAllowed({ target, actorId })) {
        throw new Error("工作区通知接收者已不可用");
      }
      await this.openResponse(target, actorId, {
        title: "新增工作区",
        description: formatSurfaceConfigurationChange(change, "feishu", true).replace(/^## [^\n]+\n?/u, ""),
        descriptionFormat: "markdown",
        choices: change.addedWorkspaces.map(workspace => ({
          label: `切换到 ${workspace.name}`,
          action: "workspace-select",
          input: workspace.id,
        })),
      });
      if (this.closed || !this.access.isAllowed({ target, actorId })) {
        throw new Error("工作区通知投递期间接收者已不可用");
      }
    })());
  }

  deliverIdleReleased(
    target: ConversationTarget,
    actorId: string,
    minutes: number,
    threadId: string,
    sendCard: (card: FeishuCardDocument) => Promise<string>,
  ): Promise<void> {
    return this.track((async () => {
      if (this.closed || !this.access.isAllowed({ target, actorId })) {
        throw new Error("空闲解除通知接收者已不可用");
      }
      await this.openCard(
        target, actorId,
        token => renderFeishuConversationIdleReleasedCard(minutes, threadId, token),
        undefined, true, new Map(), this.tokenTtlMs, sendCard,
      );
    })());
  }

  private async openCard(
    target: ConversationTarget,
    actorId: string,
    render: (token: string) => FeishuCardDocument,
    form?: FeishuCommandCenterForm,
    consumeOnUse = false,
    acceptedStates: ReadonlyMap<string, FeishuCommandAcceptedState> = new Map(),
    tokenTtlMs = this.tokenTtlMs,
    sendCard: (card: FeishuCardDocument) => Promise<string> = card =>
      this.outbox.deliverCard(target.conversationId, card),
    modelSelections: ReadonlyMap<string, ModelSelectionRequest> = new Map(),
    assertActive?: () => void,
    selectionGuard?: () => void,
  ): Promise<void> {
    assertActive?.();
    if (
      this.closed
      || !this.access.isAllowed({ target, actorId })
    ) {
      return;
    }
    this.prune();
    const token = randomBytes(18).toString("base64url");
    const card = render(token);
    const receipt = assertActive ? new DeliveryReceipt(async () => {}, this.cancellation.signal, true, () => {
      assertActive();
      if (this.closed || !this.access.isAllowed({ target, actorId })) {
        throw new UserFacingError("command.authorization-changed", "卡片授权已变化");
      }
    }) : undefined;
    let messageId: string;
    try {
      messageId = await (receipt ? receipt.run(() => sendCard(card)) : sendCard(card));
    } finally { receipt?.release(); }
    await receipt?.done;
    assertActive?.();
    if (this.closed || !this.access.isAllowed({ target, actorId })) {
      return;
    }
    this.pending.set(token, {
      target,
      actorId,
      messageId,
      expiresAt: this.now() + tokenTtlMs,
      allowedSelections: collectCommandSelections(card, token),
      acceptedStates,
      modelSelections,
      ...(form ? { form } : {}),
      consumeOnUse,
      ...(selectionGuard ? { assertActive: selectionGuard } : {}),
    });
    while (this.pending.size > this.capacity) {
      const first = this.pending.entries().next();
      if (first.done) break;
      this.expiredActions.remember(first.value[0], first.value[1], this.now());
      this.pending.delete(first.value[0]);
    }
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
    if (!this.closed && token !== undefined
      && (action.tag === "button" || action.tag === "form_submit")) {
      const expired = this.expiredActions.take(token, action, this.access, this.now());
      if (expired) {
        void this.track(this.outbox.deliverCard(expired.conversationId,
          feishuCardShell("grey", "操作已失效", [
            feishuCardPlainText("按钮已过期或已处理，请发送 /help 重新打开命令中心。"),
          ])).catch(error => this.logger.warn(surfaceErrorMetadata(error), "飞书失效操作提示发送失败")));
        return "accepted";
      }
    }
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
      || !isBoundedCommandInput(resolvedCommand, input)
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
    const submittedSelection = submittedInput === undefined
      ? undefined
      : selectionKey(resolvedCommand, submittedInput);
    if (
      !pending
      || pending.messageId !== action.messageId
      || pending.target.conversationId !== action.chatId
      || pending.actorId !== action.actorOpenId
      || (
        !isFormAction
          ? !pending.allowedSelections.has(selectionKey(resolvedCommand, input))
          : submittedInput === undefined
      )
      || !this.access.isAllowed({
        target: pending.target,
        actorId: action.actorOpenId,
      })
    ) {
      return "invalid";
    }
    const isLimitsQuery = resolvedCommand === "limits"
      && submittedInput === ""
      && !pending.consumeOnUse;
    if (isLimitsQuery && pending.limitsQueryInFlight) {
      return "accepted";
    }
    if (isLimitsQuery) {
      pending.limitsQueryInFlight = true;
    }
    if (
      pending.consumeOnUse
      || commandCenterActionConsumesToken(resolvedCommand, submittedInput!)
    ) {
      this.expiredActions.remember(token, pending, this.now());
      this.pending.delete(token);
    }
    const acceptedState = submittedSelection === undefined
      ? undefined
      : pending.acceptedStates.get(submittedSelection);
    const selection = submittedSelection === undefined ? undefined : pending.modelSelections.get(submittedSelection);
    const modelSelection: FeishuModelSelectionInteraction | undefined = selection === undefined ? undefined : {
      selection,
      assertActive: () => {
        if (this.closed || pending.expiresAt <= this.now()
          || !this.access.isAllowed({ target: pending.target, actorId: pending.actorId })) {
          throw new UserFacingError("model.selection.expired", "模型选择已失效，请重新打开选择卡片");
        }
      },
    };
    const assertUsageActive = resolvedCommand === "usage" ? (): void => {
      if (this.closed || pending.expiresAt <= this.now() || !this.access.isAllowed({ target: pending.target, actorId: pending.actorId })) {
        throw new UserFacingError("command.authorization-changed", "用量卡片已失效，请重新执行 /usage");
      }
      pending.assertActive?.();
    } : undefined;
    if (acceptedState && this.outbox.updateCard) {
      void this.track(
        this.outbox.updateCard(
          pending.target.conversationId,
          pending.messageId,
          renderFeishuAcceptedStateCard(acceptedState),
        ).catch((error: unknown) => {
          this.logger.warn(
            {
              surface: pending.target.surface,
              accountId: pending.target.accountId,
              conversationId: pending.target.conversationId,
              action: resolvedCommand,
              ...surfaceErrorMetadata(error),
            },
            "飞书命令中心终态卡片更新失败",
          );
        }),
      );
    }
    void this.track(
      (async () => {
        try {
          if (resolvedCommand === "help") {
            await this.openCard(
              pending.target,
              pending.actorId,
              renderFeishuCategorizedCommandsCard,
            );
          } else {
            const response = await this.execute(
              pending.target,
              resolvedCommand,
              pending.actorId,
              submittedInput!,
              modelSelection,
              assertUsageActive,
            );
            modelSelection?.assertActive();
            if (response) {
              await this.openResponse(pending.target, pending.actorId, response, modelSelection?.assertActive ?? assertUsageActive,
                resolvedCommand === "usage" && pending.assertActive ? pending.messageId : undefined);
            }
          }
        } finally {
          if (isLimitsQuery) {
            pending.limitsQueryInFlight = false;
          }
        }
      })().catch((error: unknown) => {
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
    this.cancellation.abort();
    this.pending.clear();
    this.expiredActions.clear();
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
        this.expiredActions.remember(token, pending, now);
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
  if (selection.descriptionFormat === "markdown") {
    return feishuCardShell("blue", selection.title, [
      ...(selection.description
        ? [feishuCardMarkdown(formatFeishuCommandMarkdown(selection.description))]
        : []),
      ...cardKitChoiceRows(token, choices),
      ...(selection.choices.length > choices.length
        ? [feishuCardMarkdown(`仅显示前 ${choices.length} 项，请使用对应聊天命令查看更多选项。`)]
        : []),
    ]);
  }
  return feishuCardShell("blue", selection.title, [
    ...(selection.description
      ? selection.descriptionFormat === "lark_md"
        ? [feishuCardMarkdown(formatFeishuCommandMarkdown(selection.description))]
        : [feishuCardPlainText(selection.description)]
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
      ? [feishuCardPlainText(`仅显示前 ${choices.length} 项，请使用对应聊天命令查看更多选项。`)]
      : []),
  ]);
}

function cardKitChoiceRows(
  token: string,
  choices: ReadonlyArray<FeishuCommandCenterChoices["choices"][number]>,
): Array<Record<string, unknown>> {
  return chunkChoices(choices, 3).map((row, rowIndex) =>
    feishuCardColumnSetRow(row.map((choice, columnIndex) =>
      feishuCardButton(
        truncateChoiceLabel(choice.label),
        rowIndex === 0 && columnIndex === 0 ? "primary" : "default",
        commandValue(token, choice.action, choice.input),
      )
    ))
  );
}

function renderFeishuAcceptedStateCard(
  state: FeishuCommandAcceptedState,
): FeishuCardDocument {
  return feishuCardShell(state.template, state.title, [
    feishuCardMarkdown(formatFeishuCommandMarkdown(state.description)),
  ]);
}

function renderFeishuCommandFormCard(
  token: string,
  form: FeishuCommandCenterForm,
): FeishuCardDocument {
  return feishuCardShell("blue", form.title, [
    ...(form.description
      ? [feishuCardMarkdown(formatFeishuCommandMarkdown(form.description))]
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
  ]);
}

function renderFeishuCategorizedCommandsCard(
  token: string,
): FeishuCardDocument {
  return feishuCardShell("blue", "更多 Codex 命令", [
    sectionTitle("会话管理"),
    actionRow(token, [
      menuAction("sessions"),
      menuAction("archived"),
    ]),
    actionRow(token, [
      menuAction("archive"),
      menuAction("rename"),
      menuAction("fork"),
    ]),
    actionRow(token, [
      menuAction("pin"),
      menuAction("unpin"),
      menuAction("compact"),
    ]),
    sectionTitle("任务工具"),
    actionRow(token, [
      menuAction("plan", "切换 Plan 模式"),
      menuAction("schedule"),
    ]),
    actionRow(token, [
      menuAction("revert"),
    ]),
    actionRow(token, [
      menuAction("diff"),
      menuAction("review"),
    ]),
    sectionTitle("能力与集成"),
    actionRow(token, [
      menuAction("agents"),
      menuAction("skill"),
      menuAction("mcp"),
    ]),
    actionRow(token, [
      menuAction("plugin"),
      menuAction("hooks"),
    ]),
    sectionTitle("权限与诊断"),
    actionRow(token, [
      menuAction("autoreview"),
      menuAction("permissions"),
      menuAction("release"),
    ]),
    sectionTitle("飞书"),
    actionRow(token, [
      ["我的身份", "whoami", "default"],
      ["飞书状态", "feishu-status", "default"],
      ["Doctor", "feishu-doctor", "default"],
    ]),
    feishuCardPlainText("重命名和 Review 打开输入或选项；点击“切换 Plan 模式”会直接请求切换。发送 /help 返回命令中心。"),
  ]);
}

export function renderFeishuCommandCenterCard(
  token: string,
): FeishuCardDocument {
  return feishuCardShell("blue", "Codex 命令中心", [
    feishuCardPlainText("选择操作；普通文本仍会发送到当前 Codex Session。"),
    sectionTitle("当前任务"),
    actionRow(token, [
      menuAction("status"),
      menuAction("stop"),
      menuAction("new"),
    ]),
    sectionTitle("会话与工作区"),
    actionRow(token, [
      menuAction("resume", "恢复会话"),
      menuAction("workspace"),
    ]),
    sectionTitle("模型设置"),
    actionRow(token, [
      menuAction("model", "选择模型"),
      menuAction("effort"),
      menuAction("fast", "Fast"),
    ]),
    sectionTitle("用量与账户"),
    actionRow(token, [
      menuAction("usage"),
      menuAction("metrics"),
      menuAction("limits", "账户额度"),
    ]),
    sectionTitle("更多"),
    actionRow(token, [
      ["更多操作", "help", "default"],
    ]),
  ]);
}

/** Static canonical entries only; forms, navigation and allowed selections remain card-owned. */
function menuAction(command: ConversationCommandName, label?: string):
  readonly [string, ConversationCommandName, "default"] {
  const entry = conversationMenuAction(command);
  return [label ?? entry.label, entry.command, "default"];
}

function sectionTitle(title: string): Record<string, unknown> {
  return feishuCardMarkdown(`### ${title}`);
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
  return feishuCardColumnSetRow(actions.map(([label, action, type, input]) => ({
    tag: "button",
    text: {
      tag: "plain_text",
      content: label,
    },
    type,
    value: commandValue(token, action, input),
  })));
}

function commandValue(
  token: string,
  action: FeishuCommandCenterAction,
  input?: string,
): Record<string, string> {
  return {
    codexc_command_token: token,
    codexc_command: action,
    ...(input === undefined ? {} : { codexc_command_input: input }),
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

function commandCenterActionConsumesToken(
  action: FeishuCommandCenterAction,
  input: string,
): boolean {
  return directStateChangingActions.has(action)
    || action === "thread-autoreview-select"
    || (
      action === "queue"
      && /^(?:start|delete)\s+/u.test(input)
    )
    || (
      action === "schedule"
      && /^(?:confirm|pause|resume|run|retry)\s+/u.test(input)
    );
}

function collectCommandSelections(
  card: FeishuCardDocument,
  token: string,
): ReadonlySet<string> {
  const selections = new Set<string>();
  for (const value of collectCommandButtonValues(feishuCardElements(card))) {
    const command = value.codexc_command;
    const input = value.codexc_command_input ?? "";
    if (
      value.codexc_command_token === token
      && typeof command === "string"
      && isCommandCenterAction(command)
      && typeof input === "string"
      && isBoundedCommandInput(command, input)
    ) {
      selections.add(selectionKey(command, input));
    }
  }
  return selections;
}

function collectCommandButtonValues(
  value: unknown,
): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(collectCommandButtonValues);
  }
  if (!isUnknownRecord(value)) {
    return [];
  }
  const own = value.tag === "button" && isUnknownRecord(value.value)
    ? [value.value]
    : [];
  return [
    ...own,
    ...Object.values(value).flatMap(collectCommandButtonValues),
  ];
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

function isBoundedCommandInput(command: string, input: string): boolean {
  // 券 ID 最长 256 字符，另计规范命令前缀；其余命令保持原限制。
  return input.length <= (command === "limits" && input.startsWith("reset use ") ? 266 : 256);
}
