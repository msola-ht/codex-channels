import {
  UserFacingError,
  type UserFacingErrorCode,
} from "../conversation-core/index.js";
import type {
  RequestMetricsCommandQuery,
  RequestMetricsTimeRange,
} from "./request-metrics-port.js";
import type { ReviewTarget } from "./turn-port.js";
import type { WorkspacePermissionUpdate } from "./workspace-permission-port.js";

export const mcpCommandUsageText = "用法：/mcp [health | reload | 名称或序号 [tools|resources|templates [页码] [search <关键词>]] | login <名称或序号> | resource <名称或序号> <URI>]";
export const pluginCommandUsageText = "用法：/plugin [health | list [页码] [search <关键词>] | <名称、完整 ID 或序号> [任务]]";
export const sessionCommandUsageText = "用法：/sessions [页码] [filter <all|running|pinned|unsectioned>] [provider <名称>] [section <名称、ID 或序号>] [search <关键词>]";
export const archivedSessionCommandUsageText = "用法：/archived [页码] [filter <all|pinned|unsectioned>] [provider <名称>] [section <名称、ID 或序号>] [search <关键词>]";
export const threadSectionCommandUsageText = "用法：/section [list [页码] | create <名称> | rename <ID 或序号> <新名称> | move <ID 或序号> [before <会话选择器>] | remove | delete <ID 或序号> [confirm]]";
export const threadQueueCommandUsageText = "用法：/queue add <文本> | /queue list [页码] | /queue update <完整 ID 或当前列表序号> <文本> | /queue delete <完整 ID 或当前列表序号> | /queue reorder <完整 ID 或当前列表序号> <目标位置> | /queue start [完整 ID 或当前列表序号]";

export interface McpDetailView {
  section: "tools" | "resources" | "templates";
  page: number;
  searchTerm: string | null;
}

export interface PluginListView {
  page: number;
  searchTerm: string | null;
}

export interface SessionListView {
  page: number;
  filter: "all" | "running" | "pinned" | "unsectioned";
  provider: string | null;
  sectionSelector: string | null;
  searchTerm: string | null;
}

const requestMetricsTimeRanges = new Set<RequestMetricsTimeRange>([
  "today",
  "yesterday",
  "this-week",
  "last-week",
  "this-month",
  "last-month",
  "24h",
  "7d",
  "30d",
  "90d",
  "365d",
  "all",
]);

export function parseMetricsCommand(input: string): RequestMetricsCommandQuery {
  if (!input) return { view: "session" };
  const parts = input.split(/\s+/u);
  if (parts.length === 1 && parts[0] === "session") {
    return { view: "session" };
  }
  const [view, range = "24h"] = parts;
  if (
    parts.length > 2
    || !(["global", "providers", "models", "errors"] as const).includes(
      view as "global" | "providers" | "models" | "errors",
    )
    || !requestMetricsTimeRanges.has(range as RequestMetricsTimeRange)
  ) {
    throw new UserFacingError(
      "metrics.usage",
      "Metrics 参数无效；范围支持 today、yesterday、this-week、last-week、this-month、last-month、24h、7d、30d、90d、365d、all",
    );
  }
  return {
    view: view as "global" | "providers" | "models" | "errors",
    range: range as RequestMetricsTimeRange,
  };
}

export function defaultSessionListView(): SessionListView {
  return {
    page: 1,
    filter: "all",
    provider: null,
    sectionSelector: null,
    searchTerm: null,
  };
}

