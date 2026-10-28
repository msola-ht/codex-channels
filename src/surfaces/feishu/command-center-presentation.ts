import {
  modelSelectionSnapshot,
  type ConversationCommandResult,
} from "../../application/index.js";
import { UserFacingError } from "../../conversation-core/index.js";
import { cloudUsageChoices, formatCloudUsage } from "../cloud-usage-format.js";
import { formatConversationModelState, formatConversationResetCredits, formatModelSettingLiteral } from "../conversation-model-account-command-format.js";
import { formatConversationHooks, hookCommandChoices } from "../conversation-hook-command-format.js";
import {
  formatDelayMinutes,
  formatScheduledAt,
  formatScheduledTaskStatusLabel,
} from "../conversation-scheduled-task-command-format.js";
import {
  formatSessionListCommand,
  formatThreadQueueInputTypeLabel,
} from "../conversation-session-command-format.js";
import {
  formatConversationPermissions,
  formatConversationAutoReview,
  formatConversationStatus,
} from "../conversation-workspace-status-command-format.js";
import { formatCodexProviderLabel, formatDisplayedProvider, formatModelSpeedSupport, formatProviderModelSummary, formatServiceTier, modelListDisplayName } from "../provider-format.js";
import { formatReasoningEffort, reasoningEffortSettingName } from "../reasoning-effort-format.js";
import type {
  FeishuCommandCenterAction,
  FeishuCommandCenterChoices,
  FeishuCommandCenterForm,
} from "./command-center.js";
import { escapeFeishuCardMarkdown } from "./message-content.js";
import { renderFeishuCommandResult } from "./renderer.js";
import { formatFeishuCommandMarkdown } from "./command-format.js";
import { createWorkspaceSelectionPresentation } from "../workspace-selection-presentation.js";
import { createModelSelectionPresentation } from "../model-selection-presentation.js";
import { createSessionListPresentation } from "../session-list-presentation.js";

const feishuQueueChoiceChunkSize = 13;

export function renderQueueCommandCenterChoices(
  result: Extract<ConversationCommandResult, { kind: "thread-queue" }>,
  chunk: number,
): FeishuCommandCenterChoices {
  const items = result.result.items;
  const chunkCount = Math.max(1, Math.ceil(items.length / feishuQueueChoiceChunkSize));
  if (!Number.isSafeInteger(chunk) || chunk < 0 || chunk >= chunkCount) {
    throw new UserFacingError(
      "queue.item-not-found",
      "Queue 列表按钮已失效，请刷新 Queue 列表",
    );
  }
  const start = chunk * feishuQueueChoiceChunkSize;
  const visibleItems = items.slice(start, start + feishuQueueChoiceChunkSize);
  const choices: FeishuCommandCenterChoices["choices"][number][] = visibleItems.map((item, index) => ({
    label: choiceButtonLabel(`${result.result.selectors[start + index] ?? "?"} · ${queueChoiceLabel(item)}`),
    action: "queue",
    input: `item ${result.result.page} ${chunk + 1} ${item.id}`,
  }));
  if (chunk > 0) {
    choices.push({
      label: "上一组",
      action: "queue",
      input: `list ${result.result.page} chunk ${chunk}`,
    });
  }
  if (chunk + 1 < chunkCount) {
    choices.push({
      label: "下一组",
      action: "queue",
      input: `list ${result.result.page} chunk ${chunk + 2}`,
    });
  }
  choices.push({
    label: "刷新",
    action: "queue",
    input: `list ${result.result.page} chunk ${chunk + 1}`,
  });
  choices.push({
    label: "新增文本",
    action: "queue",
    input: "add",
  });
  if (result.result.page > 1) {
    choices.push({
      label: "上一页",
      action: "queue",
      input: `list ${result.result.page - 1}`,
    });
  }
  if (result.result.page < result.result.pageCount) {
    choices.push({
      label: "下一页",
      action: "queue",
      input: `list ${result.result.page + 1}`,
    });
  }
  const firstVisible = visibleItems.length > 0 ? start + 1 : 0;
  const lastVisible = visibleItems.length > 0 ? start + visibleItems.length : 0;
  return {
    title: `App Server Queue · 第 ${result.result.page}/${result.result.pageCount} 页`,
    description: [
      `共 ${result.result.totalItemCount} 条${visibleItems.length > 0 ? ` · 本页第 ${firstVisible}-${lastVisible}/${items.length} 条` : ""}`,
      "",
      ...(result.result.totalItemCount === 0
        ? ["Queue 为空；可新增纯文本条目。", ""]
        : result.result.page > result.result.pageCount
        ? ["当前页面已不存在，请使用 /queue list 1 重新查看。", ""]
        : visibleItems.flatMap((item, index) => [
            `**${result.result.selectors[start + index] ?? "?"}. ${formatThreadQueueInputTypeLabel(item.inputType)}** · ${item.editable ? "可更新" : "只读摘要"}`,
            "",
            `安全预览：${choiceCardLiteral(item.textPreview ?? "", 120) || "（无文本预览）"}`,
            "",
          ])),
      ...(visibleItems.length > 0 ? ["点击条目查看详情；启动和删除在详情中操作。", ""] : []),
      "更新与排序请使用 /queue update|reorder 文本命令。预览过长时会截断。",
    ].join("\n"),
    descriptionFormat: "lark_md",
    choices,
  };
}

