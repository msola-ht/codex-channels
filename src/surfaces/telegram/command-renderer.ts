import { createHash, randomBytes } from "node:crypto";

import type { Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

import type {
  ConversationCommandResult,
  ModelSelectionState,
} from "../../application/index.js";
import {
  listProviders,
} from "../../application/index.js";
import { formatCodexProviderLabel, formatProviderModelSummary, modelListDisplayName } from "../provider-format.js";
import { toStructuredMarkdownList } from "../markdown-list.js";
import { formatReasoningEffort } from "../reasoning-effort-format.js";
import { renderConversationCommandResult } from "../conversation-command-renderer.js";
import { formatConversationHooks, hookCommandChoices } from "../conversation-hook-command-format.js";
import {
  formatConversationPlugins,
} from "../conversation-extension-command-format.js";
import {
  formatConversationLimits,
  formatConversationResetCredits,
  formatConversationModels,
  formatConversationModelState,
  formatModelSettingLiteral,
} from "../conversation-model-account-command-format.js";
import {
  formatConversationThreadQueue,
  formatThreadQueueInputTypeLabel,
  isTurnLifecycleAcknowledgedOutcome,
} from "../conversation-session-command-format.js";
import {
  formatConversationScheduledConfirmation,
} from "../conversation-scheduled-task-command-format.js";
import {
  formatConversationArtifacts,
  formatConversationPermissions,
  formatConversationWorkspaces,
} from "../conversation-workspace-status-command-format.js";
import { formatConversationCommandOutcome } from "../conversation-command-outcome-format.js";
import { formatStatus } from "./format.js";
import { formatTelegramDiffChunks, formatTelegramLiteralPanelChunks, formatTelegramPanelChunks } from "./html-format.js";

export async function renderTelegramCommandResult(
  context: Context,
  result: ConversationCommandResult,
  reply: Context["reply"] = context.reply.bind(context),
): Promise<void> {
  const panel = (text: string, markup?: InlineKeyboardMarkup): Promise<void> =>
    replyTelegramPanel(context, text, markup, reply);
  switch (result.kind) {
    case "outcome": {
      if (isTurnLifecycleAcknowledgedOutcome(result.outcome)) {
        return;
      }
      const rendered = renderOutcome(result.outcome);
      if (rendered.expanded) {
        await panel(rendered.text);
      } else {
        await reply(rendered.text);
      }
      return;
    }
    case "thread-queue":
      await panel(
        [
          formatConversationThreadQueue(result),
          "",
          "按钮支持分页、刷新和进入条目后启动/删除；新增、更新、排序请继续使用 /queue 文本命令。",
        ].join("\n"),
        threadQueueKeyboard(result),
      );
      return;
    case "scheduled-confirmation":
      await panel(
        formatConversationScheduledConfirmation(result),
        scheduledTaskConfirmationKeyboard(result),
      );
      return;
    case "status": {
      const [title, ...fields] = formatStatus(result.status, result).split("\n");
      const markup = {
        inline_keyboard: [[
          { text: "请求统计", callback_data: "status-query:metrics" },
          { text: "账户用量", callback_data: "status-query:usage" },
          { text: "账户额度", callback_data: "status-query:limits" },
        ]],
      };
      // Metadata labels and values are literal; only the shared panel structure
      // becomes HTML. Do not interpret account window names as Markdown.
      const chunks = formatTelegramLiteralPanelChunks(title!.replace(/^## /u, ""), fields.map(line => line.replace(/^- /u, "• ")).join("\n"));
      for (const [index, chunk] of chunks.entries()) {
        await reply(chunk, { parse_mode: "HTML", ...(index === 0
          ? { reply_markup: markup } : { disable_notification: true }) });
      }
      return;
    }
    case "workspaces":
      await panel(
        formatConversationWorkspaces(result),
        workspaceSelectionKeyboard(result),
      );
      return;
    case "models":
      if (result.view === "model") {
        const providerOnly = result.state.providerFilter === undefined;
        await panel(
          providerOnly
            ? modelProviderSelectionText(result)
            : formatConversationModels(result),
          providerOnly
            ? modelProviderSelectionKeyboard(result, String(context.from?.id ?? ""))
            : modelSelectionKeyboard(result, String(context.from?.id ?? "")),
        );
      } else {
        await panel(
          formatConversationModels(result),
          modelEffortKeyboard(result, String(context.from?.id ?? "")),
        );
      }
      return;
    case "plugins":
      await panel(
        formatConversationPlugins(result),
        pluginKeyboard(result),
      );
      return;
    case "hooks": {
      const [title, ...body] = formatConversationHooks(result.view).split("\n");
      const chunks = formatTelegramLiteralPanelChunks(title!, body.join("\n"));
      for (const [index, chunk] of chunks.entries()) {
        await reply(chunk, {
          parse_mode: "HTML",
          ...(index === chunks.length - 1 ? { reply_markup: hookKeyboard(result) } : {}),
          ...(index > 0 ? { disable_notification: true } : {}),
        });
      }
      return;
    }
    case "reset-credit":
      await panel(formatConversationResetCredits(result, "buttons", value => value),
        resetCreditKeyboard(result, String(context.chat?.id ?? ""), String(context.from?.id ?? "")));
      return;
    case "limits":
      await panel(formatConversationLimits(result), result.result.kind === "rate-limits"
        ? { inline_keyboard: [[{ text: "查看重置券", callback_data: "rc:page:1" }]] } : undefined);
      return;
    case "permissions":
      await panel(
        formatConversationPermissions(result),
      );
      return;
    case "artifacts":
      for (const [index, chunk] of formatTelegramDiffChunks(
        formatConversationArtifacts(result),
      ).entries()) {
        await reply(chunk, {
          parse_mode: "HTML",
          ...(index === 0 ? {} : { disable_notification: true }),
        });
      }
      return;
  }
  const text = renderConversationCommandResult(result);
  if (text !== null) await panel(text);
}

export function hookKeyboard(
  result: Extract<ConversationCommandResult, { kind: "hooks" }>,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: hookCommandChoices(result.view).map(choice => [{
      text: choice.label,
      callback_data: `hooks:${choice.input.replace(" ", ":")}`,
    }]),
  };
}

export function threadAutoReviewKeyboard(token: string): InlineKeyboardMarkup {
  return { inline_keyboard: [[
    { text: "当前会话：自动审批", callback_data: `tar:on:${token}` },
    { text: "当前会话：手动审批", callback_data: `tar:off:${token}` },
  ]] };
}

export function workspaceSelectionKeyboard(
  result: Extract<ConversationCommandResult, { kind: "workspaces" }>,
): InlineKeyboardMarkup | undefined {
  if (result.workspaces.length === 0) return undefined;
  return {
    inline_keyboard: result.workspaces.map((workspace) => [{
      text: boundedButtonLabel(`${workspace.id === result.currentWorkspaceId ? "✓ " : ""}切换到 ${formatModelSettingLiteral(workspace.name)}`),
      callback_data: `ws:${telegramWorkspaceSwitchToken(workspace.id)}`,
    }]),
  };
}

export function telegramWorkspaceSwitchToken(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("base64url");
}

export function modelEffortKeyboard(
  result: Extract<ConversationCommandResult, { kind: "models" }>,
  actorId = "",
): InlineKeyboardMarkup | undefined {
  if (result.view !== "effort") {
    return undefined;
  }
  const model = result.state.models.find((candidate) =>
    candidate.model === result.state.model
    && (candidate.provider ?? "openai") === (result.state.modelProvider ?? "openai"));
  if (!model || model.supportedReasoningEfforts.length <= 1) {
    return undefined;
  }
  const token = telegramModelSelectionToken(result.state, actorId);
  return {
    inline_keyboard: model.supportedReasoningEfforts.map((option, index) => [{
      text: `${option.effort === result.state.effort ? "✓ " : ""}${formatModelSettingLiteral(formatReasoningEffort(option.effort))}`,
      callback_data: `me:${index + 1}:${token}`,
    }]),
  };
}

function modelProviderSelectionText(
  result: Extract<ConversationCommandResult, { kind: "models" }>,
): string {
  const providers = listProviders(result.state.models);
  const current = result.state.modelProvider ?? "openai";
  return toStructuredMarkdownList([
    "## 选择提供商",
    ...formatConversationModelState(result).map(line => `- ${line}`),
    "",
    ...(providers.length > 0 ? ["提供商列表："] : [
      "当前没有可选模型。请检查账户配置与订阅状态；续订后可在 WebUI 或当前账户的 /usage 刷新。",
    ]),
    ...providers.map((provider, index) =>
      `${index + 1}. ${formatModelSettingLiteral(formatCodexProviderLabel(provider))}${provider === current ? " ← 当前" : ""} · ${formatProviderModelSummary(result.state.models, provider)}`),
    "",
    ...(providers.length > 0
      ? ["请先选择提供商，再选择该提供商下的模型；也可输入 /model <提供商序号>。"]
      : []),
  ].join("\n"));
}

export function modelProviderSelectionKeyboard(
  result: Extract<ConversationCommandResult, { kind: "models" }>,
  actorId = "",
): InlineKeyboardMarkup | undefined {
  if (
    result.view !== "model"
    || result.state.providerFilter !== undefined
    || result.state.models.length === 0
  ) {
    return undefined;
  }
  const providers = listProviders(result.state.models);
  const current = result.state.modelProvider ?? "openai";
  const token = telegramModelSelectionToken(result.state, actorId);
  return {
    inline_keyboard: providers.map((provider, index) => [{
      text: boundedButtonLabel(
        `${provider === current ? "✓ " : ""}${formatModelSettingLiteral(formatCodexProviderLabel(provider))}`,
      ),
      callback_data: `mp:${index + 1}:${token}`,
    }]),
  };
}

export function modelSelectionKeyboard(
  result: Extract<ConversationCommandResult, { kind: "models" }>,
  actorId = "",
): InlineKeyboardMarkup | undefined {
  const models = result.state.providerFilter === undefined
    ? result.state.models
    : result.state.models.filter(
        (model) => (model.provider ?? "openai") === result.state.providerFilter,
      );
  if (result.view !== "model" || models.length === 0) {
    return undefined;
  }
  const token = telegramModelSelectionToken(result.state, actorId);
  return {
    inline_keyboard: models.map((model, index) => [{
      text: boundedButtonLabel(
        `${model.model === result.state.model && (model.provider ?? "openai") === (result.state.modelProvider ?? "openai") ? "✓ " : ""}${formatModelSettingLiteral(modelListDisplayName(model.displayName, model.provider, model.model, index + 1))}${model.available === false ? "（暂不可用）" : ""}`,
      ),
      callback_data: `ms:${index + 1}:${token}`,
    }]),
  };
}

const maximumModelSelectionSnapshots = 1_000;
const modelSelectionTokens = new Map<string, string>();

export function telegramModelSelectionToken(state: ModelSelectionState, actorId = ""): string {
  const key = JSON.stringify([
    state.selectionScope ?? null, actorId,
    state.model, state.modelProvider ?? "openai", state.providerFilter ?? null,
    state.models.map((model) => [
      model.id, model.model, model.provider ?? "openai", model.available !== false,
      model.supportedReasoningEfforts.map((option) => option.effort),
    ]),
  ]);
  const existing = modelSelectionTokens.get(key);
  if (existing !== undefined) return existing;
  const token = randomBytes(32).toString("base64url");
  modelSelectionTokens.set(key, token);
  if (modelSelectionTokens.size > maximumModelSelectionSnapshots) {
    modelSelectionTokens.delete(modelSelectionTokens.keys().next().value!);
  }
  return token;
}

export function scheduledTaskConfirmationKeyboard(
  result: Extract<ConversationCommandResult, { kind: "scheduled-confirmation" }>,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      {
        text: "确认",
        callback_data: `schedule:confirm:${result.preview.token}`,
      },
      { text: "取消", callback_data: "schedule:cancel" },
    ]],
  };
}

