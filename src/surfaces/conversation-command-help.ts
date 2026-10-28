import type { ConversationCommandName } from "../application/index.js";
import { surfaceCommandAliases } from "./slash-command.js";
import { conversationCommandCatalog } from "./conversation-command-catalog.js";

export { conversationCommandDescriptions } from "./conversation-command-catalog.js";

type SurfaceCommandAlias = keyof typeof surfaceCommandAliases;
type ConversationCommandAlias = {
  [Alias in SurfaceCommandAlias]: typeof surfaceCommandAliases[Alias] extends ConversationCommandName
    ? Alias
    : never;
}[SurfaceCommandAlias];

interface HelpCommandUsage {
  name: ConversationCommandName;
  argumentsText: string;
  alias?: ConversationCommandAlias;
}

interface HelpCommandLine {
  commands: readonly HelpCommandUsage[];
  description?: string;
}

interface HelpAliasLine {
  alias: SurfaceCommandAlias;
}

function command(name: ConversationCommandName, argumentsText = ""): HelpCommandUsage {
  return { name, argumentsText };
}

function aliasCommand(alias: ConversationCommandAlias, argumentsText = ""): HelpCommandUsage {
  return { name: surfaceCommandAliases[alias], argumentsText, alias };
}

function line(...commands: HelpCommandUsage[]): HelpCommandLine {
  return { commands };
}

const helpSections = [
  {
    title: "会话：",
    lines: [
      line(command("resume", "[序号|名称|Session ID]")),
      line(command("sessions", "[页码] [filter all|running|pinned] [provider 名称] [search 搜索词]")),
      line(command("archived", "[页码] [filter all|pinned] [provider 名称] [search 搜索词]")),
      line(command("new"), command("archive"), command("unarchive", "<序号|名称|Session ID>")),
      line(command("pin"), command("unpin")),
      line(command("rename", "<名称>"), command("compact"), command("fork")),
    ],
  },
  {
    title: "运行与项目：",
    lines: [
      line(command("status"), command("workspace", "[序号|ID|名称]")),
      { ...line(command("autoreview", "[on|off]")), description: "（当前会话后续轮次）" },
      line(command("stop")),
      line(command("revert", "list [页码]"), command("revert", "<Turn ID 或列表序号>"), command("revert", "confirm <一次性令牌>")),
      line(command("review", "[branch <分支>|commit <SHA>|custom <说明>]")),
      line(command("diff")),
      line(command("release"), command("release", "force")),
      line(command("schedule", "list"), command("schedule", "runs <任务> [页码]")),
      line(command("schedule", "add <interval|once|monthly|daily|weekdays|weekly> ..."), command("schedule", "pause|resume|run|delete <任务>")),
      line(command("plan", "[规划需求]")),
    ],
  },
  {
    title: "模型与能力：",
    lines: [
      line(command("model", "[提供商序号或 ID|模型序号、ID 或名称|clear]")),
      line(command("effort", "[序号|档位]"), command("fast", "[on|ultrafast|off|status]")),
      line(command("skill"), aliasCommand("skills", "[名称或序号 任务]")),
      line(command("agents", "[角色名称或序号 任务]")),
      line(command("mcp", "[名称或序号]")),
      line(command("mcp", "health"), command("mcp", "reload")),
      line(command("mcp", "<名称或序号> <tools|resources|templates> [页码] [search <关键词>]")),
      line(command("mcp", "login <名称或序号>")),
      line(command("mcp", "resource <名称或序号> <URI>")),
      line(command("plugin"), command("plugin", "health"), command("plugin", "list [页码] [search <关键词>]")),
      line(command("plugin", "<名称、完整 ID 或序号> [任务]")),
      line(command("hooks", "[page N|列表选择标识]")),
      line(command("hooks", "trust|enable|disable <列表选择标识>"), command("hooks", "confirm <一次性令牌>")),
      line(command("usage"), command("limits"), command("permissions")),
      line(command("limits", "reset [页码]"), command("limits", "reset use <券ID>"), command("limits", "reset confirm|cancel <令牌>")),
      line(command("metrics", "session")),
      line(command("metrics", "<global|providers|models|errors> [24h|7d|30d|90d|all]")),
    ],
  },
  {
    title: "快捷命令：",
    lines: [
      { alias: "h" },
      { alias: "work" },
      { alias: "r" },
    ],
  },
] as const satisfies readonly {
  title: string;
  lines: readonly (HelpCommandLine | HelpAliasLine)[];
}[];

/** 保留既有帮助出口，命令文本只从结构化片段生成。 */
export const conversationCommandHelpSections = helpSections.map((section) => ({
  title: section.title,
  lines: section.lines.flatMap((helpLine) => {
    if ("alias" in helpLine) {
      return [`/${helpLine.alias} → /${surfaceCommandAliases[helpLine.alias]}`];
    }
    const command = helpLine.commands.map((usage) =>
      `/${usage.alias ?? usage.name}${usage.argumentsText.length > 0 ? ` ${usage.argumentsText}` : ""}`,
    ).join(" · ");
    return [helpLine.description === undefined
      ? command
      : { command, description: helpLine.description }];
  }),
}));

/** 帮助生成处声明命令与说明的边界，渠道只负责已知命令的排版。 */
export function formatConversationCommandHelpLines(
  formatCommand: (command: string) => string = (command) => command,
): string[] {
  return conversationCommandHelpSections.flatMap((section) => [
    section.title,
    ...section.lines.map((line) => typeof line === "string"
      ? `- ${formatCommand(line)}`
      : `- ${formatCommand(line.command)}${line.description}`),
    "",
  ]);
}

export const conversationCommandHelpLines = formatConversationCommandHelpLines();

/** A shared discovery summary; channel renderers still own placement and markup. */
export const conversationCommandQuickStartLines = [
  "常用入口：",
  ...(["status", "stop", "new", "resume", "workspace", "model"] as const)
    .map(name => `- ${conversationCommandCatalog[name].label}：/${name}`),
  "",
];