export function renderQueueItemChoices(
  page: number,
  chunk: number,
  item: Extract<ConversationCommandResult, { kind: "thread-queue" }>["result"]["items"][number],
): FeishuCommandCenterChoices {
  return {
    title: "Queue 条目",
    description: [
      `ID：${item.id}`,
      `类型：${formatThreadQueueInputTypeLabel(item.inputType)}${item.editable ? " · 可更新" : " · 只读摘要"}`,
      `安全预览：${item.textPreview || "（无文本预览）"}`,
    ].join("\n"),
    choices: [
      {
        label: "启动",
        action: "queue",
        input: `start ${item.id}`,
      },
      {
        label: "删除",
        action: "queue",
        input: `delete-confirm ${page} ${chunk + 1} ${item.id}`,
      },
      {
        label: "返回列表",
        action: "queue",
        input: `list ${page} chunk ${chunk + 1}`,
      },
    ],
  };
}

export function renderQueueDeleteConfirmationChoices(
  page: number,
  chunk: number,
  item: Extract<ConversationCommandResult, { kind: "thread-queue" }>["result"]["items"][number],
): FeishuCommandCenterChoices {
  return {
    title: "确认删除 Queue 条目",
    description: [
      `ID：${item.id}`,
      `安全预览：${item.textPreview || "（无文本预览）"}`,
      "删除后无法通过 Gateway 恢复。",
    ].join("\n"),
    choices: [
      {
        label: "确认删除",
        action: "queue",
        input: `delete ${item.id}`,
      },
      {
        label: "取消",
        action: "queue",
        input: `item ${page} ${chunk + 1} ${item.id}`,
      },
    ],
  };
}

function queueChoiceLabel(
  item: Extract<ConversationCommandResult, { kind: "thread-queue" }>["result"]["items"][number],
): string {
  return formatModelSettingLiteral(item.textPreview ?? "")
    || `${formatThreadQueueInputTypeLabel(item.inputType)} Queue 条目`;
}

export function renderCommandCenterInitialChoices(
  action: FeishuCommandCenterAction,
): FeishuCommandCenterChoices | undefined {
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
      title: "Session Goal",
      choices: [
        { label: "查看当前", action, input: " " },
        { label: "设置 Goal", action: "goal-set", input: "" },
        { label: "清除 Goal", action, input: "clear" },
      ],
    };
  }
  return undefined;
}

export function renderScheduleCreateChoices(): FeishuCommandCenterChoices {
  return {
    title: "新增计划任务",
    description: "创建前会展示执行上下文预览，并要求二次确认。",
    choices: [
      { label: "每 N 分钟/小时", action: "schedule", input: "add-interval" },
      { label: "一次性", action: "schedule", input: "add-once" },
      { label: "每月指定日", action: "schedule", input: "add-monthly" },
      { label: "每天", action: "schedule", input: "add-daily" },
      { label: "工作日", action: "schedule", input: "add-weekdays" },
      { label: "每周指定日", action: "schedule", input: "add-weekly" },
      { label: "返回列表", action: "schedule", input: "list 1" },
    ],
  };
}

export function renderScheduleCreateForm(
  kind: "interval" | "once" | "monthly" | "daily" | "weekdays" | "weekly",
): FeishuCommandCenterForm {
  const inputs = {
    interval: ["每 N 分钟/小时", "N(分钟或小时) 时区 任务文本", "30m Asia/Shanghai 检查项目状态"],
    once: ["一次性", "日期 时间 时区 任务文本", "2026-09-01 09:00 Asia/Shanghai 发送报告"],
    monthly: ["每月指定日", "日 时间 时区 任务文本", "1 09:00 Asia/Shanghai 汇总上月"],
    daily: ["每天", "HH:mm 时区 任务文本", "09:00 Asia/Shanghai 汇总昨日进展"],
    weekdays: ["工作日", "HH:mm 时区 任务文本", "09:00 Asia/Shanghai 检查待办"],
    weekly: ["每周指定日", "星期 HH:mm 时区 任务文本", "MO,FR 10:00 Asia/Shanghai 输出周报"],
  } as const;
  const [title, fieldLabel, placeholder] = inputs[kind];
  return {
    kind: "form",
    title: `新增计划任务 · ${title}`,
    description: "任务使用当前会话的 Workspace、Provider、模型和思考等级快照运行。",
    action: "schedule",
    fieldLabel,
    placeholder,
    inputPrefix: `add ${kind} `,
    multiline: true,
  };
}