export function pluginKeyboard(
  result: Extract<ConversationCommandResult, { kind: "plugins" }>,
): InlineKeyboardMarkup | undefined {
  const pluginRows = result.plugins.flatMap((plugin, index) => {
    const selector = result.selectors[index];
    return plugin.enabled && plugin.available && selector
      ? [[{
          text: boundedButtonLabel(plugin.displayName),
          callback_data: `plugin:select:${telegramPluginSelectionToken(plugin.id)}`,
        }]]
      : [];
  });
  const pageButtons = result.searchTerm === null
    ? [
        ...(result.page > 1
          ? [{ text: "上一页", callback_data: `plugin:page:${result.page - 1}` }]
          : []),
        ...(result.page < result.pageCount
          ? [{ text: "下一页", callback_data: `plugin:page:${result.page + 1}` }]
          : []),
      ]
    : [];
  const inlineKeyboard = [
    ...pluginRows,
    ...(pageButtons.length > 0 ? [pageButtons] : []),
  ];
  return inlineKeyboard.length > 0
    ? { inline_keyboard: inlineKeyboard }
    : undefined;
}

export function telegramPluginSelectionToken(pluginId: string): string {
  return createHash("sha256").update(pluginId).digest("base64url");
}

export function threadQueueKeyboard(
  result: Extract<ConversationCommandResult, { kind: "thread-queue" }>,
): InlineKeyboardMarkup | undefined {
  if (
    result.result.page > result.result.pageCount
    || result.result.items.length === 0
  ) {
    return result.result.totalItemCount === 0
      ? {
          inline_keyboard: [[{
            text: "刷新",
            callback_data: `queue:refresh:${result.result.page}`,
          }]],
        }
      : undefined;
  }
  const rows = result.result.items.flatMap((item) => {
    const callbackData = `queue:item:${result.result.page}:${item.id}`;
    return callbackData.length <= 64
      ? [[{
          text: boundedButtonLabel(queueItemButtonLabel(item)),
          callback_data: callbackData,
        }]]
      : [];
  });
  const pageButtons = [
    ...(result.result.page > 1
      ? [{
          text: "上一页",
          callback_data: `queue:page:${result.result.page - 1}`,
        }]
      : []),
    {
      text: "刷新",
      callback_data: `queue:refresh:${result.result.page}`,
    },
    ...(result.result.page < result.result.pageCount
      ? [{
          text: "下一页",
          callback_data: `queue:page:${result.result.page + 1}`,
        }]
      : []),
  ];
  return pageButtons.length > 0
    ? { inline_keyboard: [...rows, pageButtons] }
    : undefined;
}

