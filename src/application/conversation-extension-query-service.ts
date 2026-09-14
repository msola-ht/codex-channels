import {
  UserFacingError,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { SessionRouter } from "../session-routing/index.js";

import type {
  McpHealthReport,
  McpLoginResult,
  McpQueryPort,
  McpResourceReadResult,
  McpServerDetail,
  McpServerSummary,
} from "./mcp-port.js";
import { supportsMcpOAuthLogin } from "./mcp-port.js";
import type {
  ModelSelectionService,
  ModelSelectionState,
} from "./model-selection-service.js";
import type {
  InstalledPlugin,
  InstalledPluginCatalog,
  PluginHealthReport,
  PluginQueryPort,
} from "./plugin-port.js";
import type {
  PermissionProfileOption,
  PermissionQueryPort,
} from "./permission-port.js";
import type { InstalledSkill, SkillQueryPort } from "./skill-port.js";

export type ConversationExtensionQueryPort =
  & SkillQueryPort
  & McpQueryPort
  & PluginQueryPort
  & PermissionQueryPort;

export class ConversationExtensionQueryService {
  constructor(
    private readonly router: SessionRouter,
    private readonly models: ModelSelectionService,
    private readonly queries: ConversationExtensionQueryPort,
    private readonly pluginApiEnabled: boolean,
  ) {}

  modelState(target: ConversationTarget): Promise<ModelSelectionState> {
    return this.models.state(target);
  }

  clearModelBrowse(target: ConversationTarget): Promise<ModelSelectionState> {
    this.models.clearProviderBrowse(target);
    return this.models.state(target);
  }

  browseProviderModels(
    target: ConversationTarget,
    provider: string,
  ): Promise<ModelSelectionState> {
    return this.models.browseProvider(target, provider);
  }

  clearModelSelection(target: ConversationTarget): Promise<ModelSelectionState> {
    this.models.clear(target);
    return this.models.state(target);
  }

  listSkills(target: ConversationTarget): Promise<InstalledSkill[]> {
    return this.queries.listSkills(this.router.workspace(target).cwd);
  }

  async resolveSkillName(cwd: string, selector: string): Promise<string> {
    if (!/^[1-9]\d*$/u.test(selector)) {
      return selector;
    }
    const index = Number(selector);
    if (!Number.isSafeInteger(index)) {
      throw new UserFacingError("skill.not-found", "Skill 序号不存在");
    }
    const skill = (await this.queries.listSkills(cwd))[index - 1];
    if (!skill) {
      throw new UserFacingError("skill.not-found", "Skill 序号不存在");
    }
    return skill.name;
  }

  listMcpServers(target: ConversationTarget): Promise<McpServerSummary[]> {
    return this.queries.listMcpServers(this.router.current(target)?.threadId);
  }

  async mcpHealth(target: ConversationTarget): Promise<McpHealthReport> {
    const servers = await this.queries.listMcpServerDetails(
      this.router.current(target)?.threadId,
    );
    return {
      serverCount: servers.length,
      toolCount: servers.reduce((total, server) => total + server.tools.length, 0),
      resourceCount: servers.reduce(
        (total, server) => total + server.resources.length,
        0,
      ),
      resourceTemplateCount: servers.reduce(
        (total, server) => total + server.resourceTemplates.length,
        0,
      ),
      actions: servers.flatMap<McpHealthReport["actions"][number]>((server, index) => {
        const selector = String(index + 1);
        if (
          server.runtimeStatus === "authenticationRequired"
          || server.authStatus === "notLoggedIn"
        ) {
          return [{ type: "loginRequired" as const, server: server.name, selector }];
        }
        if (server.runtimeStatus === "failed" || server.runtimeStatus === "cancelled") {
          return [{
            type: "reconnectRecommended" as const,
            server: server.name,
            selector,
          }];
        }
        if (server.toolDiscoveryFailed) {
          return [{
            type: "toolDiscoveryFailed" as const,
            server: server.name,
            selector,
          }];
        }
        return [];
      }),
      notices: servers.flatMap((server, index) => [
        ...(server.authStatus === "unknown"
          && server.runtimeStatus !== "authenticationRequired"
          ? [{
              type: "authUnknown" as const,
              server: server.name,
              selector: String(index + 1),
            }]
          : []),
        ...(server.runtimeStatus === "connected"
          && server.authStatus !== "notLoggedIn"
          && server.authStatus !== "unknown"
          && !server.toolDiscoveryFailed
          && server.tools.length === 0
          && server.resources.length === 0
          && server.resourceTemplates.length === 0
          ? [{
              type: "noCapabilities" as const,
              server: server.name,
              selector: String(index + 1),
            }]
          : []),
        ...(server.runtimeStatus === "notStarted"
          ? [{ type: "notStarted" as const, server: server.name, selector: String(index + 1) }]
          : []),
        ...(server.runtimeStatus === "starting"
          ? [{ type: "starting" as const, server: server.name, selector: String(index + 1) }]
          : []),
        ...(server.runtimeStatus === "disabled"
          ? [{ type: "disabled" as const, server: server.name, selector: String(index + 1) }]
          : []),
      ]),
    };
  }

  reloadMcpServers(): Promise<void> {
    return this.queries.reloadMcpServers();
  }

  async mcpServerDetail(
    target: ConversationTarget,
    selector: string,
  ): Promise<McpServerDetail> {
    return resolveMcpServer(
      selector,
      await this.queries.listMcpServerDetails(this.router.current(target)?.threadId),
    );
  }

  async loginMcpServer(
    target: ConversationTarget,
    selector: string,
  ): Promise<McpLoginResult> {
    const threadId = this.router.current(target)?.threadId;
    const server = resolveMcpServer(
      selector,
      await this.queries.listMcpServers(threadId),
    );
    if (server.authStatus === "bearerToken") {
      return { type: "bearerToken", server: server.name };
    }
    if (!supportsMcpOAuthLogin(server.authStatus)) {
      throw new UserFacingError(
        "mcp.oauth.unsupported",
        "该 MCP Server 不支持 OAuth 登录",
      );
    }
    if (!threadId) {
      throw new UserFacingError(
        "mcp.thread.required",
        "请先发送消息创建 Session，或使用 /resume 恢复 Session 后再登录 MCP Server",
      );
    }
    return {
      type: "oauth",
      ...await this.queries.startMcpOAuthLogin(server.name, threadId),
    };
  }

  async readMcpResource(
    target: ConversationTarget,
    selector: string,
    uri: string,
  ): Promise<McpResourceReadResult> {
    const normalizedUri = uri.trim();
    if (
      normalizedUri.length === 0
      || normalizedUri.length > 4_096
      || hasControlCharacters(normalizedUri)
    ) {
      throw new UserFacingError("mcp.resource.usage", "需要提供有效的 MCP Resource URI");
    }
    const threadId = this.router.current(target)?.threadId;
    const server = resolveMcpServer(
      selector,
      await this.queries.listMcpServers(threadId),
    );
    return this.queries.readMcpResource(server.name, normalizedUri, threadId);
  }

  listPlugins(target: ConversationTarget): Promise<InstalledPluginCatalog> {
    this.assertPluginApiEnabled();
    return this.queries.listPlugins(this.router.workspace(target).cwd);
  }

  async pluginHealth(target: ConversationTarget): Promise<PluginHealthReport> {
    const catalog = await this.listPlugins(target);
    const issues: PluginHealthReport["issues"] = [];
    catalog.plugins.forEach((plugin, index) => {
      if (!plugin.available) {
        issues.push({
          type: "unavailable",
          plugin: plugin.displayName,
          selector: String(index + 1),
          reason: plugin.disabledReason,
        });
      } else if (!plugin.enabled) {
        issues.push({
          type: "notEnabled",
          plugin: plugin.displayName,
          selector: String(index + 1),
          reason: null,
        });
      }
    });
    return {
      installedCount: catalog.plugins.length,
      enabledCount: catalog.plugins.filter((plugin) => plugin.enabled).length,
      callableCount: catalog.plugins.filter((plugin) =>
        plugin.enabled && plugin.available
      ).length,
      marketplaceLoadErrorCount: catalog.loadErrorCount,
      issues,
    };
  }

  pluginDetail(
    target: ConversationTarget,
    selector: string,
  ): Promise<InstalledPlugin> {
    this.assertPluginApiEnabled();
    return this.resolvePlugin(this.router.workspace(target).cwd, selector);
  }

  async resolvePlugin(cwd: string, selector: string): Promise<InstalledPlugin> {
    const { plugins } = await this.queries.listPlugins(cwd);
    if (/^[1-9]\d*$/u.test(selector)) {
      const index = Number(selector);
      const plugin = Number.isSafeInteger(index) ? plugins[index - 1] : undefined;
      if (!plugin) {
        throw new UserFacingError("plugin.not-found", "Plugin 序号不存在");
      }
      return plugin;
    }
    const normalized = selector.toLowerCase();
    const matches = plugins.filter((plugin) =>
      plugin.id.toLowerCase() === normalized
      || plugin.name.toLowerCase() === normalized
      || plugin.displayName.toLowerCase() === normalized
    );
    if (matches.length !== 1) {
      throw new UserFacingError(
        matches.length === 0 ? "plugin.not-found" : "plugin.ambiguous",
        matches.length === 0
          ? "指定的 Plugin 不存在"
          : "Plugin 名称不唯一，请使用序号或完整 ID",
      );
    }
    return matches[0]!;
  }

  assertPluginApiEnabled(): void {
    if (!this.pluginApiEnabled) {
      throw new UserFacingError(
        "plugin.disabled",
        "开发中的 Plugin API 已关闭；请在 [experimental] 中启用 plugin_api 后重启 Gateway",
      );
    }
  }

  listPermissionProfiles(
    target: ConversationTarget,
  ): Promise<PermissionProfileOption[]> {
    return this.queries.listPermissionProfiles(this.router.workspace(target).cwd);
  }
}

function resolveMcpServer<T extends McpServerSummary>(
  selector: string,
  servers: readonly T[],
): T {
  const normalizedSelector = selector.trim();
  if (!normalizedSelector) {
    throw new UserFacingError("mcp.server.usage", "需要提供 MCP Server 名称或序号");
  }
  if (/^[1-9]\d*$/u.test(normalizedSelector)) {
    const index = Number(normalizedSelector);
    const server = Number.isSafeInteger(index) ? servers[index - 1] : undefined;
    if (server) return server;
  } else {
    const server = servers.find((candidate) =>
      candidate.name.toLowerCase() === normalizedSelector.toLowerCase()
    );
    if (server) return server;
  }
  throw new UserFacingError("mcp.server.not-found", "指定的 MCP Server 不存在");
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}