export function renderScheduleTaskChoices(
  task: Extract<ConversationCommandResult, { kind: "scheduled-tasks" }>["result"]["tasks"][number],
): FeishuCommandCenterChoices {
  return {
    title: task.name,
    description: `ID：${task.taskId}\n状态：${task.status}\n任务预览：${task.promptPreview}`,
    choices: [
      { label: "运行记录", action: "schedule", input: `runs ${task.taskId}` },
      { label: "立即运行", action: "schedule", input: `run ${task.taskId}` },
      ...(task.status === "paused"
        ? [{ label: "恢复", action: "schedule" as const, input: `resume ${task.taskId}` }]
        : [{ label: "暂停", action: "schedule" as const, input: `pause ${task.taskId}` }]),
      { label: "重命名", action: "schedule", input: `rename-task ${task.taskId}` },
      { label: "删除", action: "schedule", input: `delete ${task.taskId}` },
      { label: "返回列表", action: "schedule", input: "list 1" },
    ],
  };
}

export function renderCommandCenterForm(
  action: FeishuCommandCenterAction,
): FeishuCommandCenterForm | undefined {
  if (action === "sessions-search") {
    return {
      kind: "form",
      title: "搜索会话",
      description: "按会话标题搜索；输入内容均作为搜索词。",
      action: "sessions",
      fieldLabel: "搜索词",
      placeholder: "请输入搜索词",
      inputPrefix: "search ",
    };
  }
  if (action === "archived-search") {
    return {
      kind: "form",
      title: "搜索已归档会话",
      description: "按会话标题搜索；输入内容均作为搜索词。",
      action: "archived",
      fieldLabel: "搜索词",
      placeholder: "请输入搜索词",
      inputPrefix: "search ",
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
      title: "写入 App Server Queue",
      description: "纯文本会由 App Server 持久保存，默认容量为 100 条。",
      action,
      fieldLabel: "Queue 文本",
      placeholder: "请输入要排队的纯文本",
      inputPrefix: "add ",
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
      title: "设置 Session Goal",
      action: "goal",
      fieldLabel: "目标",
      placeholder: "请输入当前 Session 的目标",
      inputPrefix: "set ",
      multiline: true,
    };
  }
  return undefined;
}

