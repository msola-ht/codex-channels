import type { ConversationCommandName } from "../application/index.js";

/** Discovery only: hidden commands remain supported by the original command handlers. */
export function isConversationCommandVisible(name: ConversationCommandName): boolean {
  return name !== "queue" && name !== "goal";
}

/** Presentation metadata only. Application and channel handlers still own admission and execution. */
export const conversationCommandCatalog = {
  resume: { label: "会话切换", description: "列出或恢复 Codex 会话" },
  sessions: { label: "会话列表", description: "搜索可恢复会话" },
  archived: { label: "已归档", description: "搜索已归档会话" },
  new: { label: "新会话", description: "下一条消息创建新会话" },
  archive: { label: "归档当前", description: "归档当前会话" },
  unarchive: { label: "恢复已归档", description: "恢复已归档会话" },
  pin: { label: "固定会话", description: "固定当前会话" },
  unpin: { label: "取消固定", description: "取消固定当前会话" },
  status: { label: "当前状态", description: "查看当前会话状态" },
  workspace: { label: "工作区", description: "列出或切换 Workspace" },
  autoreview: { label: "当前会话审批方式", description: "查看或切换当前会话审批方式" },
  stop: { label: "停止任务", description: "停止当前任务" },
  queue: { label: "App Server Queue", description: "管理 App Server 持久队列" },
  revert: { label: "历史回退", description: "回退当前 Session 的分页历史" },
  rename: { label: "重命名", description: "命名当前会话" },
  compact: { label: "压缩上下文", description: "压缩当前上下文" },
  fork: { label: "分叉会话", description: "分叉当前会话" },
  review: { label: "Review", description: "启动代码审查" },
  model: { label: "模型设置", description: "查看或切换模型" },
  effort: { label: "思考等级", description: "查看或切换思考等级" },
  fast: { label: "速度", description: "查看或切换 Standard、Fast、Ultrafast 速度" },
  skill: { label: "Skills", description: "查看或调用 Skill" },
  mcp: { label: "MCP", description: "检查或管理 MCP、登录 OAuth、浏览或读取资源" },
  plugin: { label: "Plugin", description: "列出、查看或调用 Plugin" },
  hooks: { label: "Hooks", description: "查看、审查、信任或启停 Hooks" },
  usage: { label: "账户用量", description: "查看账号与当前 Session 用量；Ollama 支持时间切换与刷新" },
  metrics: { label: "请求指标", description: "查看会话、聚合或异常请求指标" },
  limits: { label: "额度", description: "查看套餐与额度" },
  permissions: { label: "权限查询", description: "查看权限配置" },
  diff: { label: "Diff", description: "查看当前 Turn Diff" },
  plan: { label: "Plan 模式", description: "切换 Plan 模式或直接开始规划" },
  goal: { label: "Goal", description: "查看或管理 Goal" },
  agents: { label: "子代理", description: "查看或调用子代理" },
  release: { label: "释放占用", description: "查看或释放被占用的 Codex 会话" },
  schedule: { label: "计划任务", description: "管理 Gateway 计划任务" },
} as const satisfies Record<ConversationCommandName, { label: string; description: string }>;

export const conversationCommandDescriptions = Object.fromEntries(
  Object.entries(conversationCommandCatalog).map(([name, entry]) => [name, entry.description]),
) as Record<ConversationCommandName, string>;

interface ConversationMenuAction {
  command: ConversationCommandName;
  label: string;
  argumentsText: string;
}

// Input prefixes retain their trailing space. They are not executable input or authorization.
const menuVariants = {
  "fast-status": { command: "fast", label: "速度", argumentsText: "status" },
  "limits-reset": { command: "limits", label: "查看重置券", argumentsText: "reset" },
  "mcp-health": { command: "mcp", label: "MCP 健康", argumentsText: "health" },
  "mcp-reload": { command: "mcp", label: "重载 MCP", argumentsText: "reload" },
  "plugin-health": { command: "plugin", label: "插件健康", argumentsText: "health" },
  "review-branch": { command: "review", label: "审查分支差异", argumentsText: "branch " },
  "review-commit": { command: "review", label: "审查指定提交", argumentsText: "commit " },
  "review-custom": { command: "review", label: "填写审查要求", argumentsText: "custom " },
  "plan-request": { command: "plan", label: "填写计划需求", argumentsText: "" },
  "schedule-add-interval": { command: "schedule", label: "每隔一段时间", argumentsText: "add interval " },
  "schedule-add-once": { command: "schedule", label: "一次性", argumentsText: "add once " },
  "schedule-add-monthly": { command: "schedule", label: "每月指定日", argumentsText: "add monthly " },
  "schedule-add-daily": { command: "schedule", label: "每天", argumentsText: "add daily " },
  "schedule-add-weekdays": { command: "schedule", label: "工作日", argumentsText: "add weekdays " },
  "schedule-add-weekly": { command: "schedule", label: "每周指定日", argumentsText: "add weekly " },
} as const satisfies Record<string, ConversationMenuAction>;

export type ConversationMenuActionId = ConversationCommandName | keyof typeof menuVariants;

/** Resolve authored static entries only; platform navigation and dynamic selections remain local. */
export function conversationMenuAction(id: ConversationMenuActionId): ConversationMenuAction {
  if (Object.hasOwn(menuVariants, id)) return menuVariants[id as keyof typeof menuVariants];
  const command = id as ConversationCommandName;
  return { command, label: conversationCommandCatalog[command].label, argumentsText: "" };
}
