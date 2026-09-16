import { describe, expect, it } from "vitest";

import {
  conversationCommandHelpLines,
  formatConversationAgents,
  formatConversationCommandOutcome,
  formatConversationMcp,
  formatConversationMcpDetail,
  formatConversationMcpHealth,
  formatConversationMcpLogin,
  formatConversationMcpReload,
  formatConversationMcpResource,
  formatConversationPluginDetail,
  formatConversationPluginHealth,
  formatConversationPlugins,
} from "../src/surfaces/conversation-command-format.js";

describe("conversation extension command formatting", () => {
  it("renders agent roles with numbers and usage", () => {
    const rendered = formatConversationAgents({
      kind: "agents",
      roles: [
        { name: "default", description: "默认角色，继承当前模型与配置" },
        { name: "external", description: "第三方模型子代理" },
      ],
    });

    expect(rendered).toContain("## 子代理角色（2）");
    expect(rendered).toContain("1. default：默认角色，继承当前模型与配置");
    expect(rendered).toContain("2. external：第三方模型子代理");
    expect(rendered).toContain("- 使用：/agents <角色名称或序号> <任务>");
  });

  it("renders agent invocation outcomes", () => {
    expect(formatConversationCommandOutcome({
      type: "agents.started",
      roleName: "external",
      turnId: "turn-1",
      steered: false,
    })).toContain("已使用子代理开始任务");
    expect(formatConversationCommandOutcome({
      type: "agents.started",
      roleName: "external",
      turnId: "turn-1",
      steered: true,
    })).toContain("已把子代理任务追加到当前任务");
  });

  it("documents /agents in the shared help output", () => {
    expect(conversationCommandHelpLines.join("\n"))
      .toContain("/agents [角色名称或序号 任务]");
  });

  it("renders the experimental Plugin list and invocation outcomes", () => {
    const help = conversationCommandHelpLines.join("\n");
    expect(help).toContain("/plugin · /plugin health");
    expect(help).toContain("/plugin list [页码] [search <关键词>]");
    expect(help).not.toContain("/plugins");
    const rendered = formatConversationPlugins({
      kind: "plugins",
      plugins: [{
        id: "github@local",
        name: "github",
        displayName: "GitHub",
        marketplaceName: "local",
        description: "GitHub development tools",
        enabled: true,
        available: true,
        version: "0.1.8",
        localVersion: "0.1.8",
        source: "remote",
        installedAt: 1_786_294_800,
        developerName: "OpenAI",
        category: "Developer tools",
        capabilities: ["Repository inspection"],
        authPolicy: "onUse",
        eligiblePlanTypes: [],
        disabledReason: null,
      }],
      selectors: ["1"],
      loadErrorCount: 1,
      totalPluginCount: 1,
      matchedPluginCount: 1,
      page: 1,
      pageCount: 1,
      searchTerm: null,
    });

    expect(rendered).toContain("已安装 Plugin（开发中，共 1 · 第 1/1 页）");
    expect(rendered).toContain("1. GitHub · github@local");
    expect(rendered).toContain("1 个 Plugin Marketplace 加载失败");
    expect(rendered).toContain("详情：/plugin <名称、完整 ID 或序号>");
    expect(rendered).toContain("调用：/plugin <名称、完整 ID 或序号> <任务>");
    const unavailableList = formatConversationPlugins({
      kind: "plugins",
      plugins: [{
        ...detailPluginFixture,
        enabled: false,
        available: false,
        disabledReason: "plan_not_eligible",
      }],
      selectors: ["1"],
      loadErrorCount: 0,
      totalPluginCount: 1,
      matchedPluginCount: 1,
      page: 1,
      pageCount: 1,
      searchTerm: null,
    });
    expect(unavailableList).toContain("不可用");
    expect(unavailableList).not.toContain("管理员禁用");
    const reservedNameList = formatConversationPlugins({
      kind: "plugins",
      plugins: [{
        ...detailPluginFixture,
        id: "health@local",
        name: "health",
        displayName: "Health",
      }],
      selectors: ["4"],
      loadErrorCount: 0,
      totalPluginCount: 4,
      matchedPluginCount: 4,
      page: 1,
      pageCount: 1,
      searchTerm: null,
    });
    expect(reservedNameList).toContain(
      "名称为 health 或 list 时，查看详情请使用完整 ID 或序号",
    );
    const searchedPage = formatConversationPlugins({
      kind: "plugins",
      plugins: [detailPluginFixture],
      selectors: ["9"],
      loadErrorCount: 0,
      totalPluginCount: 12,
      matchedPluginCount: 9,
      page: 2,
      pageCount: 2,
      searchTerm: "github",
    });
    expect(searchedPage).toContain("匹配 9 · 第 2/2 页");
    expect(searchedPage).toContain("9. GitHub");
    expect(searchedPage).toContain("上一页：/plugin list 1 search github");
    const missingPage = formatConversationPlugins({
      kind: "plugins",
      plugins: [],
      selectors: [],
      loadErrorCount: 0,
      totalPluginCount: 12,
      matchedPluginCount: 9,
      page: 3,
      pageCount: 2,
      searchTerm: "github",
    });
    expect(missingPage).toContain("第 3 页不存在，共 2 页");
    expect(missingPage).toContain("/plugin list 1 search github");
    const incompleteMissingPage = formatConversationPlugins({
      kind: "plugins",
      plugins: [],
      selectors: [],
      loadErrorCount: 2,
      totalPluginCount: 12,
      matchedPluginCount: 9,
      page: 3,
      pageCount: 2,
      searchTerm: "github",
    });
    expect(incompleteMissingPage).toContain("2 个 Plugin Marketplace 加载失败");
    const incompleteEmptySearch = formatConversationPlugins({
      kind: "plugins",
      plugins: [],
      selectors: [],
      loadErrorCount: 2,
      totalPluginCount: 12,
      matchedPluginCount: 0,
      page: 1,
      pageCount: 1,
      searchTerm: "missing",
    });
    expect(incompleteEmptySearch).toContain("2 个 Plugin Marketplace 加载失败");
    const health = formatConversationPluginHealth({
      kind: "plugin-health",
      report: {
        installedCount: 12,
        enabledCount: 10,
        callableCount: 2,
        marketplaceLoadErrorCount: 1,
        issues: Array.from({ length: 10 }, (_, index) => ({
          type: index === 0 ? "notEnabled" as const : "unavailable" as const,
          plugin: `Plugin ${index + 1}`,
          selector: String(index + 1),
          reason: index === 0 ? null : "plan_not_eligible" as const,
        })),
      },
    });
    expect(health).toContain("Plugin 健康（开发中）");
    expect(health).toContain("可调用：2");
    expect(health).toContain("Plugin 1 · 未启用 · 详情：/plugin 1");
    expect(health).toContain("Plugin 8");
    expect(health).not.toContain("Plugin 9 ·");
    expect(health).toContain("其余 2 项已省略");
    const detail = formatConversationPluginDetail({
      kind: "plugin-detail",
      plugin: {
        id: "github@openai-curated-remote",
        name: "github",
        displayName: "GitHub",
        marketplaceName: "openai-curated-remote",
        description: "GitHub development tools",
        enabled: true,
        available: true,
        version: "0.1.8",
        localVersion: "0.1.8-2841cf9749ae",
        source: "remote",
        installedAt: 1_786_294_800,
        developerName: "OpenAI",
        category: "Developer tools",
        capabilities: Array.from({ length: 10 }, (_, index) => `capability-${index + 1}`),
        authPolicy: "onUse",
        eligiblePlanTypes: [],
        disabledReason: null,
      },
    });
    expect(detail).toContain("Plugin：GitHub");
    expect(detail).toContain("来源：远端");
    expect(detail).toContain("远端版本：0.1.8");
    expect(detail).toContain("本地版本：0.1.8-2841cf9749ae");
    expect(detail).toContain("开发者：OpenAI");
    expect(detail).toContain("分类：Developer tools");
    expect(detail).toContain("认证时机：使用时");
    expect(detail).toContain("能力：capability-1");
    expect(detail).toContain("capability-8（另有 2 项）");
    expect(detail).not.toContain("capability-9");
    expect(detail).toContain("调用：/plugin github@openai-curated-remote <任务>");
    const unavailable = formatConversationPluginDetail({
      kind: "plugin-detail",
      plugin: {
        ...detailPluginFixture,
        enabled: false,
        available: false,
        disabledReason: "plan_not_eligible",
        authPolicy: "onInstall",
        eligiblePlanTypes: ["plus", "pro"],
      },
    });
    expect(unavailable).toContain("状态：不可用");
    expect(unavailable).toContain("不可用原因：当前套餐不可用");
    expect(unavailable).toContain("认证时机：安装时");
    expect(unavailable).toContain("适用套餐（上游标识）：plus、pro");
    expect(unavailable).toContain("当前 Plugin 不可调用");
    const outcome = formatConversationCommandOutcome({
      type: "plugin.started",
      pluginName: "GitHub",
      turnId: "turn-1",
      steered: false,
    });
    expect(outcome).toContain("已使用 Plugin 开始任务");
    expect(outcome).toContain("Plugin：GitHub");
  });

  it("renders MCP overview, full detail, OAuth, and bounded resource output", () => {
    expect(conversationCommandHelpLines.join("\n")).toContain(
      "/mcp <名称或序号> <tools|resources|templates> [页码] [search <关键词>]",
    );
    const mcpOverview = formatConversationMcp({
      kind: "mcp",
      servers: [{
        name: "project-tools",
        runtimeStatus: "authenticationRequired",
        pluginId: null,
        authStatus: "notLoggedIn",
        toolCount: 1,
        toolDiscoveryFailed: false,
      }],
    });
    expect(mcpOverview).toContain("1. project-tools · 运行：需要认证");
    expect(mcpOverview).toContain("  - 详情：/mcp 1");
    expect(mcpOverview).not.toContain("/mcp <名称或序号>");

    expect(formatConversationMcpHealth({
      kind: "mcp-health",
      report: {
        serverCount: 5,
        toolCount: 1,
        resourceCount: 0,
        resourceTemplateCount: 0,
        actions: [
          { type: "loginRequired", server: "oauth tools", selector: "1" },
          { type: "reconnectRecommended", server: "failed", selector: "4" },
          { type: "toolDiscoveryFailed", server: "broken tools", selector: "6" },
        ],
        notices: [
          { type: "authUnknown", server: "unknown auth", selector: "2" },
          { type: "disabled", server: "empty", selector: "3" },
          { type: "starting", server: "starting", selector: "5" },
        ],
      },
    })).toBe([
      "## MCP 健康检查",
      "- 状态：发现 3 项需要处理",
      "- Server：5 个 · 工具：1 个 · 资源：0 个 · 资源模板：0 个",
      "### 需要处理",
      "- oauth tools：尚未登录",
      "  - 处理：/mcp login 1",
      "- failed：连接失败或已取消",
      "  - 处理：/mcp reload",
      "- broken tools：工具目录读取失败",
      "  - 处理：/mcp reload",
      "### 提示",
      "- unknown auth：认证状态未知，可检查配置或尝试 /mcp login 2",
      "- empty：已禁用",
      "- starting：正在连接",
    ].join("\n"));
    expect(formatConversationMcpReload({ kind: "mcp-reload" })).toBe([
      "## MCP 配置重新加载",
      "- 状态：已请求",
      "- 生效：已加载 Session 已刷新 MCP 配置",
      "- 提示：无需重启 Codex App Server；连接结果请再次使用 /mcp health 查询",
    ].join("\n"));

    const detail = formatConversationMcpDetail({
      kind: "mcp-detail",
      selector: "1",
      server: {
        name: "Project Tools",
        runtimeStatus: "authenticationRequired",
        pluginId: "github@local",
        authStatus: "notLoggedIn",
        toolCount: 1,
        toolDiscoveryFailed: false,
        serverTitle: "Project Tools",
        serverVersion: "1.0.0",
        serverDescription: null,
        tools: [{ name: "search", title: "Search", description: null, access: "readOnly" }],
        resources: [{
          uri: "project://readme",
          name: "readme",
          title: "README",
          description: null,
          mimeType: "text/plain",
        }],
        resourceTemplates: [],
      },
    });
    expect(detail).toContain("MCP Server：Project Tools");
    expect(detail).toContain("来源 Plugin：github@local");
    expect(detail).toContain("Search · search");
    expect(detail).toContain("上游标记只读");
    expect(detail).toContain("实际调用仍按审批策略处理");
    expect(detail).toContain("project://readme");
    expect(detail).toContain("OAuth：/mcp login 1");
    expect(detail).toContain("浏览工具：/mcp 1 tools");
    expect(detail).toContain("浏览资源：/mcp 1 resources");
    expect(detail).toContain("读取资源：/mcp resource 1 <URI>");

    const bearerTokenDetail = formatConversationMcpDetail({
      kind: "mcp-detail",
      selector: "codex_apps",
      server: {
        name: "codex_apps",
        runtimeStatus: "connected",
        pluginId: null,
        authStatus: "bearerToken",
        toolCount: 0,
        toolDiscoveryFailed: false,
        serverTitle: null,
        serverVersion: "0.1.0",
        serverDescription: null,
        tools: [],
        resources: [],
        resourceTemplates: [],
      },
    });
    expect(bearerTokenDetail).not.toContain("/mcp login");

    const longResourceUri = `project://resource/1/${"x".repeat(2_000)}`;
    const oversizedDetail = formatConversationMcpDetail({
      kind: "mcp-detail",
      selector: "large",
      server: {
        name: "large",
        runtimeStatus: "connected",
        pluginId: null,
        authStatus: "oAuth",
        toolCount: 20,
        toolDiscoveryFailed: false,
        serverTitle: null,
        serverVersion: "1.0.0",
        serverDescription: "d".repeat(2_000),
        tools: Array.from({ length: 20 }, (_, index) => ({
          name: `tool-${index + 1}`,
          title: `Tool ${index + 1}`,
          description: "d".repeat(2_000),
          access: "unknown" as const,
        })),
        resources: Array.from({ length: 20 }, (_, index) => ({
          uri: index === 0
            ? longResourceUri
            : `project://resource/${index + 1}/${"x".repeat(2_000)}`,
          name: `resource-${index + 1}`,
          title: null,
          description: null,
          mimeType: "text/plain",
        })),
        resourceTemplates: Array.from({ length: 20 }, (_, index) => ({
          uriTemplate: `project://template/${index + 1}/{path}/${"x".repeat(2_000)}`,
          name: `template-${index + 1}`,
          title: null,
          description: null,
          mimeType: "text/plain",
        })),
      },
    });
    expect(oversizedDetail.length).toBeLessThanOrEqual(20_000);
    expect(oversizedDetail).toContain("项已省略");
    expect(oversizedDetail).toContain(longResourceUri);
    expect(oversizedDetail).not.toContain("tool-9");

    expect(formatConversationMcpLogin({
      kind: "mcp-login",
      login: {
        type: "oauth",
        server: "project-tools",
        authorizationUrl: "https://example.test/oauth",
      },
    })).toContain("https://example.test/oauth");
    expect(formatConversationMcpLogin({
      kind: "mcp-login",
      login: {
        type: "bearerToken",
        server: "token-tools",
      },
    })).toBe([
      "## MCP 认证",
      "- Server：token-tools",
      "- 状态：已使用 Bearer Token 认证，无需 OAuth 登录",
    ].join("\n"));

    const resource = formatConversationMcpResource({
      kind: "mcp-resource",
      resource: {
        server: "project-tools",
        requestedUri: "project://readme",
        contents: [{
          kind: "text",
          uri: "project://readme",
          mimeType: "text/plain",
          text: "untrusted ``` content",
          truncated: true,
        }],
        omittedContentCount: 2,
      },
    });
    expect(resource).toContain("外部不可信内容");
    expect(resource).toContain("untrusted ``\u200b` content");
    expect(resource).toContain("已截断");
    expect(resource).toContain("其余 2 个内容已省略");

    const longRequestedUri = `project://requested/${"r".repeat(4_000)}`;
    const longContentUri = `project://content/${"c".repeat(4_000)}`;
    const boundedResource = formatConversationMcpResource({
      kind: "mcp-resource",
      resource: {
        server: "s".repeat(512),
        requestedUri: longRequestedUri,
        contents: [{
          kind: "text",
          uri: longContentUri,
          mimeType: "text/plain",
          text: "```".repeat(2_666),
          truncated: true,
        }],
        omittedContentCount: 0,
      },
    });
    expect(boundedResource.length).toBeLessThanOrEqual(20_000);
    expect(boundedResource).toContain(longRequestedUri);
    expect(boundedResource).toContain(longContentUri);
  });

  it("bounds MCP health findings and reports omitted entries", () => {
    const rendered = formatConversationMcpHealth({
      kind: "mcp-health",
      report: {
        serverCount: 12,
        toolCount: 0,
        resourceCount: 0,
        resourceTemplateCount: 0,
        actions: Array.from({ length: 12 }, (_, index) => ({
          type: "loginRequired" as const,
          server: `server-${index + 1}`,
          selector: String(index + 1),
        })),
        notices: [],
      },
    });

    expect(rendered).toContain("处理：/mcp login 8");
    expect(rendered).not.toContain("server-9");
    expect(rendered).toContain("其余 4 项已省略");
  });

  it("renders a searchable MCP detail page with stable navigation commands", () => {
    const rendered = formatConversationMcpDetail({
      kind: "mcp-detail",
      selector: "1",
      server: {
        name: "codex_apps",
        runtimeStatus: "connected",
        pluginId: null,
        authStatus: "bearerToken",
        toolCount: 18,
        toolDiscoveryFailed: false,
        serverTitle: null,
        serverVersion: "0.1.0",
        serverDescription: null,
        tools: Array.from({ length: 18 }, (_, index) => ({
          name: `github-tool-${index + 1}`,
          title: `GitHub Tool ${index + 1}`,
          description: "GitHub connector tool",
          access: index % 2 === 0 ? "readOnly" as const : "writeCapable" as const,
        })),
        resources: [{
          uri: "plugin://github",
          name: "github",
          title: "GitHub",
          description: "Plugin resource",
          mimeType: "mcp/plugin",
        }],
        resourceTemplates: [],
      },
      view: {
        section: "tools",
        page: 2,
        searchTerm: "github",
      },
    });

    expect(rendered).toContain("工具（匹配 18 · 第 2/3 页）");
    expect(rendered).toContain("GitHub Tool 9 · github-tool-9");
    expect(rendered).toContain("GitHub Tool 16 · github-tool-16");
    expect(rendered).not.toContain("github-tool-8");
    expect(rendered).not.toContain("plugin://github");
    expect(rendered).toContain("上一页：/mcp 1 tools 1 search github");
    expect(rendered).toContain("下一页：/mcp 1 tools 3 search github");

    const missingPage = formatConversationMcpDetail({
      kind: "mcp-detail",
      selector: "1",
      server: {
        name: "codex_apps",
        runtimeStatus: "connected",
        pluginId: null,
        authStatus: "bearerToken",
        toolCount: 1,
        toolDiscoveryFailed: false,
        serverTitle: null,
        serverVersion: "0.1.0",
        serverDescription: null,
        tools: [{ name: "github", title: null, description: null, access: "unknown" }],
        resources: [],
        resourceTemplates: [],
      },
      view: {
        section: "tools",
        page: 2,
        searchTerm: null,
      },
    });
    expect(missingPage).toContain("第 2 页不存在，共 1 页");
    expect(missingPage).toContain("返回第一页：/mcp 1 tools 1");
  });

});

const detailPluginFixture = {
  id: "github@openai-curated-remote",
  name: "github",
  displayName: "GitHub",
  marketplaceName: "openai-curated-remote",
  description: "GitHub development tools",
  enabled: true,
  available: true,
  version: "0.1.8",
  localVersion: "0.1.8-2841cf9749ae",
  source: "remote" as const,
  installedAt: 1_786_294_800,
  developerName: "OpenAI",
  category: "Developer tools",
  capabilities: ["Repository inspection"],
  authPolicy: "onUse" as const,
  eligiblePlanTypes: [],
  disabledReason: null,
};