export function renderCommandCenterChoices(
  action: FeishuCommandCenterAction,
  result: ConversationCommandResult,
): FeishuCommandCenterChoices | undefined {
  if (action === "hooks" && result.kind === "hooks") {
    return {
      title: result.view.confirmation ? "确认 Hook 配置操作" : "Hooks",
      description: formatConversationHooks(result.view),
      descriptionFormat: "plain_text",
      choices: hookCommandChoices(result.view).map(choice => ({ ...choice, action: "hooks" })),
    };
  }
  if (action === "limits" && result.kind === "limits" && result.result.kind === "rate-limits") {
    return { title: "OpenAI 额度", description: stripMarkdownHeading(renderFeishuCommandResult(result) ?? ""), descriptionFormat: "markdown",
      choices: [{ label: "查看重置券", action: "limits", input: "reset" }] };
  }
  if (action === "limits" && result.kind === "reset-credit") {
    const value = result.result;
    if (value.type === "preview") return {
      title: "确认使用重置券", description: stripMarkdownHeading(formatConversationResetCredits(result, "buttons")), descriptionFormat: "markdown",
      choices: (["confirm", "cancel"] as const).map(operation => ({
        label: operation === "confirm" ? "确认使用" : "取消", action: "limits", input: `reset ${operation} ${value.token}`,
        acceptedState: { title: "重置券请求已提交", description: "原按钮已失效，执行结果见后续消息。", template: "grey" },
      })),
    };
    if (value.type === "list") return {
      title: "选择重置券", description: stripMarkdownHeading(formatConversationResetCredits(result, "buttons")), descriptionFormat: "markdown",
      choices: [
        ...value.credits.map((credit, index) => ({ label: `${index + 1}. ${credit.title ?? "用量重置券"}`.slice(0, 80), action: "limits" as const, input: `reset use ${credit.id}` })),
        ...(value.page > 1 ? [{ label: "上一页", action: "limits" as const, input: `reset ${value.page - 1}` }] : []),
        ...(value.page < value.pageCount ? [{ label: "下一页", action: "limits" as const, input: `reset ${value.page + 1}` }] : []),
        { label: "刷新", action: "limits", input: `reset ${value.page}` },
      ],
    };
  }
  if (action === "schedule" && result.kind === "scheduled-tasks") {
    return {
      title: `Gateway 计划任务 · 第 ${result.result.page}/${result.result.pageCount} 页`,
      description: result.result.totalTaskCount === 0
        ? "当前没有计划任务。"
        : [
            `共 ${result.result.totalTaskCount} 项`,
            "",
            ...result.result.tasks.flatMap((task, index) => [
              `**${result.result.selectors[index] ?? "?"}. ${choiceCardLiteral(task.name, 32)}** · ${formatScheduledTaskStatusLabel(task.status)}`,
              "",
              `计划：${choiceCardLiteral(scheduleChoiceSummary(task.schedule))} · ${choiceCardLiteral(task.timezone, 80)}`,
              "",
              `下次运行：${formatScheduledAt(task.nextRunAt)}`,
              "",
            ]),
            "选择任务查看详情和运行记录，再执行管理操作。",
          ].join("\n"),
      descriptionFormat: "lark_md",
      choices: [
        ...result.result.tasks.map((task, index) => ({
          label: choiceButtonLabel(`${result.result.selectors[index] ?? "?"} · ${formatModelSettingLiteral(task.name)}`),
          action: "schedule" as const,
          input: `task ${task.taskId}`,
        })),
        { label: "新增", action: "schedule", input: "add" },
        ...(result.result.page > 1
          ? [{ label: "上一页", action: "schedule" as const, input: `list ${result.result.page - 1}` }]
          : []),
        ...(result.result.page < result.result.pageCount
          ? [{ label: "下一页", action: "schedule" as const, input: `list ${result.result.page + 1}` }]
          : []),
      ],
    };
  }
  if (action === "schedule" && result.kind === "scheduled-runs") {
    return {
      title: `运行记录 · ${result.result.task.name}`,
      description: [
        `第 ${result.result.page}/${result.result.pageCount} 页 · 共 ${result.result.totalRunCount} 条`,
        ...result.result.runs.map((run) =>
          `${run.selector}. ${run.state} · ${formatScheduledAt(run.scheduledFor)} · ${run.runId}`
        ),
      ].join("\n"),
      choices: [
        ...result.result.runs
          .filter((run) => run.state === "uncertain")
          .map((run) => ({
            label: `重试 uncertain · ${run.selector}`,
            action: "schedule" as const,
            input: `retry ${run.runId}`,
          })),
        ...(result.result.page > 1
          ? [{
              label: "上一页",
              action: "schedule" as const,
              input: `runs ${result.result.task.taskId} ${result.result.page - 1}`,
            }]
          : []),
        ...(result.result.page < result.result.pageCount
          ? [{
              label: "下一页",
              action: "schedule" as const,
              input: `runs ${result.result.task.taskId} ${result.result.page + 1}`,
            }]
          : []),
        { label: "返回任务", action: "schedule", input: `task ${result.result.task.taskId}` },
      ],
    };
  }
  if (action === "schedule" && result.kind === "scheduled-confirmation") {
    const task = result.preview.task;
    const actionLabel = result.preview.action === "create" ? "创建" : "删除";
    return {
      title: `确认${actionLabel}计划任务`,
      description: [
        "### 任务",
        `- 名称：${escapeFeishuCardMarkdown(task.name)}`,
        `- 计划：${escapeFeishuCardMarkdown(scheduleChoiceSummary(task.schedule))} · ${escapeFeishuCardMarkdown(task.timezone)}`,
        `- 下次运行：${escapeFeishuCardMarkdown(formatScheduledAt(task.nextRunAt))}`,
        "",
        "### 执行配置",
        `- Workspace：${escapeFeishuCardMarkdown(task.workspaceId)}`,
        `- Provider：${escapeFeishuCardMarkdown(formatCodexProviderLabel(task.modelProvider))}`,
        `- 模型：${escapeFeishuCardMarkdown(task.model || "默认")}`,
        `- ${reasoningEffortSettingName(task.reasoningEffort)}：${escapeFeishuCardMarkdown(formatReasoningEffort(task.reasoningEffort, "默认"))}`,
        `- Sandbox：${escapeFeishuCardMarkdown(task.sandbox)}`,
        `- 权限 Profile：${escapeFeishuCardMarkdown(task.permissions ?? "未配置")}`,
        "- 网络：沿用目标 App Server 的项目配置",
        "- 审批：无人值守时一律拒绝",
        "",
        "### 任务内容",
        `- ${escapeFeishuCardMarkdown(task.promptPreview)}`,
        "",
        "该任务由 Gateway 无人值守执行；确认令牌 5 分钟内有效且仅可使用一次。",
      ].join("\n"),
      descriptionFormat: "markdown",
      choices: [
        {
          label: "确认",
          action: "schedule",
          input: `confirm ${result.preview.token}`,
          acceptedState: {
            title: `已确认${actionLabel}计划任务`,
            description: "请求已提交，原按钮已失效；执行结果见后续消息。",
            template: "green",
          },
        },
        {
          label: "取消",
          action: "schedule",
          input: "list 1",
          acceptedState: {
            title: `已取消${actionLabel}计划任务`,
            description: `未${actionLabel}计划任务，原按钮已失效。`,
            template: "grey",
          },
        },
      ],
    };
  }
  if (action === "plugin" && result.kind === "plugins") {
    const entries = result.plugins.map((plugin, index) => ({
      plugin,
      selector: result.selectors[index] ?? "?",
    }));
    const callable = entries.filter(({ plugin }) =>
      plugin.enabled && plugin.available
    );
    const searchSuffix = result.searchTerm ? ` search ${result.searchTerm}` : "";
    const navigation = [
      ...(result.page > 1
        ? [{
            label: "上一页",
            action: "plugin" as const,
            input: `list ${result.page - 1}${searchSuffix}`,
          }]
        : []),
      ...(result.page < result.pageCount
        ? [{
            label: "下一页",
            action: "plugin" as const,
            input: `list ${result.page + 1}${searchSuffix}`,
          }]
        : []),
    ];
    return {
      title: `选择 Plugin · 第 ${result.page}/${result.pageCount} 页`,
      description: [
        `共 ${result.totalPluginCount} 项 · 匹配 ${result.matchedPluginCount} 项`,
        ...(result.searchTerm ? [`搜索：${choiceCardLiteral(result.searchTerm)}`] : []),
        ...(result.loadErrorCount > 0
          ? ["", `注意：${result.loadErrorCount} 个 Plugin Marketplace 加载失败，列表可能不完整。`]
          : []),
        "",
        ...(result.page > result.pageCount
          ? ["当前页面已不存在，请通过 /plugin list 重新查看。", ""]
          : entries.length === 0
          ? [result.searchTerm
              ? "没有匹配的 Plugin。"
              : result.loadErrorCount > 0 ? "本次未取得 Plugin 列表。" : "当前没有已安装的 Plugin。", ""]
          : entries.flatMap(({ plugin, selector }) => [
              `**${selector}. ${choiceCardLiteral(plugin.displayName, 32)}** · ${plugin.enabled ? "已启用" : "未启用"} · ${plugin.available ? "可用" : "不可用"}`,
              "",
              ...(plugin.description ? [choiceCardLiteral(plugin.description, 160), ""] : []),
            ])),
        ...(callable.length > 0
          ? ["仅已启用且可用的条目提供按钮；选择后填写任务，再提交调用。"]
          : entries.length > 0 ? ["本页没有可调用的 Plugin。"] : []),
        "健康检查：/plugin health",
        "搜索：/plugin list search <关键词>",
        "详情：/plugin <名称、完整 ID 或序号>",
      ].join("\n"),
      descriptionFormat: "lark_md",
      choices: [
        ...callable.map(({ plugin, selector }) => ({
          label: choiceButtonLabel(`${selector} · ${formatModelSettingLiteral(plugin.displayName)}`),
          action: "plugin" as const,
          input: plugin.id,
        })),
        ...navigation,
      ],
    };
  }
  if (
    (action === "resume" || action === "sessions")
    && result.kind === "sessions"
    && !result.archived
  ) {
    return renderSessionCommandChoices(result);
  }
  if (action === "archived" && result.kind === "sessions" && result.archived) {
    return renderSessionCommandChoices(result);
  }
  if (action === "workspace" && result.kind === "workspaces") {
    const view = createWorkspaceSelectionPresentation(result);
    if (view.entries.length === 0) {
      return undefined;
    }
    return paginatedChoiceList("工作区", [
        "### 当前工作区",
        `- ${choiceCardLiteral(view.currentWorkspaceId)}${view.currentWorkspace ? "" : "（已失效）"}`,
        "",
        "### 工作区清单",
      ].join("\n"), view.entries.map(workspace => ({
        description: [
          `**${workspace.position}. ${choiceCardLiteral(workspace.name, 80)}**${workspace.isCurrent ? " · 当前" : ""}`,
          "",
          `目录：${choiceCardLiteral(workspace.cwd, 160)}`,
        ].join("\n"),
        choice: {
          label: choiceButtonLabel(`${workspace.position} · ${formatModelSettingLiteral(workspace.name)}`),
          action: "workspace-select",
          input: workspace.id,
        },
      })), "请选择下方工作区；切换后请重新发起操作，不会自动重试之前的请求。");
  }
  if (action === "permissions" && result.kind === "permissions") {
    return {
      title: "权限只读查询",
      description: stripMarkdownHeading(formatConversationPermissions(result)),
      descriptionFormat: "markdown",
      choices: [],
    };
  }
  if (action === "status" && result.kind === "status") {
    return {
      title: "Codex 状态",
      description: stripMarkdownHeading(formatConversationStatus(result.status, escapeFeishuCardMarkdown, result)),
      descriptionFormat: "markdown",
      choices: [
        { label: "请求统计", action: "metrics", input: "" },
        { label: "账户用量", action: "usage", input: "" },
        { label: "账户额度", action: "limits", input: "" },
        { label: "模型设置", action: "model", input: "" },
        { label: "工作区", action: "workspace", input: "" },
        { label: "权限查询", action: "permissions", input: "" },
        { label: "审批设置", action: "autoreview", input: "" },
      ],
    };
  }
  if (action === "usage" && result.kind === "usage" && result.result.kind === "cloud-usage") {
    return { title: "Ollama Cloud 用量", description: formatCloudUsage(result.result), descriptionFormat: "markdown",
      choices: cloudUsageChoices(result.result).map(choice => ({ ...choice, action: "usage" as const })) };
  }
  if (action === "autoreview" && result.kind === "auto-review") {
    const { threadId, reviewer } = result.state;
    return {
      title: result.state.updated ? "已切换当前会话审批方式" : "当前会话审批方式",
      description: stripMarkdownHeading(formatConversationAutoReview(result, formatFeishuCommandMarkdown)),
      descriptionFormat: "markdown",
      choices: threadId !== null && (reviewer === "user" || reviewer === "auto_review")
        ? (["on", "off"] as const).map(value => ({
          label: value === "on" ? "当前会话：自动审批" : "当前会话：手动审批",
          action: "thread-autoreview-select" as const,
          input: `${value} ${threadId}`,
        }))
        : [],
    };
  }
  if (result.kind !== "models") {
    return undefined;
  }
  const snapshot = modelSelectionSnapshot(result.state);
  const presentation = createModelSelectionPresentation(result.state);
  const currentModel = presentation.availableCurrentModel;
  const settingLines = formatConversationModelState(result, choiceCardLiteral).map(line => `- ${line}`);
  if (action === "model") {
    if (result.state.models.length === 0) {
      return undefined;
    }
    if (result.state.providerFilter === undefined) {
      return paginatedChoiceList("选择提供商", [
          "### 当前模型",
          ...settingLines,
          "",
          "请先选择提供商，再选择该提供商下的模型。",
          "",
          "### 提供商清单",
        ].join("\n"), presentation.providers.map(({ id: provider, position, isCurrent }) => ({
          description: `${position}. **${choiceCardLiteral(formatCodexProviderLabel(provider), 80)}**${isCurrent && result.state.modelProvider !== undefined ? result.state.providerPending ? " · 已选" : " · 当前" : ""} · ${choiceCardLiteral(formatProviderModelSummary(result.state.models, provider))}`,
          choice: {
            label: choiceButtonLabel(`${position} · ${formatModelSettingLiteral(formatCodexProviderLabel(provider))}`),
            action: "model",
            input: provider,
            modelSelection: { kind: "browse-provider", provider, snapshot },
          },
        })));
    }
    return paginatedChoiceList("选择模型", [
        "### 当前设置",
        ...settingLines,
        `- 浏览 Provider：${choiceCardLiteral(formatCodexProviderLabel(result.state.providerFilter))}`,
        "",
        presentation.entries.length > 0
          ? "正在浏览该 Provider；浏览不会切换当前设置。请继续选择模型，选择后将继续选择思考等级。"
          : "当前提供商没有可选模型，请返回提供商重新选择。",
        "",
        "### 模型清单",
      ].join("\n"), presentation.entries.map(({ model, provider, position, isCurrent }) => ({
        description: `**${position}. ${choiceCardLiteral(modelListDisplayName(model.displayName, model.provider, model.model), 80)}**${isCurrent ? result.state.modelPending ? " · 已选" : " · 当前" : ""} · ${formatModelSpeedSupport(model)}${model.available === false ? ` · 暂不可用${model.unavailableReason ? `：${choiceCardLiteral(model.unavailableReason)}` : ""}` : ""}`,
        choice: {
          label: choiceButtonLabel(formatModelSettingLiteral(modelListDisplayName(model.displayName, model.provider, model.model, position))),
          action: "model",
          input: String(position),
          modelSelection: { kind: "model", provider, model: model.model, snapshot },
        },
      })), undefined, [{ label: "返回提供商", action: "model", input: "" }]);
  }
  if (action === "effort") {
    const efforts = currentModel?.supportedReasoningEfforts ?? [];
    if (efforts.length === 0) {
      return undefined;
    }
    return {
      title: `选择${reasoningEffortSettingName(result.state.effort, currentModel)}`,
      description: [
        "### 当前设置",
        ...settingLines,
        "",
        "### 可选档位",
        ...efforts.slice(0, 18).map((option, index) =>
          `${index + 1}. **${choiceCardLiteral(formatReasoningEffort(option.effort), 40)}**${option.effort === result.state.effort ? result.state.effortPending ? " · 已选" : " · 当前" : ""}${option.description ? ` · ${choiceCardLiteral(option.description, 160)}` : ""}`
        ),
      ].join("\n"),
      descriptionFormat: "lark_md",
      choices: efforts.map(
        (option) => ({
          label: `${option.effort === result.state.effort ? "✓ " : ""}${formatModelSettingLiteral(formatReasoningEffort(option.effort))}`,
          action: "effort",
          input: option.effort,
          modelSelection: { kind: "effort", effort: option.effort, snapshot },
        }),
      ),
    };
  }
  if (action === "fast") {
    const speed = result.state.serviceTierKnown !== true
      ? "未知" : formatServiceTier(result.state.serviceTier, currentModel);
    return {
      title: "Fast",
      description: [
        ...settingLines,
        `- 当前模型：${formatModelSpeedSupport(currentModel)}`,
        "",
        "### 可选速度",
        ...presentation.speedOptions.map(({ label, mode }) =>
          `- **${label}**${speed === label ? " · 已选" : ""} · ${mode === "off" ? "标准档位" : mode === "on" ? "Fast 加速档位" : "Ultrafast 加速档位"}`
        ),
      ].join("\n"),
      descriptionFormat: "lark_md",
      choices: presentation.speedOptions.map(({ label, mode }) => ({
        label: `${speed === label ? "✓ " : ""}${label}`,
        action: "fast",
        input: mode,
        modelSelection: { kind: "fast", mode, snapshot },
      })),
    };
  }
  return undefined;
}

