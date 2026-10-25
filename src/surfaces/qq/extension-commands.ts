import { parseMcpOperation, parsePluginOperation, supportsMcpOAuthLogin, type ConversationCommandResult } from "../../application/index.js";
import { formatConversationAgents, formatConversationSkills, formatConversationMcp,
  formatConversationMcpDetail, formatConversationMcpHealth, formatConversationPlugins,
  formatConversationPluginDetail, formatConversationPluginHealth, mcpDetailPageCount,
  formatConversationMcpLogin, formatConversationMcpReload, formatConversationMcpResource } from "../conversation-extension-command-format.js";
import { formatConversationHooks } from "../conversation-hook-command-format.js";
import { formatConversationOccupancy } from "../conversation-session-command-format.js";
import { UserFacingError } from "../../conversation-core/index.js";

export type QqExtensionCommand = "skill" | "agents" | "plugin" | "mcp" | "hooks";
export interface QqExtensionChoice {
  label: string;
  command: QqExtensionCommand;
  input: string;
  page?: number;
  expectedName?: string;
  /** Selected stable identity; only the task text remains to be entered. */
  taskInput?: boolean;
}
export interface QqExtensionView { detail: string; choices: QqExtensionChoice[]; authorizationUrl?: string }

export function isQqTaskCommand(command: string, input: string): boolean {
  if (command === "review") return true;
  if (["skill", "agents", "plan"].includes(command)) return !!input.trim();
  if (command !== "plugin") return false;
  try { return parsePluginOperation(input).type === "invoke"; }
  catch (error) { if (error instanceof UserFacingError) return false; throw error; }
}

function taskChoice(command: QqExtensionCommand, label: string, selector: string): QqExtensionChoice[] {
  // The shared invocation grammar accepts exactly one selector token. Never
  // turn a changing list index or an unrepresentable name into another task.
  const data = `/${command} ${selector} `;
  return /^\S+$/u.test(selector) && !/^\d+$/u.test(selector)
    && [...data].length <= 100 && !/[\p{Cc}\uD800-\uDFFF]/u.test(data)
    ? [{ label, command, input: selector, taskInput: true }] : [];
}

/** Reuse business parsers; task invocation remains separate from MCP management. */
export function isQqExtensionOperation(command: string, input: string): boolean {
  const value = input.trim();
  try {
    switch (command) {
      case "skill": case "agents": case "release": return !value;
      case "plugin": return parsePluginOperation(value).type !== "invoke";
      case "mcp": if (value) parseMcpOperation(value); return true;
      case "hooks": return !value || /^page\s+[1-9]\d*$/u.test(value) || /^[a-f0-9]{16}\.[1-8]$/u.test(value);
      default: return false;
    }
  } catch (error) {
    if (error instanceof UserFacingError) return false;
    throw error;
  }
}

