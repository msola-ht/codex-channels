import { describe, expect, it } from "vitest";

import {
  conversationCommandHelpLines,
  formatConversationAgents,
  formatConversationCommandOutcome,
  formatConversationLimits,
  formatConversationMetrics,
  formatConversationMcp,
  formatConversationMcpDetail,
  formatConversationMcpHealth,
  formatConversationMcpLogin,
  formatConversationMcpReload,
  formatConversationMcpResource,
  formatConversationModels,
  formatConversationPluginDetail,
  formatConversationPluginHealth,
  formatConversationPlugins,
  formatConversationStatus,
  formatConversationUsage,
  formatConversationWorkspacePermissions,
  formatConversationWorkspaces,
} from "../src/surfaces/conversation-command-format.js";
import { formatCurrencyNanos } from "../src/surfaces/reference-cost-format.js";

describe("provider-aware conversation command formatting", () => {
  it("shows configured workspace permissions in the workspace list", () => {
    const rendered = formatConversationWorkspaces({
      kind: "workspaces",
      workspaces: [
        {
          id: "main",
          name: "Main",
          cwd: "/workspace",
          sandbox: "danger-full-access",
          approvalPolicy: "never",
        },
        {
          id: "docs",
          name: "Docs",
          cwd: "/docs",
          permissions: ":read-only",
        },
      ],
      currentWorkspaceId: "main",
    });

    expect(rendered).toContain("1. Main · main ← 当前");
    expect(rendered).toContain("- 沙箱：完全访问");
    expect(rendered).toContain("- 审批：免审批");
    expect(rendered).toContain("- 权限 Profile：:read-only");
  });

  it("renders agent roles with numbers and usage", () => {
    const rendered = formatConversationAgents({
      kind: "agents",
      roles: [
        { name: "default", description: "默认角色，继承当前模型与配置" },
        { name: "ds", description: "DeepSeek 子代理" },
      ],
    });

    expect(rendered).toContain("## 子代理角色（2）");
    expect(rendered).toContain("1. default：默认角色，继承当前模型与配置");
    expect(rendered).toContain("2. ds：DeepSeek 子代理");
    expect(rendered).toContain("- 使用：/agents <角色名称或序号> <任务>");
  });

  it("renders agent invocation outcomes", () => {
    expect(formatConversationCommandOutcome({
      type: "agents.started",
      roleName: "ds",
      turnId: "turn-1",
      steered: false,
    })).toContain("已使用子代理开始任务");
    expect(formatConversationCommandOutcome({
      type: "agents.started",
      roleName: "ds",
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
    expect(formatConversationMcp({
      kind: "mcp",
      servers: [{ name: "project-tools", authStatus: "notLoggedIn", toolCount: 1 }],
    })).toContain("1. project-tools");

    expect(formatConversationMcpHealth({
      kind: "mcp-health",
      report: {
        serverCount: 3,
        toolCount: 1,
        resourceCount: 0,
        resourceTemplateCount: 0,
        actions: [{ type: "loginRequired", server: "oauth tools", selector: "1" }],
        notices: [
          { type: "authUnknown", server: "unknown auth", selector: "2" },
          { type: "noCapabilities", server: "empty", selector: "3" },
        ],
      },
    })).toBe([
      "## MCP 健康检查",
      "- 状态：发现 1 项需要处理",
      "- Server：3 个 · 工具：1 个 · 资源：0 个 · 资源模板：0 个",
      "### 需要处理",
      "- oauth tools：尚未登录",
      "  - 处理：/mcp login 1",
      "### 提示",
      "- unknown auth：认证状态未知，可检查配置或尝试 /mcp login 2",
      "- empty：未公开工具、资源或资源模板",
    ].join("\n"));
    expect(formatConversationMcpReload({ kind: "mcp-reload" })).toBe([
      "## MCP 配置重新加载",
      "- 状态：已请求",
      "- 生效：已加载 Thread 会在下一次活动 Turn 时刷新",
      "- 提示：无需重启 Codex App Server",
    ].join("\n"));

    const detail = formatConversationMcpDetail({
      kind: "mcp-detail",
      selector: "1",
      server: {
        name: "Project Tools",
        authStatus: "notLoggedIn",
        toolCount: 1,
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
        authStatus: "bearerToken",
        toolCount: 0,
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
        authStatus: "oAuth",
        toolCount: 20,
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
        authStatus: "bearerToken",
        toolCount: 18,
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
        authStatus: "bearerToken",
        toolCount: 1,
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

  it("shows workspace permission usage and current values", () => {
    const rendered = formatConversationWorkspacePermissions({
      kind: "workspace-permissions",
      workspace: {
        id: "main",
        name: "Main",
        cwd: "/workspace",
        sandbox: "read-only",
      },
    });

    expect(rendered).toContain("工作区权限（Main · main）");
    expect(rendered).toContain("- 沙箱：只读");
    expect(rendered).toContain("/workspaceperm approval");
    expect(rendered).toContain("/workspaceperm profile");
  });

  it("renders updated workspace permissions with the hot reload notice", () => {
    const rendered = formatConversationCommandOutcome({
      type: "workspace.permissions-updated",
      workspace: {
        id: "main",
        name: "Main",
        cwd: "/workspace",
        approvalPolicy: "never",
      },
    });

    expect(rendered).toContain("已更新工作区权限");
    expect(rendered).toContain("- 审批：免审批");
    expect(rendered).toContain("对新建或恢复的 Thread 生效");
  });

  it("warns that a pending Provider switch starts a new recoverable Thread", () => {
    const rendered = formatConversationModels({
      kind: "models",
      view: "model",
      state: {
        models: [{
          id: "deepseek-v4-flash",
          model: "deepseek-v4-flash",
          displayName: "DeepSeek-V4-Flash",
          provider: "deepseek",
          supportedReasoningEfforts: [{ effort: "high", description: "High" }],
          defaultReasoningEffort: "high",
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: false,
          inputModalities: ["text"],
        }],
        model: "deepseek-v4-flash",
        modelProvider: "deepseek",
        effort: "high",
        serviceTier: null,
        pending: true,
        modelPending: true,
        effortPending: false,
        serviceTierPending: false,
        providerPending: true,
      },
    });

    expect(rendered).toContain("下一条消息中创建新 Thread");
    expect(rendered).toContain("当前 Thread 会保留");
  });

  it("renders DeepSeek balance instead of OpenAI account usage", () => {
    const rendered = formatConversationUsage({
      kind: "usage",
      result: {
        kind: "balance",
        provider: "deepseek",
        available: true,
        balances: [{
          currency: "CNY",
          totalBalance: "110.00",
          grantedBalance: "10.00",
          toppedUpBalance: "100.00",
        }],
      },
    });

    expect(rendered).toContain("DeepSeek 账户余额");
    expect(rendered).toContain("总余额：110.00");
    expect(rendered).not.toContain("累计 Tokens");
  });

  it("fails closed for unregistered Provider account capabilities", () => {
    expect(formatConversationUsage({
      kind: "usage",
      result: { kind: "unsupported", provider: "future-provider" },
    })).toContain("future-provider 暂不支持账户用量查询");
    expect(formatConversationLimits({
      kind: "limits",
      result: { kind: "unsupported", provider: "future-provider" },
    })).toContain("可使用 /usage 查看该提供商已接入的账户信息");
  });

  it("renders weekly allowance estimates as local rounded samples", () => {
    const rendered = formatConversationLimits({
      kind: "limits",
      result: {
        kind: "rate-limits",
        provider: "openai",
        limits: {
          limits: [{
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 2_000_000 },
            secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 2_000_000 },
            credits: null,
            individualLimit: null,
            spendControlReached: false,
            planType: "plus",
            rateLimitReachedType: null,
          }],
          resetCreditsAvailable: null,
        },
        weeklyEstimates: [{
          limitId: "codex",
          startAtMs: 1_000,
          endAtMs: 2_000,
          usedPercent: 20,
          remainingPercent: 80,
          observedDeltaPercent: 2,
          intervalCount: 2,
          requestCount: 40,
          unsuccessfulRequestCount: 2,
          pricedRequestCount: 38,
          inputTokensPerPercent: 90_000,
          outputTokensPerPercent: 10_000,
          totalTokensPerPercent: 100_000,
          remainingTokens: 8_000_000,
          pricingCurrency: "USD",
          costPerPercentNanos: 200_000_000,
          remainingCostNanos: 16_000_000_000,
        }],
      },
    });

    expect(rendered).toContain("周限估算（本机代理样本）");
    expect(rendered).toContain("观测变化 2%（2 个区间）");
    expect(rendered).toContain("每 1%：约 100 K Token");
    expect(rendered).toContain("API 参考费用：约 $0.200000");
    expect(rendered).toContain("剩余 80%：约 8 M Token");
    expect(rendered).toContain("费用不是订阅实际扣款");
  });

  it("keeps Thread metrics and hides OpenAI-only state for DeepSeek", () => {
    const rendered = formatConversationStatus({
      threadId: "thread-deepseek",
      workspaceId: "main",
      workspaceName: "Main",
      cwd: "/workspace",
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      effort: "high",
      serviceTier: null,
      modelPending: false,
      effortPending: false,
      fastModePending: false,
      collaborationMode: "default",
      collaborationModePending: false,
      tokenUsage: {
        total: breakdown(30_000),
        last: breakdown(20_000),
        modelContextWindow: 1_048_576,
      },
      weeklyLimit: {
        usedPercent: 90,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
    });

    expect(rendered).toContain("提供商：DeepSeek");
    expect(rendered).toContain("Codex 有效上下文窗口：1.05 M");
    expect(rendered).not.toContain("Fast 模式");
    expect(rendered).not.toContain("周限");
  });

  it("renders latest Turn aggregation and direct API metrics separately", () => {
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        threadId: "thread-1",
        modelProvider: "deepseek",
        latestTurn: {
          turnId: "turn-1",
          requestCount: 3,
          unsuccessfulRequestCount: 1,
          requestDurationMs: 65_000,
          inputTokens: 30_000,
          cachedInputTokens: 24_000,
          outputTokens: 900,
          reasoningOutputTokens: 300,
          outputTokensPerSecond: 60.25,
          outputSpeedSampleCount: 3,
          outputSpeedTimedCount: 2,
          pricingCurrency: "USD",
          pricedRequestCount: 2,
          totalCostNanos: 1_234_567,
          inputCostNanos: 400_000,
          cachedInputCostNanos: 200_000,
          outputCostNanos: 634_567,
          uncachedInputPricePerMillionNanos: 140_000_000,
          cachedInputPricePerMillionNanos: 2_800_000,
          outputPricePerMillionNanos: 280_000_000,
          hasMixedPrices: false,
          compact: {
            model: "gpt-5.6-sol",
            hasMixedModels: false,
            requestCount: 1,
            unsuccessfulRequestCount: 0,
            inputTokens: 10_000,
            cachedInputTokens: 9_000,
            outputTokens: 500,
            pricingCurrency: "USD",
            pricedRequestCount: 1,
            totalCostNanos: 142_102_000,
          },
        },
        threadAggregate: {
          turnCount: 8,
          requestCount: 21,
          unsuccessfulRequestCount: 2,
          requestDurationMs: 142_000,
          inputTokens: 180_000,
          cachedInputTokens: 174_000,
          outputTokens: 4_200,
          reasoningOutputTokens: 1_800,
          outputTokensPerSecond: 58,
          outputSpeedSampleCount: 21,
          outputSpeedTimedCount: 20,
          pricingCurrency: "USD",
          pricedRequestCount: 20,
          totalCostNanos: 12_345_678,
          inputCostNanos: 4_000_000,
          cachedInputCostNanos: 2_000_000,
          outputCostNanos: 6_345_678,
          uncachedInputPricePerMillionNanos: 140_000_000,
          cachedInputPricePerMillionNanos: 2_800_000,
          outputPricePerMillionNanos: 280_000_000,
          hasMixedPrices: false,
          compact: {
            model: "gpt-5.6-sol",
            hasMixedModels: false,
            requestCount: 2,
            unsuccessfulRequestCount: 0,
            inputTokens: 20_000,
            cachedInputTokens: 18_000,
            outputTokens: 1_000,
            pricingCurrency: "USD",
            pricedRequestCount: 2,
            totalCostNanos: 284_204_000,
          },
        },
        latestDirectApi: {
          provider: "bltcy",
          providerName: "BLTCY",
          model: "gpt-5.6-luna",
          status: "completed",
          httpStatus: 200,
          requestDurationMs: 11_590,
          inputTokens: 10_034,
          cachedInputTokens: 0,
          outputTokens: 343,
          reasoningOutputTokens: 55,
          totalTokens: 10_377,
          pricingCurrency: "USD",
          totalCostNanos: 987_654,
          inputCostNanos: 300_000,
          cachedInputCostNanos: 100_000,
          outputCostNanos: 587_654,
          uncachedInputPricePerMillionNanos: 140_000_000,
          cachedInputPricePerMillionNanos: 2_800_000,
          outputPricePerMillionNanos: 280_000_000,
        },
      },
    });

    expect(rendered).toContain("模型请求：3 次（异常 1 次）");
    expect(rendered).toContain("模型请求聚合耗时：1分5秒");
    expect(rendered).toContain("模型请求累计耗时：2分22秒");
    expect(rendered).toContain("缓存命中率：80.00%");
    expect(rendered).toContain("其中推理输出：300");
    expect(rendered).toContain("其中推理输出：1.8 K");
    expect(rendered).toContain("其中推理输出：55");
    expect(rendered).toContain("### 最近运行聚合");
    expect(rendered).toContain("**Token**：30.9 K");
    expect(rendered).toContain("  - 输入命中缓存：24 K");
    expect(rendered).toContain("**Token**：184.2 K");
    expect(rendered).toContain("**费用**：$0.001235（计价 2/3）");
    expect(rendered).toContain("  - 输入价格：$0.000400");
    expect(rendered).toContain("综合输出速度：60 token/s（不含推理 · 覆盖 2/3 次请求）");
    expect(rendered).toContain("上下文压缩：1 次 · gpt-5.6-sol · 10.5 K Token · $0.142102");
    expect(rendered).toContain("**费用**：$0.001235（计价 2/3）");
    expect(rendered).toContain("输入价格：$0.000400");
    expect(rendered).toContain("缓存价格：$0.000200");
    expect(rendered).toContain("输出价格：$0.000635");
    expect(rendered).toContain("### 当前会话指标累计");
    expect(rendered).toContain("Turn：8 次");
    expect(rendered).toContain("上下文压缩：2 次 · gpt-5.6-sol · 21 K Token · $0.284204");
    expect(rendered).toContain("综合输出速度：58 token/s（不含推理 · 覆盖 20/21 次请求）");
    expect(rendered).toContain("### 最近直接 API");
    expect(rendered).toContain("API 提供商：BLTCY");
    expect(rendered).toContain("调用模型：gpt-5.6-luna");
    expect(rendered).toContain("状态：已完成 · HTTP 200");
    expect(rendered).toContain("**费用**：$0.000988");
  });

  it("shows reasoning token details for OpenAI official metrics", () => {
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        threadId: "thread-openai",
        modelProvider: "openai",
        latestTurn: {
          turnId: "turn-1",
          requestCount: 3,
          unsuccessfulRequestCount: 1,
          requestDurationMs: 65_000,
          inputTokens: 30_000,
          cachedInputTokens: 24_000,
          outputTokens: 900,
          reasoningOutputTokens: 300,
          outputTokensPerSecond: 60.25,
          outputSpeedSampleCount: 3,
          outputSpeedTimedCount: 2,
          pricingCurrency: "USD",
          pricedRequestCount: 2,
          totalCostNanos: 1_234_567,
          inputCostNanos: 400_000,
          cachedInputCostNanos: 200_000,
          outputCostNanos: 634_567,
          uncachedInputPricePerMillionNanos: 140_000_000,
          cachedInputPricePerMillionNanos: 2_800_000,
          outputPricePerMillionNanos: 280_000_000,
          hasMixedPrices: false,
          compact: null,
        },
        threadAggregate: {
          turnCount: 8,
          requestCount: 21,
          unsuccessfulRequestCount: 2,
          requestDurationMs: 142_000,
          inputTokens: 180_000,
          cachedInputTokens: 174_000,
          outputTokens: 4_200,
          reasoningOutputTokens: 1_800,
          outputTokensPerSecond: 58,
          outputSpeedSampleCount: 21,
          outputSpeedTimedCount: 20,
          pricingCurrency: "USD",
          pricedRequestCount: 20,
          totalCostNanos: 12_345_678,
          inputCostNanos: 4_000_000,
          cachedInputCostNanos: 2_000_000,
          outputCostNanos: 6_345_678,
          uncachedInputPricePerMillionNanos: 140_000_000,
          cachedInputPricePerMillionNanos: 2_800_000,
          outputPricePerMillionNanos: 280_000_000,
          hasMixedPrices: false,
          compact: null,
        },
        latestDirectApi: null,
      },
    });

    expect(rendered).toContain("其中推理输出：300");
    expect(rendered).toContain("其中推理输出：1.8 K");
  });

  it("switches currency amounts to the 亿 unit at large values", () => {
    expect(formatCurrencyNanos("CNY", 123_000_000 * 1_000_000_000)).toBe(
      "¥1.23 亿",
    );
    expect(formatCurrencyNanos("CNY", 1_234_567_890)).toBe("¥1.234568");
  });

  it("shows a single provider-resolved currency with the exchange rate", () => {
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        threadId: "thread-1",
        modelProvider: "deepseek",
        latestTurn: {
          turnId: "turn-1",
          requestCount: 1,
          unsuccessfulRequestCount: 0,
          requestDurationMs: 1_000,
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 0,
          outputTokensPerSecond: null,
          outputSpeedSampleCount: 0,
          outputSpeedTimedCount: 0,
          pricingCurrency: "USD",
          pricedRequestCount: 1,
          totalCostNanos: 1_000_000_000,
          inputCostNanos: 600_000_000,
          cachedInputCostNanos: 100_000_000,
          outputCostNanos: 300_000_000,
          uncachedInputPricePerMillionNanos: 140_000_000,
          cachedInputPricePerMillionNanos: 2_800_000,
          outputPricePerMillionNanos: 280_000_000,
          hasMixedPrices: false,
        },
        threadAggregate: null,
        latestDirectApi: null,
      },
    }, (provider) => provider === "deepseek" ? "cny" : "usd", {
      usdToCny: 7.2,
      effectiveAtMs: 1_700_000_000_000,
      source: "open-er-api",
    });

    expect(rendered).toContain("- 汇率：1 USD ≈ 7.2000 CNY");
    expect(rendered).toContain("  - 来源：open-er-api");
    expect(rendered).toContain("- **费用**：¥7.200000");
    expect(rendered).toContain("输入价格：¥4.320000");
    expect(rendered).toContain("缓存价格：¥0.720000");
    expect(rendered).toContain("输出价格：¥2.160000");
    expect(rendered).not.toContain("$1.00");
    expect(rendered).not.toContain("折合人民币");
  });

  it("shows the DeepSeek average price per 100M tokens from actual usage", () => {
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        threadId: "thread-1",
        modelProvider: "deepseek",
        latestTurn: {
          turnId: "turn-1",
          requestCount: 3,
          unsuccessfulRequestCount: 1,
          requestDurationMs: 1_000,
          inputTokens: 150,
          cachedInputTokens: 100,
          outputTokens: 50,
          reasoningOutputTokens: 0,
          outputTokensPerSecond: null,
          outputSpeedSampleCount: 0,
          outputSpeedTimedCount: 0,
          pricingCurrency: "USD",
          pricedRequestCount: 2,
          totalCostNanos: 1_000_000_000,
          inputCostNanos: 600_000_000,
          cachedInputCostNanos: 100_000_000,
          outputCostNanos: 300_000_000,
          uncachedInputPricePerMillionNanos: 140_000_000,
          cachedInputPricePerMillionNanos: 2_800_000,
          outputPricePerMillionNanos: 280_000_000,
          hasMixedPrices: false,
        },
        threadAggregate: null,
        latestDirectApi: null,
      },
    }, (provider) => provider === "deepseek" ? "cny" : "usd", {
      usdToCny: 7.2,
      effectiveAtMs: 1_700_000_000_000,
      source: "open-er-api",
    });

    expect(rendered).toContain(
      "均价：约 ¥3,600,000.00/100M（计价 2/3）",
    );
  });

  it("shows the average price for OpenAI providers", () => {
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        threadId: "thread-1",
        modelProvider: "openai",
        latestTurn: {
          turnId: "turn-1",
          requestCount: 1,
          unsuccessfulRequestCount: 0,
          requestDurationMs: 1_000,
          inputTokens: 150,
          cachedInputTokens: 100,
          outputTokens: 50,
          reasoningOutputTokens: 0,
          outputTokensPerSecond: null,
          outputSpeedSampleCount: 0,
          outputSpeedTimedCount: 0,
          pricingCurrency: "USD",
          pricedRequestCount: 1,
          totalCostNanos: 1_000_000_000,
          inputCostNanos: 600_000_000,
          cachedInputCostNanos: 100_000_000,
          outputCostNanos: 300_000_000,
          uncachedInputPricePerMillionNanos: 140_000_000,
          cachedInputPricePerMillionNanos: 2_800_000,
          outputPricePerMillionNanos: 280_000_000,
          hasMixedPrices: false,
        },
        threadAggregate: null,
        latestDirectApi: null,
      },
    }, (provider) => provider === "deepseek" ? "cny" : "usd", {
      usdToCny: 7.2,
      effectiveAtMs: 1_700_000_000_000,
      source: "open-er-api",
    });

    expect(rendered).toContain("均价：约 $500,000.00/100M");
  });

  it("renders unified provider and model aggregates with latency coverage", () => {
    const aggregate = {
      requestCount: 12,
      unsuccessfulRequestCount: 1,
      requestDurationMs: 60_000,
      inputTokens: 120_000,
      cachedInputTokens: 96_000,
      outputTokens: 2_400,
      reasoningOutputTokens: 600,
      outputTokensPerSecond: 75,
      outputSpeedSampleCount: 12,
      outputSpeedTimedCount: 10,
      ttftAverageMs: 1_200,
      ttftP50Ms: 800,
      ttftP95Ms: 2_500,
      ttftSampleCount: 9,
      pricingCurrency: "USD",
      pricedRequestCount: 10,
      totalCostNanos: 123_456_789,
      inputCostNanos: 40_000_000,
      cachedInputCostNanos: 20_000_000,
      outputCostNanos: 63_456_789,
      uncachedInputPricePerMillionNanos: 140_000_000,
      cachedInputPricePerMillionNanos: 2_800_000,
      outputPricePerMillionNanos: 280_000_000,
      hasMixedPrices: false,
      compact: {
        model: "gpt-5.6-sol",
        hasMixedModels: false,
        requestCount: 2,
        unsuccessfulRequestCount: 0,
        inputTokens: 20_000,
        cachedInputTokens: 18_000,
        outputTokens: 1_000,
        pricingCurrency: "USD",
        pricedRequestCount: 2,
        totalCostNanos: 284_204_000,
      },
    };
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        view: "models",
        range: "7d",
        startAtMs: 1,
        endAtMs: 2,
        aggregate,
        groups: [{
          provider: "openai",
          model: "gpt-5.6-sol",
          aggregate,
        }, {
          provider: "custom",
          providerName: "第三方中转",
          model: "gpt-5.6-luna",
          aggregate: { ...aggregate, requestCount: 3 },
        }],
        totalGroupCount: 2,
      },
    });

    expect(rendered).toContain("请求指标 · 按模型");
    expect(rendered).toContain("范围：最近 7 天");
    expect(rendered).toContain("首段回复延迟：平均 1秒");
    expect(rendered).toContain("P50 800毫秒 · P95 3秒（覆盖 9/12 次请求）");
    expect(rendered).toContain("OpenAI 官方 / gpt-5.6-sol");
    expect(rendered).toContain("第三方中转 / gpt-5.6-luna");
    expect(rendered).toContain("**费用**：$0.123457（计价 10/12）");
    expect(rendered).toContain("输入价格：$0.040000");
    expect(rendered).toContain("缓存价格：$0.020000");
    expect(rendered).toContain("输出价格：$0.063457");
    expect(rendered).toContain("上下文压缩：2 次 · gpt-5.6-sol · 21 K Token · $0.284204");
  });

  it("does not invent one unit price when an aggregate spans multiple rates", () => {
    const aggregate = {
      requestCount: 2,
      unsuccessfulRequestCount: 0,
      requestDurationMs: 1_000,
      inputTokens: 2_000,
      cachedInputTokens: 1_000,
      outputTokens: 100,
      reasoningOutputTokens: 0,
      outputTokensPerSecond: null,
      outputSpeedSampleCount: 0,
      outputSpeedTimedCount: 0,
      ttftAverageMs: null,
      ttftP50Ms: null,
      ttftP95Ms: null,
      ttftSampleCount: 0,
      pricingCurrency: "USD",
      pricedRequestCount: 2,
      totalCostNanos: 500_000,
      inputCostNanos: null,
      cachedInputCostNanos: null,
      outputCostNanos: null,
      uncachedInputPricePerMillionNanos: null,
      cachedInputPricePerMillionNanos: null,
      outputPricePerMillionNanos: null,
      hasMixedPrices: true,
    };
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        view: "global",
        range: "24h",
        startAtMs: 1,
        endAtMs: 2,
        aggregate,
        groups: [],
        totalGroupCount: 0,
      },
    });

    expect(rendered).toContain("**费用**：$0.000500");
    expect(rendered).not.toContain("输入价格：");
  });

  it("renders unsuccessful request groups and failure rate", () => {
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        view: "errors",
        range: "24h",
        startAtMs: 1,
        endAtMs: 2,
        requestCount: 100,
        unsuccessfulRequestCount: 3,
        groups: [{
          provider: "openai",
          model: "gpt-5.6-sol",
          status: "failed",
          httpStatus: null,
          errorType: "websocket_closed",
          lastErrorMessage: null,
          requestCount: 2,
          lastOccurredAtMs: 1_785_640_800_000,
        }, {
          provider: "custom",
          providerName: "第三方中转",
          model: "gpt-5.6-luna",
          status: "incomplete",
          httpStatus: 429,
          errorType: "rate_limit_error",
          lastErrorMessage: null,
          requestCount: 1,
          lastOccurredAtMs: 1_785_640_700_000,
        }],
        totalGroupCount: 2,
      },
    });

    expect(rendered).toContain("## 请求指标 · 异常请求");
    expect(rendered).toContain("异常率：3%");
    expect(rendered).toContain("OpenAI 官方 / gpt-5.6-sol");
    expect(rendered).toContain("WebSocket 提前关闭 · 失败 · 2 次");
    expect(rendered).toContain("第三方中转 / gpt-5.6-luna");
    expect(rendered).toContain("rate_limit_error · 未完成 · HTTP 429 · 1 次");
    expect(rendered).toContain("最近发生：");
  });

  it("does not render untrusted error types as channel markdown", () => {
    const rendered = formatConversationMetrics({
      kind: "metrics",
      summary: {
        view: "errors",
        range: "24h",
        startAtMs: 1,
        endAtMs: 2,
        requestCount: 1,
        unsuccessfulRequestCount: 1,
        groups: [{
          provider: "openai",
          model: "gpt-5.6-sol",
          status: "failed",
          httpStatus: 500,
          errorType: "upstream_error\n**伪造字段**",
          lastErrorMessage: null,
          requestCount: 1,
          lastOccurredAtMs: 1_785_640_800_000,
        }],
        totalGroupCount: 1,
      },
    });

    expect(rendered).toContain("其他错误 · 失败 · HTTP 500");
    expect(rendered).not.toContain("伪造字段");
    expect(rendered).not.toContain("**");
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

function breakdown(totalTokens: number) {
  return {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
  };
}
