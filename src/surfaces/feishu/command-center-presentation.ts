import {
  fastServiceTierId,
  isFastServiceTier,
  listProviders,
  type ConversationCommandResult,
} from "../../application/index.js";
import { UserFacingError } from "../../conversation-core/index.js";
import { formatConversationResetCredits } from "../conversation-model-account-command-format.js";
import {
  formatDelayMinutes,
  formatScheduledTaskStatusLabel,
} from "../conversation-scheduled-task-command-format.js";
import {
  formatSessionListCommand,
  formatThreadQueueInputTypeLabel,
} from "../conversation-session-command-format.js";
import {
  formatConversationPermissions,
  formatConversationStatus,
} from "../conversation-workspace-status-command-format.js";
import { formatCodexProviderLabel, scopedModelDisplayName } from "../provider-format.js";
import type {
  FeishuCommandCenterAction,
  FeishuCommandCenterChoices,
  FeishuCommandCenterForm,
} from "./command-center.js";
import { renderFeishuCommandResult } from "./renderer.js";

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
  const choices: FeishuCommandCenterChoices["choices"][number][] = visibleItems.map((item) => ({
    label: queueChoiceLabel(item),
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
    description: result.result.totalItemCount === 0
      ? "Queue 为空；可新增纯文本条目。更新与排序请使用 /queue update|reorder 文本命令。"
      : `当前显示第 ${firstVisible}-${lastVisible}/${items.length} 条；业务页最多 25 条，卡片按每组最多 ${feishuQueueChoiceChunkSize} 条展示。条目操作只使用安全预览，点击后可启动或删除；更新与排序请使用 /queue update|reorder 文本命令。`,
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
  return item.textPreview
    ? item.textPreview
    : `${formatThreadQueueInputTypeLabel(item.inputType)} Queue 条目`;
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
      description: "按会话名称、预览或 Session ID 搜索。",
      action: "sessions",
      fieldLabel: "搜索词",
      placeholder: "请输入搜索词",
    };
  }
  if (action === "archived-search") {
    return {
      kind: "form",
      title: "搜索已归档会话",
      description: "按会话名称、预览或 Session ID 搜索。",
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
  if (action === "limits" && result.kind === "limits" && result.result.kind === "rate-limits") {
    return { title: "OpenAI 额度", description: renderFeishuCommandResult(result) ?? "", descriptionFormat: "markdown",
      choices: [{ label: "查看重置券", action: "limits", input: "reset" }] };
  }
  if (action === "limits" && result.kind === "reset-credit") {
    const value = result.result;
    if (value.type === "preview") return {
      title: "确认使用重置券", description: formatConversationResetCredits(result, "buttons"), descriptionFormat: "markdown",
      choices: (["confirm", "cancel"] as const).map(operation => ({
        label: operation === "confirm" ? "确认使用" : "取消", action: "limits", input: `reset ${operation} ${value.token}`,
        acceptedState: { title: "重置券请求已提交", description: "原按钮已失效，执行结果见后续消息。", template: "grey" },
      })),
    };
    if (value.type === "list") return {
      title: "选择重置券", description: formatConversationResetCredits(result, "buttons"), descriptionFormat: "markdown",
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
        : `共 ${result.result.totalTaskCount} 项；选择任务后可查看运行记录或执行管理操作。`,
      choices: [
        ...result.result.tasks.map((task) => ({
          label: `${formatScheduledTaskStatusLabel(task.status)} · ${task.name}`,
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
          `${run.selector}. ${run.state} · ${new Date(run.scheduledFor).toISOString()} · ${run.runId}`
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
        "**任务**",
        `- 名称：${escapeFeishuCardMarkdown(task.name)}`,
        `- 计划：${escapeFeishuCardMarkdown(scheduleChoiceSummary(task.schedule))} · ${escapeFeishuCardMarkdown(task.timezone)}`,
        `- 下次运行：${escapeFeishuCardMarkdown(task.nextRunAt === null ? "无" : new Date(task.nextRunAt).toISOString())}`,
        "",
        "**执行配置**",
        `- Workspace：${escapeFeishuCardMarkdown(task.workspaceId)}`,
        `- Provider：${escapeFeishuCardMarkdown(formatCodexProviderLabel(task.modelProvider))}`,
        `- 模型：${escapeFeishuCardMarkdown(task.model ?? "默认")}`,
        `- 思考等级：${escapeFeishuCardMarkdown(task.reasoningEffort ?? "默认")}`,
        `- Sandbox：${escapeFeishuCardMarkdown(task.sandbox)}`,
        `- 权限 Profile：${escapeFeishuCardMarkdown(task.permissions ?? "未配置")}`,
        "- 网络：沿用 Workspace 当前权限",
        "- 审批：无人值守时一律拒绝",
        "",
        "**任务内容**",
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
    const callable = result.plugins.filter((plugin) =>
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
    if (callable.length === 0 && navigation.length === 0) {
      return undefined;
    }
    return {
      title: `选择 Plugin · 第 ${result.page}/${result.pageCount} 页`,
      description: "仅显示当前页已启用且可调用的 Plugin，可继续翻页。",
      choices: [
        ...callable.map((plugin) => ({
          label: `${plugin.displayName} · ${plugin.id}`,
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
    if (result.sessions.length === 0) {
      return undefined;
    }
    const backgroundThreadIds = new Set(result.backgroundThreadIds ?? []);
    return {
      title: "选择会话",
      description: "点击后切换到对应 Codex Session。",
      choices: [
        {
          label: "搜索会话…",
          action: "sessions-search",
          input: "",
        },
        ...sessionNavigationChoices(result, "sessions"),
        ...result.sessions.map((session) => ({
          label: `${session.id === result.currentThreadId ? "✓ " : backgroundThreadIds.has(session.id) ? "后台 · " : ""}${(session.name ?? session.preview) || "未命名"}${session.model ? ` · 模型：${session.model}` : ""}`,
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
      description: "点击后取消归档并切换到对应 Codex Session。",
      choices: [
        {
          label: "搜索归档…",
          action: "archived-search",
          input: "",
        },
        ...sessionNavigationChoices(result, "archived"),
        ...result.sessions.map((session) => ({
          label: `${(session.name ?? session.preview) || "未命名"}${session.model ? ` · 模型：${session.model}` : ""}`,
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
      description: [
        "当前工作区",
        `- ${result.currentWorkspaceId ?? "未选择"}`,
        "",
        "可切换工作区",
      ].join("\n"),
      descriptionFormat: "markdown",
      choices: result.workspaces.map((workspace) => ({
        label: `${workspace.id === result.currentWorkspaceId ? "✓ " : ""}${workspace.name}`,
        action: "workspace",
        input: workspace.id,
      })),
    };
  }
  if (action === "permissions" && result.kind === "permissions") {
    return {
      title: "权限只读查询",
      description: `${formatConversationPermissions(result)}\n\n点击下方按钮进入 Workspace 权限设置。`,
      descriptionFormat: "markdown",
      choices: [{
        label: "修改 Workspace 权限",
        action: "workspaceperm",
        input: "",
      }],
    };
  }
  if (action === "status" && result.kind === "status") {
    return {
      title: "Codex 状态",
      description: [
        stripMarkdownHeading(formatConversationStatus(result.status)),
        "",
        "关联操作：",
        "- 模型设置",
        "- 工作区",
        "- 权限查询",
      ].join("\n"),
      descriptionFormat: "markdown",
      choices: [
        { label: "模型设置", action: "model", input: "" },
        { label: "工作区", action: "workspace", input: "" },
        { label: "权限查询", action: "permissions", input: "" },
      ],
    };
  }
  if (
    action === "workspaceperm"
    && result.kind === "workspace-permissions"
  ) {
    return {
      title: "工作区权限",
      description: `当前权限：\n${workspacePermissionSummary(result.workspace)}`,
      descriptionFormat: "markdown",
      choices: [
        {
          label: `沙箱：${workspacePermissionLabel(
            "sandbox",
            result.workspace.sandbox,
          )}`,
          action: "workspaceperm",
          input: "sandbox",
        },
        {
          label: `审批：${workspacePermissionLabel(
            "approval",
            result.workspace.approvalPolicy,
          )}`,
          action: "workspaceperm",
          input: "approval",
        },
        {
          label: `权限 Profile：${result.workspace.permissions ?? "未配置"}`,
          action: "workspace-perm-profile",
          input: "",
        },
      ],
    };
  }
  if (result.kind !== "models") {
    return undefined;
  }
  const currentModel = result.state.models.find(
    (model) =>
      model.model === result.state.model
      && (model.provider ?? "openai") === (result.state.modelProvider ?? "openai"),
  );
  if (action === "model") {
    if (result.state.models.length === 0) {
      return undefined;
    }
    if (result.state.providerFilter === undefined) {
      const providers = listProviders(result.state.models);
      const current = result.state.modelProvider ?? "openai";
      return {
        title: "选择提供商",
        description: [
          "当前模型",
          `- 模型：${result.state.model}`,
          `- Provider：${formatCodexProviderLabel(result.state.modelProvider)}`,
          `- 思考等级：${result.state.effort ?? currentModel?.defaultReasoningEffort ?? "模型默认"}`,
          ...(currentModel && fastServiceTierId(currentModel)
            ? [`- Fast 模式：${isFastServiceTier(result.state.serviceTier, currentModel) ? "开启" : "关闭"}${result.state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`]
            : []),
          "",
          "请先选择提供商，再选择该提供商下的模型。",
        ].join("\n"),
        descriptionFormat: "markdown",
        choices: providers.map((provider) => ({
          label: `${provider === current ? "✓ " : ""}${formatCodexProviderLabel(provider)} · ${result.state.models.filter((model) => (model.provider ?? "openai") === provider).length} 个模型`,
          action: "model",
          input: provider,
        })),
      };
    }
    return {
      title: "选择模型",
      description: [
        "当前设置",
        `- Provider：${formatCodexProviderLabel(result.state.providerFilter)}`,
        "",
        "已选择该 Provider，请继续选择模型。选择模型后将继续选择思考等级。",
      ].join("\n"),
      descriptionFormat: "markdown",
      choices: result.state.models
        .filter((model) => (model.provider ?? "openai") === result.state.providerFilter)
        .map((model) => ({
        label: `${model.model === result.state.model && (model.provider ?? "openai") === (result.state.modelProvider ?? "openai") ? "✓ " : ""}${scopedModelDisplayName(model.displayName, result.state.providerFilter)}${model.available === false ? "（暂不可用）" : ""}`,
        action: "model",
        input: model.id,
        })),
    };
  }
  if (action === "effort") {
    const efforts = currentModel?.supportedReasoningEfforts ?? [];
    if (efforts.length === 0) {
      return undefined;
    }
    return {
      title: "选择思考等级",
      description: [
        "当前设置",
        `- 模型：${result.state.model}`,
        `- 思考等级：${result.state.effort ?? currentModel?.defaultReasoningEffort ?? "模型默认"}`,
      ].join("\n"),
      descriptionFormat: "markdown",
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

export function renderWorkspacePermissionFieldChoices(
  field: "sandbox" | "approval",
): FeishuCommandCenterChoices {
  if (field === "sandbox") {
    return {
      title: "选择沙箱模式",
      choices: [
        {
          label: "只读",
          action: "workspaceperm",
          input: "sandbox read-only",
        },
        {
          label: "工作区可写",
          action: "workspaceperm",
          input: "sandbox workspace-write",
        },
        {
          label: "完全访问",
          action: "workspaceperm",
          input: "sandbox danger-full-access",
        },
        {
          label: "清除（使用全局）",
          action: "workspaceperm",
          input: "sandbox clear",
        },
      ],
    };
  }
  return {
    title: "选择审批策略",
    choices: [
      {
        label: "不信任",
        action: "workspaceperm",
        input: "approval untrusted",
      },
      {
        label: "按需审批",
        action: "workspaceperm",
        input: "approval on-request",
      },
      {
        label: "免审批",
        action: "workspaceperm",
        input: "approval never",
      },
      {
        label: "清除（使用默认）",
        action: "workspaceperm",
        input: "approval clear",
      },
    ],
  };
}

function workspacePermissionSummary(
  workspace: Extract<
    ConversationCommandResult,
    { kind: "workspace-permissions" }
  >["workspace"],
): string {
  return [
    `- 沙箱：${workspacePermissionLabel("sandbox", workspace.sandbox)}`,
    `- 审批：${workspacePermissionLabel("approval", workspace.approvalPolicy)}`,
    `- Profile：${workspace.permissions ?? "未配置"}`,
    "- 网络：跟随 Codex 用户默认设置",
  ].join("\n");
}

function workspacePermissionLabel(
  field: "sandbox" | "approval",
  value: string | undefined,
): string {
  if (value === undefined) {
    return "未配置";
  }
  const labels = field === "sandbox"
    ? ({
        "read-only": "只读",
        "workspace-write": "工作区可写",
        "danger-full-access": "完全访问",
      } as const)
    : ({
        untrusted: "不信任",
        "on-request": "按需审批",
        never: "免审批",
      } as const);
  return (labels as Record<string, string>)[value] ?? value;
}

function escapeFeishuCardMarkdown(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll(/([`*_~[\]()>#+\-.!|{}])/gu, "\\$1");
}

function stripMarkdownHeading(value: string): string {
  return value.replace(/^## [^\n]+\n?/u, "");
}