/** Paginate only presentation; retain original identities and model snapshots on every page. */
function paginatedChoiceList(
  title: string,
  header: string,
  entries: ReadonlyArray<{ description: string; choice: FeishuCommandCenterChoices["choices"][number] }>,
  footer?: string,
  returnChoices: FeishuCommandCenterChoices["choices"] = [],
): FeishuCommandCenterChoices {
  const pageSize = 15;
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  const selectPage = (page: number): FeishuCommandCenterChoices => {
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
      throw new UserFacingError("command.unsupported", "选择列表页码无效，请重新打开");
    }
    const visible = entries.slice((page - 1) * pageSize, page * pageSize);
    return {
      title: pageCount > 1 ? `${title} · 第 ${page}/${pageCount} 页` : title,
      description: [header, ...visible.map(entry => entry.description), ...(footer ? [footer] : [])].join("\n\n"),
      descriptionFormat: "lark_md",
      ...(pageCount > 1 ? { selectPage } : {}),
      choices: [
        ...visible.map(entry => entry.choice),
        ...(page > 1 ? [{ label: "上一页", action: "choices-page" as const, input: String(page - 1) }] : []),
        ...(page < pageCount ? [{ label: "下一页", action: "choices-page" as const, input: String(page + 1) }] : []),
        ...returnChoices,
      ],
    };
  };
  return selectPage(1);
}