export function threadQueueItemKeyboard(
  page: number,
  itemId: string,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "启动",
          callback_data: `queue:start:${page}:${itemId}`,
        },
        {
          text: "删除",
          callback_data: `queue:delete-confirm:${page}:${itemId}`,
        },
      ],
      [{
        text: "返回 Queue 列表",
        callback_data: `queue:refresh:${page}`,
      }],
    ],
  };
}

export function threadQueueDeleteConfirmationKeyboard(
  page: number,
  itemId: string,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      {
        text: "确认删除",
        callback_data: `queue:delete:${page}:${itemId}`,
      },
      {
        text: "取消",
        callback_data: `queue:item:${page}:${itemId}`,
      },
    ]],
  };
}

export function formatTelegramThreadQueueItemAction(
  item: Extract<ConversationCommandResult, { kind: "thread-queue" }>["result"]["items"][number],
): string {
  return [
    "## Queue 条目",
    `ID：${item.id}`,
    `类型：${formatThreadQueueInputTypeLabel(item.inputType)}${item.editable ? " · 可更新" : " · 只读摘要"}`,
    `安全预览：${item.textPreview || "（无文本预览）"}`,
    "",
    "请选择操作：",
  ].join("\n");
}

export function formatTelegramThreadQueueDeleteConfirmation(
  item: Extract<ConversationCommandResult, { kind: "thread-queue" }>["result"]["items"][number],
): string {
  return [
    "## 确认删除 Queue 条目？",
    `ID：${item.id}`,
    `安全预览：${item.textPreview || "（无文本预览）"}`,
    "删除后无法通过 Gateway 恢复。",
  ].join("\n");
}