export function renderQqExtensionCommand(result: ConversationCommandResult, page = 1): QqExtensionView | undefined {
  const choices: QqExtensionChoice[] = [];
  const paginate = (count: number, command: QqExtensionCommand, input: string) => {
    const pages = Math.max(1, Math.ceil(count / 8));
    if (!Number.isSafeInteger(page) || page < 1 || page > pages) return false;
    if (page > 1) choices.push({ label: "上一页", command, input, page: page - 1 });
    if (page < pages) choices.push({ label: "下一页", command, input, page: page + 1 });
    return true;
  };
  switch (result.kind) {
    case "skills": {
      if (!paginate(result.entries.length, "skill", "")) return;
      choices.unshift(...result.entries.slice((page - 1) * 8, page * 8).flatMap(skill => skill.invocable === true ? taskChoice("skill", skill.name, skill.name) : []));
      return { detail: `第 ${page} 页 · 共 ${result.entries.length} 项\n${formatConversationSkills({ ...result, entries: result.entries.slice((page - 1) * 8, page * 8) }, true)}\n使用：/skill <完整名称> <任务>；本页序号仅用于展示。`, choices };
    }
    case "agents": {
      if (!paginate(result.roles.length, "agents", "")) return;
      choices.unshift(...result.roles.slice((page - 1) * 8, page * 8).flatMap(role => taskChoice("agents", role.name, role.name)));
      return { detail: `第 ${page} 页 · 共 ${result.roles.length} 项\n${formatConversationAgents({ ...result, roles: result.roles.slice((page - 1) * 8, page * 8) }, true)}\n使用：/agents <完整角色名称> <任务>；本页序号仅用于展示。`, choices };
    }
    case "plugins": {
      result.plugins.forEach((plugin, index) => choices.push({ label: plugin.displayName, command: "plugin", input: result.selectors[index]!, expectedName: plugin.id }));
      const suffix = result.searchTerm ? ` search ${result.searchTerm}` : "";
      if (result.page > 1) choices.push({ label: "上一页", command: "plugin", input: `list ${result.page - 1}${suffix}` });
      if (result.page < result.pageCount) choices.push({ label: "下一页", command: "plugin", input: `list ${result.page + 1}${suffix}` });
      return { detail: formatConversationPlugins(result, true), choices };
    }
    case "plugin-detail": {
      if (result.plugin.enabled && result.plugin.available && !["list", "health"].includes(result.plugin.id)) {
        choices.push(...taskChoice("plugin", "填写插件任务", result.plugin.id));
      }
      return { detail: `${formatConversationPluginDetail(result, true)}\n使用：/plugin <完整 ID> <任务>。`, choices };
    }
    case "plugin-health": return { detail: formatConversationPluginHealth(result), choices };
    case "mcp": {
      if (!paginate(result.servers.length, "mcp", "")) return;
      const servers = result.servers.slice((page - 1) * 8, page * 8);
      choices.unshift(...servers.map((server, index) => ({ label: server.name, command: "mcp" as const,
        input: String((page - 1) * 8 + index + 1), expectedName: server.name })));
      // Display authoritative global indices, not page-local command selectors.
      const detail = `MCP 第 ${page} 页 · 共 ${result.servers.length} 项\n${formatConversationMcp({ kind: "mcp", servers }, (page - 1) * 8)}`;
      return { detail, choices };
    }
    case "mcp-health": return { detail: formatConversationMcpHealth(result), choices };
    case "mcp-login": return result.login.type === "oauth"
      ? { detail: `MCP OAuth 登录已启动\nServer：${result.login.server}\n请点击“浏览器授权”完成登录；本机地址需在运行 App Server 的电脑打开。未收到完成通知时，可查询 MCP 实际状态。`,
        choices, authorizationUrl: result.login.authorizationUrl }
      : { detail: formatConversationMcpLogin(result), choices };
    case "mcp-reload": return { detail: formatConversationMcpReload(result), choices };
    case "mcp-resource": return { detail: formatConversationMcpResource(result), choices };
    case "mcp-detail": {
      if (supportsMcpOAuthLogin(result.server.authStatus)) choices.push({ label: "登录认证", command: "mcp", input: `login ${result.selector}`, expectedName: result.server.name });
      for (const [section, label] of [["tools", "工具"], ["resources", "资源目录"], ["templates", "资源模板"]] as const) {
        choices.push({ label, command: "mcp", input: `${result.selector} ${section}`, expectedName: result.server.name });
      }
      if (result.view) {
        const view = result.view;
        const suffix = view.searchTerm ? ` search ${view.searchTerm}` : "";
        for (const next of [view.page - 1, view.page + 1]) {
          if (next < 1 || next > mcpDetailPageCount(result)) continue;
          choices.push({ label: next < view.page ? "上一页" : "下一页", command: "mcp",
            input: `${result.selector} ${view.section} ${next}${suffix}`, expectedName: result.server.name });
        }
      }
      return { detail: formatConversationMcpDetail(result), choices };
    }
    case "hooks": {
      const view = result.view;
      if (view.confirmation || view.updated) return;
      if (view.detail) choices.push({ label: "返回列表", command: "hooks", input: `page ${view.page}` });
      else {
        choices.push(...view.entries.map(entry => ({ label: entry.hook.eventName, command: "hooks" as const, input: entry.selector })));
        if (view.page > 1) choices.push({ label: "上一页", command: "hooks", input: `page ${view.page - 1}` });
        if (view.page < view.pageCount) choices.push({ label: "下一页", command: "hooks", input: `page ${view.page + 1}` });
      }
      return { detail: formatConversationHooks(view, true), choices };
    }
    case "occupancy": return { detail: formatConversationOccupancy(result, undefined, true), choices };
    default: return;
  }
}