function scheduleChoiceSummary(
  schedule: Extract<ConversationCommandResult, { kind: "scheduled-tasks" }>["result"]["tasks"][number]["schedule"],
): string {
  switch (schedule.type) {
    case "interval": return `每 ${formatDelayMinutes(schedule.intervalMinutes)}`;
    case "once": return "afterMinutes" in schedule
      ? `一次性 ${formatDelayMinutes(schedule.afterMinutes)}后`
      : `一次性 ${schedule.date} ${schedule.time}`;
    case "monthly": return `每月 ${schedule.day} 号 ${schedule.time}`;
    case "daily": return `每天 ${schedule.time}`;
    case "weekdays": return `工作日 ${schedule.time}`;
    case "weekly": return `每周 ${schedule.days.join(",")} ${schedule.time}`;
  }
}

function renderSessionCommandChoices(
  result: Extract<ConversationCommandResult, { kind: "sessions" }>,
): FeishuCommandCenterChoices | undefined {
  if (result.sessions.length === 0) return undefined;
  const entries = createSessionListPresentation(result);
  const listAction = result.archived ? "archived" : "sessions";
  const restoreAction = result.archived ? "unarchive" : "resume";
  return {
    title: result.archived ? "恢复已归档会话" : "选择会话",
    // Reuse the existing Markdown-body/plain-button path; no option is a default selection.
    descriptionFormat: "lark_md",
    description: [
      `匹配 ${result.matchedSessionCount} 条 · 第 ${result.page}/${result.pageCount} 页`,
      ...(result.view.searchTerm ? [`搜索：${choiceCardLiteral(result.view.searchTerm)}`] : []),
      result.archived
        ? "按下方编号取消归档并切换到对应会话。"
        : "按下方编号切换到对应会话。",
      "",
      ...entries.flatMap(({ session, selector, isCurrent, isBackground }) => {
        const markers = [
          ...(!result.archived && isCurrent ? ["当前"] : !result.archived && isBackground ? ["后台"] : []),
          ...(session.isPinned ? ["固定"] : []),
        ];
        const title = choiceCardLiteral((session.name ?? session.preview) || "未命名", 32) || "未命名";
        const modelFields = [
          ...(session.model ? [`模型：${choiceCardLiteral(session.model, 80)}`] : []),
          ...(session.reasoningEffort ? [`${reasoningEffortSettingName(session.reasoningEffort)}：${choiceCardLiteral(formatReasoningEffort(session.reasoningEffort), 40)}`] : []),
          ...(session.modelProvider ? [`Provider：${choiceCardLiteral(formatDisplayedProvider(session.modelProvider), 80)}`] : []),
        ];
        return [
          `**${selector}. ${title}**${markers.length ? ` · ${markers.join(" · ")}` : ""}`,
          ...(modelFields.length ? [modelFields.join(" · ")] : []),
          `ID：${choiceCardLiteral(session.id.slice(0, 12), 12)} · 状态：${choiceCardLiteral(session.status.type, 40)}${session.turnCount === undefined ? "" : ` · 轮数：${session.turnCount}`}`,
          "",
        ];
      }),
      "标题或字段过长时会截断；按钮编号对应以上条目。",
    ].join("\n"),
    choices: [
      { label: result.archived ? "搜索归档" : "搜索会话", action: result.archived ? "archived-search" : "sessions-search", input: "" },
      ...sessionNavigationChoices(result, listAction),
      ...entries.map(({ session, selector }): FeishuCommandCenterChoices["choices"][number] => ({
        label: choiceButtonLabel(`${selector} · ${formatModelSettingLiteral((session.name ?? session.preview) || "未命名") || "未命名"}`),
        action: restoreAction,
        input: session.id,
      })),
    ],
  };
}