export function parseSessionListView(input: string, archived: boolean): SessionListView {
  const view = defaultSessionListView();
  if (!input) return view;
  const parts = input.split(/\s+/u);
  let index = 0;
  if (/^\d+$/u.test(parts[0] ?? "")) {
    view.page = Number(parts[0]);
    if (!Number.isSafeInteger(view.page) || view.page < 1 || view.page > 10_000) {
      throw sessionListUsageError(archived);
    }
    index = 1;
  }
  const recognized = new Set(["filter", "provider", "section", "search"]);
  if (index === 0 && !recognized.has(parts[0] ?? "")) {
    if (input.length > 128) throw sessionListUsageError(archived);
    return { ...view, searchTerm: input };
  }
  while (index < parts.length) {
    const option = parts[index++];
    if (option === "search") {
      const searchTerm = parts.slice(index).join(" ").trim();
      if (!searchTerm || searchTerm.length > 128) throw sessionListUsageError(archived);
      view.searchTerm = searchTerm;
      index = parts.length;
      continue;
    }
    if (option === "section") {
      const start = index;
      while (index < parts.length && !recognized.has(parts[index]!)) index += 1;
      const value = parts.slice(start, index).join(" ");
      if (!value || value.length > 128) throw sessionListUsageError(archived);
      view.sectionSelector = value;
      continue;
    }
    const value = parts[index++];
    if (!value) throw sessionListUsageError(archived);
    if (option === "filter") {
      if (!(["all", "running", "pinned", "unsectioned"] as const).includes(
        value as SessionListView["filter"],
      )) {
        throw sessionListUsageError(archived);
      }
      if (archived && value === "running") throw sessionListUsageError(archived);
      view.filter = value as SessionListView["filter"];
      continue;
    }
    if (option === "provider") {
      if (value.length > 64) throw sessionListUsageError(archived);
      view.provider = value;
      continue;
    }
    throw sessionListUsageError(archived);
  }
  return view;
}

export function toSessionQuery(view: SessionListView): {
  searchTerm?: string;
  filter?: SessionListView["filter"];
  provider?: string;
  sectionSelector?: string;
} {
  return {
    ...(view.searchTerm ? { searchTerm: view.searchTerm } : {}),
    ...(view.filter !== "all" ? { filter: view.filter } : {}),
    ...(view.provider ? { provider: view.provider } : {}),
    ...(view.sectionSelector ? { sectionSelector: view.sectionSelector } : {}),
  };
}

export function parseThreadSectionOperation(input: string):
  | { type: "list"; page: number }
  | { type: "create"; name: string }
  | { type: "rename"; selector: string; name: string }
  | { type: "move"; selector: string; beforeThreadSelector: string | null }
  | { type: "remove" }
  | { type: "delete"; selector: string; confirmed: boolean } {
  const parts = input ? input.split(/\s+/u) : [];
  if (parts.length === 0 || (parts[0] === "list" && parts.length <= 2)) {
    const pageText = parts[0] === "list" ? parts[1] : undefined;
    const page = pageText === undefined ? 1 : Number(pageText);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
      throw new UserFacingError("thread-section.usage", threadSectionCommandUsageText);
    }
    return { type: "list", page };
  }
  if (parts[0] === "create" && parts.length >= 2) {
    return { type: "create", name: parts.slice(1).join(" ") };
  }
  if (parts[0] === "rename" && parts[1] && parts.length >= 3) {
    return { type: "rename", selector: parts[1], name: parts.slice(2).join(" ") };
  }
  if (parts[0] === "move" && parts[1]) {
    if (parts.length === 2) {
      return { type: "move", selector: parts[1], beforeThreadSelector: null };
    }
    if (parts.length === 4 && parts[2] === "before") {
      return { type: "move", selector: parts[1], beforeThreadSelector: parts[3]! };
    }
  }
  if (parts[0] === "remove" && parts.length === 1) return { type: "remove" };
  if (parts[0] === "delete" && parts[1] && parts.length <= 3) {
    if (parts.length === 3 && parts[2] !== "confirm") {
      throw new UserFacingError("thread-section.usage", threadSectionCommandUsageText);
    }
    return { type: "delete", selector: parts[1], confirmed: parts[2] === "confirm" };
  }
  throw new UserFacingError("thread-section.usage", threadSectionCommandUsageText);
}