function renderOutcome(
  outcome: Extract<
    ConversationCommandResult,
    { kind: "outcome" }
  >["outcome"],
): { text: string; expanded: boolean } {
  // Brief notices are sent through Telegram's native text path (without a
  // parse mode).  The shared formatter intentionally returns Markdown for
  // other surfaces, so keep this acknowledgement plain here instead of
  // exposing the literal `##` heading marker to Telegram users.
  if (outcome.type === "turn.stop-requested") {
    return {
      text: outcome.stopped
        ? "已请求停止当前任务。"
        : "当前没有运行中的任务。",
      expanded: false,
    };
  }

  const text = formatConversationCommandOutcome(outcome);
  return { text, expanded: text.includes("\n") };
}

function queueItemButtonLabel(
  item: Extract<ConversationCommandResult, { kind: "thread-queue" }>["result"]["items"][number],
): string {
  return item.textPreview
    ? item.textPreview
    : `${formatThreadQueueInputTypeLabel(item.inputType)} Queue 条目`;
}

export async function replyTelegramPanel(
  context: Context,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
  reply: Context["reply"] = context.reply.bind(context),
): Promise<void> {
  for (const [index, chunk] of formatTelegramPanelChunks(text).entries()) {
    await reply(chunk, {
      parse_mode: "HTML",
      ...(index === 0 && replyMarkup
        ? { reply_markup: replyMarkup }
        : {}),
      ...(index === 0 ? {} : { disable_notification: true }),
    });
  }
}