function choiceButtonLabel(value: string): string {
  // Stay within the consumer's 32 UTF-16 unit budget without splitting a code point.
  if (value.length <= 32) return value;
  let prefix = "";
  for (const character of value) {
    if (prefix.length + character.length > 31) break;
    prefix += character;
  }
  return `${prefix}…`;
}

function choiceCardLiteral(value: string, maximumCharacters = 120): string {
  const characters = Array.from(formatModelSettingLiteral(value));
  const bounded = characters.length > maximumCharacters
    ? `${characters.slice(0, maximumCharacters - 1).join("")}…`
    : characters.join("");
  return escapeFeishuCardMarkdown(bounded.replaceAll("&", "&amp;").replaceAll("<", "&lt;"));
}

function sessionNavigationChoices(
  result: Extract<ConversationCommandResult, { kind: "sessions" }>,
  action: "sessions" | "archived",
): FeishuCommandCenterChoices["choices"] {
  return [
    ...(result.page > 1
      ? [{
          label: "上一页",
          action,
          input: formatSessionListCommand(result, result.page - 1)
            .replace(/^\/(?:sessions|archived)\s*/u, ""),
        }]
      : []),
    ...(result.page < result.pageCount
      ? [{
          label: "下一页",
          action,
          input: formatSessionListCommand(result, result.page + 1)
            .replace(/^\/(?:sessions|archived)\s*/u, ""),
        }]
      : []),
  ];
}

function stripMarkdownHeading(value: string): string {
  return value.replace(/^## [^\n]+\n?/u, "");
}