export function parseThreadQueueOperation(input: string):
  | { type: "add"; text: string }
  | { type: "list"; page: number }
  | { type: "update"; selector: string; text: string }
  | { type: "delete"; selector: string }
  | { type: "reorder"; selector: string; position: number }
  | { type: "start"; selector?: string } {
  const normalized = input.trim();
  const commandMatch = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(normalized);
  const command = commandMatch?.[1];
  const rest = commandMatch?.[2]?.trim() ?? "";
  const usage = (): never => {
    throw new UserFacingError("queue.usage", threadQueueCommandUsageText);
  };
  if (command === "add") {
    return rest ? { type: "add", text: rest } : usage();
  }
  if (command === "list") {
    const page = rest === "" ? 1 : Number(rest);
    if (Number.isSafeInteger(page) && page >= 1 && page <= 4) {
      return { type: "list", page };
    }
    return usage();
  }
  if (command === "update") {
    const match = /^(\S+)(?:\s+([\s\S]+))$/u.exec(rest);
    const selector = match?.[1]?.trim() ?? "";
    const text = match?.[2]?.trim() ?? "";
    return selector && text ? { type: "update", selector, text } : usage();
  }
  if (command === "delete" && /^\S+$/u.test(rest)) {
    return { type: "delete", selector: rest };
  }
  if (command === "reorder") {
    const match = /^(\S+)\s+(\S+)$/u.exec(rest);
    const position = Number(match?.[2]);
    if (
      match?.[1]?.trim()
      && Number.isSafeInteger(position)
      && position >= 1
      && position <= 100
    ) {
      return { type: "reorder", selector: match[1], position };
    }
    return usage();
  }
  if (command === "start" && (rest === "" || /^\S+$/u.test(rest))) {
    return rest === ""
      ? { type: "start" }
      : { type: "start", selector: rest };
  }
  return usage();
}

export function parseSkillInvocation(input: string): { selector: string; task: string } {
  return parseRequiredInvocation(input, "skill.usage", "用法：/skill <名称或序号> <任务>");
}

export function parseAgentInvocation(input: string): { selector: string; task: string } {
  return parseRequiredInvocation(input, "agents.usage", "用法：/agents <角色名称或序号> <任务>");
}

export function parsePluginOperation(input: string):
  | { type: "list"; view: PluginListView }
  | { type: "health" }
  | { type: "detail"; selector: string }
  | { type: "invoke"; selector: string; task: string } {
  const parts = input.trim() ? input.trim().split(/\s+/u) : [];
  if (parts.length === 0) return { type: "list", view: { page: 1, searchTerm: null } };
  if (parts[0] === "health" && parts.length === 1) return { type: "health" };
  if (
    parts[0] === "list"
    && (parts.length === 1 || parts[1] === "search" || /^\d+$/u.test(parts[1] ?? ""))
  ) {
    let page = 1;
    let optionIndex = 1;
    const pageText = parts[optionIndex];
    if (pageText && /^\d+$/u.test(pageText)) {
      page = Number(pageText);
      optionIndex += 1;
      if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
        throw new UserFacingError("plugin.usage", pluginCommandUsageText);
      }
    }
    let searchTerm: string | null = null;
    if (parts[optionIndex] === "search") {
      searchTerm = parts.slice(optionIndex + 1).join(" ").trim();
      if (!searchTerm || searchTerm.length > 128) {
        throw new UserFacingError("plugin.usage", pluginCommandUsageText);
      }
      optionIndex = parts.length;
    }
    if (optionIndex !== parts.length) {
      throw new UserFacingError("plugin.usage", pluginCommandUsageText);
    }
    return { type: "list", view: { page, searchTerm } };
  }
  if (parts.length === 1 && parts[0]) return { type: "detail", selector: parts[0] };
  const invocation = parseRequiredInvocation(input, "plugin.usage", pluginCommandUsageText);
  return { type: "invoke", ...invocation };
}