function boundedButtonLabel(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 47)}…`;
}

const resetCreditListTokens = new Map<string, { token: string; expiresAt: number }>();
export function telegramResetCreditListToken(
  result: Extract<ConversationCommandResult, { kind: "reset-credit" }>, chatId: string, actorId: string,
): string {
  for (const [key, value] of resetCreditListTokens) if (value.expiresAt <= Date.now()) resetCreditListTokens.delete(key);
  const key = JSON.stringify([chatId, actorId, result.result]);
  const previous = resetCreditListTokens.get(key);
  if (previous) return previous.token;
  const token = randomBytes(32).toString("base64url");
  if (resetCreditListTokens.size >= 1000) resetCreditListTokens.delete(resetCreditListTokens.keys().next().value!);
  resetCreditListTokens.set(key, { token, expiresAt: Date.now() + 5 * 60_000 });
  return token;
}
function resetCreditKeyboard(
  result: Extract<ConversationCommandResult, { kind: "reset-credit" }>, chatId: string, actorId: string,
): InlineKeyboardMarkup | undefined {
  const value = result.result;
  if (value.type === "preview") return { inline_keyboard: [[
    { text: "确认使用", callback_data: `rc:confirm:${value.token}` },
    { text: "取消", callback_data: `rc:cancel:${value.token}` },
  ]] };
  if (value.type !== "list") return undefined;
  const token = telegramResetCreditListToken(result, chatId, actorId);
  return { inline_keyboard: [
    ...value.credits.map((credit, index) => [{ text: boundedButtonLabel(`${index + 1}. ${credit.title ?? "用量重置券"}`), callback_data: `rc:use:${value.page}:${index}:${token}` }]),
    [ ...(value.page > 1 ? [{ text: "上一页", callback_data: `rc:page:${value.page - 1}` }] : []),
      ...(value.page < value.pageCount ? [{ text: "下一页", callback_data: `rc:page:${value.page + 1}` }] : []),
      { text: "刷新", callback_data: `rc:page:${value.page}` } ],
  ] };
}