export function parseMcpOperation(input: string):
  | { type: "health" }
  | { type: "reload" }
  | { type: "detail"; selector: string; view?: McpDetailView }
  | { type: "login"; selector: string }
  | { type: "resource"; selector: string; uri: string } {
  const parts = input.trim().split(/\s+/u);
  if (parts[0] === "health" && parts.length === 1) return { type: "health" };
  if (parts[0] === "reload" && parts.length === 1) return { type: "reload" };
  if (parts[0] === "login" && parts.length === 2) {
    return { type: "login", selector: parts[1]! };
  }
  if (parts[0] === "resource" && parts.length === 3) {
    return { type: "resource", selector: parts[1]!, uri: parts[2]! };
  }
  if (["health", "reload", "login", "resource"].includes(parts[0] ?? "")) {
    throw new UserFacingError("mcp.usage", mcpCommandUsageText);
  }
  if (parts.length === 1 && parts[0]) return { type: "detail", selector: parts[0] };
  const [selector, section, ...options] = parts;
  if (selector && (section === "tools" || section === "resources" || section === "templates")) {
    let page = 1;
    let optionIndex = 0;
    if (options[0] && /^[1-9]\d*$/u.test(options[0])) {
      page = Number(options[0]);
      optionIndex = 1;
      if (!Number.isSafeInteger(page) || page > 10_000) {
        throw new UserFacingError("mcp.usage", mcpCommandUsageText);
      }
    }
    let searchTerm: string | null = null;
    if (options[optionIndex] === "search") {
      searchTerm = options.slice(optionIndex + 1).join(" ").trim();
      if (!searchTerm || searchTerm.length > 128) {
        throw new UserFacingError("mcp.usage", mcpCommandUsageText);
      }
      optionIndex = options.length;
    }
    if (optionIndex !== options.length) {
      throw new UserFacingError("mcp.usage", mcpCommandUsageText);
    }
    return { type: "detail", selector, view: { section, page, searchTerm } };
  }
  throw new UserFacingError("mcp.usage", mcpCommandUsageText);
}

export function parseReviewTarget(input: string): ReviewTarget {
  if (!input) return { type: "uncommittedChanges" };
  const [kind, ...rest] = input.split(/\s+/);
  const value = rest.join(" ").trim();
  if (kind === "branch" && value) return { type: "baseBranch", branch: value };
  if (kind === "commit" && value) return { type: "commit", sha: value, title: null };
  if (kind === "custom" && value) return { type: "custom", instructions: value };
  throw new UserFacingError("review.usage", "Review 参数无效");
}

export function parseWorkspacePermissionCommand(
  input: string,
): WorkspacePermissionUpdate | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const [field, ...rest] = trimmed.split(/\s+/u);
  const value = rest.join(" ").trim();
  if (field === "sandbox") {
    if (value === "clear") return { kind: "sandbox", value: null };
    if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
      return { kind: "sandbox", value };
    }
  }
  if (field === "approval") {
    if (value === "clear") return { kind: "approval", value: null };
    if (value === "untrusted" || value === "on-request" || value === "never") {
      return { kind: "approval", value };
    }
  }
  if (field === "profile") {
    if (value === "clear") return { kind: "permissions", value: null };
    if (value.length > 0 && value.length <= 128) {
      return { kind: "permissions", value };
    }
  }
  throw new UserFacingError(
    "workspace.permission.usage",
    "用法：/workspaceperm [sandbox <read-only|workspace-write|danger-full-access|clear>|approval <untrusted|on-request|never|clear>|profile <Profile ID|clear>]",
  );
}

function sessionListUsageError(archived: boolean): UserFacingError {
  return archived
    ? new UserFacingError("archived-sessions.usage", archivedSessionCommandUsageText)
    : new UserFacingError("sessions.usage", sessionCommandUsageText);
}

function parseRequiredInvocation(
  input: string,
  errorCode: UserFacingErrorCode,
  usage: string,
): { selector: string; task: string } {
  const match = /^(\S+)\s+([\s\S]+)$/u.exec(input.trim());
  if (!match?.[1] || !match[2]?.trim()) {
    throw new UserFacingError(errorCode, usage);
  }
  return { selector: match[1], task: match[2].trim() };
}
