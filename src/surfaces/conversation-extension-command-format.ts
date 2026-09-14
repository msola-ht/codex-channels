import {
  supportsMcpOAuthLogin,
  type ConversationCommandResult,
  type McpResourceContent,
} from "../application/index.js";

import { toStructuredMarkdownList } from "./markdown-list.js";

const maximumMcpDetailEntries = 8;
const maximumMcpHealthFindings = 8;
const maximumMcpDetailSectionCharacters = 5_000;
const maximumMcpDescriptionCharacters = 240;
const maximumMcpOutputCharacters = 20_000;
const mcpToolAccessNotice =
  "工具读写属性来自 MCP 上游声明，仅供提示；实际调用仍按审批策略处理。";

export function formatConversationSkills(
  result: Extract<ConversationCommandResult, { kind: "skills" }>,
): string {
  return result.entries.length === 0
    ? "当前没有已启用的 Skills。"
    : toStructuredMarkdownList([
        `已安装 Skills（${result.entries.length}）：`,
        ...result.entries.map(
          (skill, index) => `${index + 1}. ${skill.name}：${skill.description}`,
        ),
        "",
        "使用：/skill <名称或序号> <任务>",
      ].join("\n"));
}

export function formatConversationAgents(
  result: Extract<ConversationCommandResult, { kind: "agents" }>,
): string {
  return result.roles.length === 0
    ? "当前没有可用的子代理角色。"
    : toStructuredMarkdownList([
        `子代理角色（${result.roles.length}）：`,
        ...result.roles.map(
          (role, index) =>
            `${index + 1}. ${role.name}${role.description ? `：${role.description}` : ""}`,
        ),
        "",
        "使用：/agents <角色名称或序号> <任务>",
      ].join("\n"));
}

export function formatConversationMcp(
  result: Extract<ConversationCommandResult, { kind: "mcp" }>,
): string {
  if (result.servers.length === 0) {
    return toStructuredMarkdownList("MCP Servers（0）：");
  }
  return toStructuredMarkdownList([
    `MCP Servers（${result.servers.length}）：`,
    ...result.servers.flatMap(
      (server, index) => [
        `${index + 1}. ${server.name} · 运行：${formatMcpRuntimeStatus(server.runtimeStatus)} · 认证：${formatMcpAuthStatus(server.authStatus)} · 工具：${server.toolCount}`,
        `  - 详情：/mcp ${index + 1}`,
      ],
    ),
  ].join("\n"));
}

export function formatConversationMcpHealth(
  result: Extract<ConversationCommandResult, { kind: "mcp-health" }>,
): string {
  const report = result.report;
  const visibleActions = report.actions.slice(0, maximumMcpHealthFindings);
  const visibleNotices = report.notices.slice(
    0,
    maximumMcpHealthFindings - visibleActions.length,
  );
  const omittedFindings = report.actions.length
    + report.notices.length
    - visibleActions.length
    - visibleNotices.length;
  return toStructuredMarkdownList([
    "MCP 健康检查",
    report.serverCount === 0
      ? "状态：未配置 MCP Server"
      : report.actions.length > 0
      ? `状态：发现 ${report.actions.length} 项需要处理`
      : "状态：未发现需要处理的问题",
    `Server：${report.serverCount} 个 · 工具：${report.toolCount} 个 · 资源：${report.resourceCount} 个 · 资源模板：${report.resourceTemplateCount} 个`,
    ...(visibleActions.length > 0
      ? [
          "需要处理：",
          ...visibleActions.flatMap((action) => {
            if (action.type === "loginRequired") {
              return [
                `- ${action.server}：尚未登录`,
                `  - 处理：/mcp login ${action.selector}`,
              ];
            }
            return [
              action.type === "toolDiscoveryFailed"
                ? `- ${action.server}：工具目录读取失败`
                : `- ${action.server}：连接失败或已取消`,
              "  - 处理：/mcp reload",
            ];
          }),
        ]
      : []),
    ...(visibleNotices.length > 0 || omittedFindings > 0
      ? [
          "提示：",
          ...visibleNotices.map((notice) => {
            switch (notice.type) {
              case "authUnknown":
                return `- ${notice.server}：认证状态未知，可检查配置或尝试 /mcp login ${notice.selector}`;
              case "noCapabilities":
                return `- ${notice.server}：未公开工具、资源或资源模板`;
              case "notStarted":
                return `- ${notice.server}：尚未启动`;
              case "starting":
                return `- ${notice.server}：正在连接`;
              case "disabled":
                return `- ${notice.server}：已禁用`;
            }
          }),
          ...(omittedFindings > 0
            ? [`- 其余 ${omittedFindings} 项已省略；使用 /mcp 查看完整 Server 列表`]
            : []),
        ]
      : []),
  ].join("\n"));
}

export function formatConversationMcpReload(
  result: Extract<ConversationCommandResult, { kind: "mcp-reload" }>,
): string {
  void result;
  return toStructuredMarkdownList([
    "MCP 配置重新加载",
    "状态：已请求",
    "生效：已加载 Session 已刷新 MCP 配置",
    "提示：无需重启 Codex App Server；连接结果请再次使用 /mcp health 查询",
  ].join("\n"));
}

export function formatConversationMcpDetail(
  result: Extract<ConversationCommandResult, { kind: "mcp-detail" }>,
): string {
  const server = result.server;
  const selector = result.selector;
  const detailSections = result.view
    ? formatSelectedMcpDetailSection(server, result.view, selector)
    : [
        ...formatMcpDetailEntries("工具", server.tools, (tool) =>
          formatMcpToolLine(tool)
        ),
        mcpToolAccessNotice,
        ...formatMcpDetailEntries("资源", server.resources, (resource) =>
          `- ${resource.title ?? resource.name} · ${resource.uri}${resource.mimeType ? ` · ${formatMcpDescription(resource.mimeType)}` : ""}`
        ),
        ...formatMcpDetailEntries("资源模板", server.resourceTemplates, (template) =>
          `- ${template.title ?? template.name} · ${template.uriTemplate}`
        ),
      ];
  return toStructuredMarkdownList([
    `MCP Server：${server.serverTitle ?? server.name}`,
    `名称：${server.name}`,
    `运行：${formatMcpRuntimeStatus(server.runtimeStatus)}`,
    ...(server.pluginId ? [`来源 Plugin：${server.pluginId}`] : []),
    `版本：${server.serverVersion ?? "未提供"}`,
    `认证：${formatMcpAuthStatus(server.authStatus)}`,
    ...(server.serverDescription
      ? [`说明：${formatMcpDescription(server.serverDescription)}`]
      : []),
    ...detailSections,
    "",
    ...(supportsMcpOAuthLogin(server.authStatus)
      ? [`OAuth：/mcp login ${selector}`]
      : []),
    `浏览工具：/mcp ${selector} tools`,
    `浏览资源：/mcp ${selector} resources`,
    `浏览资源模板：/mcp ${selector} templates`,
    `读取资源：/mcp resource ${selector} <URI>`,
  ].join("\n"));
}

function formatMcpRuntimeStatus(
  status: Extract<ConversationCommandResult, { kind: "mcp" }>["servers"][number]["runtimeStatus"],
): string {
  return ({
    unknown: "未知",
    notStarted: "未启动",
    starting: "正在连接",
    connected: "已连接",
    authenticationRequired: "需要认证",
    failed: "失败",
    cancelled: "已取消",
    disabled: "已禁用",
  } as const)[status];
}

function formatMcpAuthStatus(
  status: Extract<ConversationCommandResult, { kind: "mcp" }>["servers"][number]["authStatus"],
): string {
  return ({
    unknown: "未知",
    unsupported: "不支持 OAuth",
    notLoggedIn: "未登录",
    bearerToken: "Bearer Token",
    oAuth: "OAuth",
  } as const)[status];
}

function formatSelectedMcpDetailSection(
  server: Extract<ConversationCommandResult, { kind: "mcp-detail" }>["server"],
  view: NonNullable<Extract<ConversationCommandResult, { kind: "mcp-detail" }>["view"]>,
  selector: string,
): string[] {
  if (view.section === "tools") {
    return [
      ...formatMcpDetailPage(
        "工具",
        server.tools,
        view,
        selector,
        (tool) => [tool.name, tool.title, tool.description],
        formatMcpToolLine,
      ),
      mcpToolAccessNotice,
    ];
  }
  if (view.section === "resources") {
    return formatMcpDetailPage(
      "资源",
      server.resources,
      view,
      selector,
      (resource) => [
        resource.name,
        resource.title,
        resource.description,
        resource.uri,
        resource.mimeType,
      ],
      (resource) =>
        `- ${resource.title ?? resource.name} · ${resource.uri}${resource.mimeType ? ` · ${formatMcpDescription(resource.mimeType)}` : ""}`,
    );
  }
  return formatMcpDetailPage(
    "资源模板",
    server.resourceTemplates,
    view,
    selector,
    (template) => [
      template.name,
      template.title,
      template.description,
      template.uriTemplate,
      template.mimeType,
    ],
    (template) => `- ${template.title ?? template.name} · ${template.uriTemplate}`,
  );
}

function formatMcpToolLine(
  tool: Extract<ConversationCommandResult, { kind: "mcp-detail" }>["server"]["tools"][number],
): string {
  const access = ({
    readOnly: "上游标记只读",
    writeCapable: "可能写入",
    unknown: "读写属性未知",
  } as const)[tool.access];
  return `- ${tool.title ?? tool.name} · ${tool.name} · ${access}${tool.description ? ` · ${formatMcpDescription(tool.description)}` : ""}`;
}

function formatMcpDetailPage<T>(
  label: string,
  entries: readonly T[],
  view: NonNullable<Extract<ConversationCommandResult, { kind: "mcp-detail" }>["view"]>,
  selector: string,
  searchableValues: (entry: T) => ReadonlyArray<string | null>,
  format: (entry: T) => string,
): string[] {
  const normalizedSearch = view.searchTerm?.toLowerCase() ?? null;
  const matches = normalizedSearch
    ? entries.filter((entry) =>
        searchableValues(entry).some((value) =>
          value?.toLowerCase().includes(normalizedSearch)
        )
      )
    : [...entries];
  const pageCount = Math.max(1, Math.ceil(matches.length / maximumMcpDetailEntries));
  const commandSuffix = view.searchTerm ? ` search ${view.searchTerm}` : "";
  if (view.page > pageCount) {
    return [
      `${label}（${view.searchTerm ? `匹配 ${matches.length} · ` : ""}共 ${pageCount} 页）：`,
      `- 第 ${view.page} 页不存在，共 ${pageCount} 页`,
      `返回第一页：/mcp ${selector} ${view.section} 1${commandSuffix}`,
    ];
  }
  const pageStart = (view.page - 1) * maximumMcpDetailEntries;
  const pageEntries = matches.slice(pageStart, pageStart + maximumMcpDetailEntries);
  const visible: string[] = [];
  let sectionCharacters = 0;
  for (const entry of pageEntries) {
    const line = format(entry);
    if (sectionCharacters + line.length > maximumMcpDetailSectionCharacters) break;
    visible.push(line);
    sectionCharacters += line.length;
  }
  return [
    `${label}（${view.searchTerm ? `匹配 ${matches.length} · ` : ""}第 ${view.page}/${pageCount} 页）：`,
    ...(visible.length > 0 ? visible : ["- 当前页没有匹配项"]),
    ...(pageEntries.length > visible.length
      ? [`- 当前页其余 ${pageEntries.length - visible.length} 项因展示上限省略`]
      : []),
    ...(view.page > 1
      ? [`上一页：/mcp ${selector} ${view.section} ${view.page - 1}${commandSuffix}`]
      : []),
    ...(view.page < pageCount
      ? [`下一页：/mcp ${selector} ${view.section} ${view.page + 1}${commandSuffix}`]
      : []),
  ];
}

function formatMcpDetailEntries<T>(
  label: string,
  entries: readonly T[],
  format: (entry: T) => string,
): string[] {
  const visible: string[] = [];
  let sectionCharacters = 0;
  for (const entry of entries.slice(0, maximumMcpDetailEntries)) {
    const line = format(entry);
    if (sectionCharacters + line.length > maximumMcpDetailSectionCharacters) break;
    visible.push(line);
    sectionCharacters += line.length;
  }
  return [
    `${label}（${entries.length}）：`,
    ...visible,
    ...(entries.length > visible.length
      ? [`- 其余 ${entries.length - visible.length} 项已省略`]
      : []),
  ];
}

function formatMcpDescription(value: string): string {
  const characters = [...value];
  return characters.length <= maximumMcpDescriptionCharacters
    ? value
    : `${characters.slice(0, maximumMcpDescriptionCharacters - 1).join("")}…`;
}

export function formatConversationMcpLogin(
  result: Extract<ConversationCommandResult, { kind: "mcp-login" }>,
): string {
  if (result.login.type === "bearerToken") {
    return toStructuredMarkdownList([
      "MCP 认证",
      `Server：${result.login.server}`,
      "状态：已使用 Bearer Token 认证，无需 OAuth 登录",
    ].join("\n"));
  }
  return toStructuredMarkdownList([
    "MCP OAuth 登录已启动",
    `Server：${result.login.server}`,
    `请在浏览器完成授权：${result.login.authorizationUrl}`,
    "授权完成后再次发送 /mcp 查看登录状态。",
  ].join("\n"));
}

export function formatConversationMcpResource(
  result: Extract<ConversationCommandResult, { kind: "mcp-resource" }>,
): string {
  const resource = result.resource;
  const heading = [
    "MCP Resource（外部不可信内容）",
    `Server：${resource.server}`,
    `请求 URI：${resource.requestedUri}`,
  ];
  const blocks: string[] = [];
  let visibleContentCount = 0;
  for (const content of resource.contents) {
    const block = formatMcpResourceContent(content, visibleContentCount);
    const nextVisibleCount = visibleContentCount + 1;
    const omittedContentCount = resource.omittedContentCount
      + resource.contents.length
      - nextVisibleCount;
    const candidate = toStructuredMarkdownList([
      ...heading,
      ...blocks,
      ...block,
      ...(omittedContentCount > 0
        ? [`其余 ${omittedContentCount} 个内容已省略。`]
        : []),
    ].join("\n"));
    if (candidate.length > maximumMcpOutputCharacters) break;
    blocks.push(...block);
    visibleContentCount = nextVisibleCount;
  }
  const omittedContentCount = resource.omittedContentCount
    + resource.contents.length
    - visibleContentCount;
  return toStructuredMarkdownList([
    ...heading,
    ...blocks,
    ...(omittedContentCount > 0
      ? [`其余 ${omittedContentCount} 个内容已省略。`]
      : []),
  ].join("\n"));
}

function formatMcpResourceContent(
  content: McpResourceContent,
  index: number,
): string[] {
  if (content.kind === "blob") {
    return [
      `内容 ${index + 1}：${content.uri}`,
      `二进制内容未在渠道中展开 · MIME=${formatMcpDescription(content.mimeType ?? "未知")} · Base64 字符=${content.encodedCharacters}`,
    ];
  }
  return [
    `内容 ${index + 1}：${content.uri}${content.mimeType ? ` · ${formatMcpDescription(content.mimeType)}` : ""}`,
    "```text",
    escapeCodeFence(content.text),
    "```",
    ...(content.truncated ? ["文本展示达到整次读取 8000 字符上限，当前内容已截断。"] : []),
  ];
}

function escapeCodeFence(value: string): string {
  return value.replace(/```/gu, "``\u200b`");
}

export function formatConversationPlugins(
  result: Extract<ConversationCommandResult, { kind: "plugins" }>,
): string {
  const {
    plugins,
    selectors,
    loadErrorCount,
    totalPluginCount,
    matchedPluginCount,
    page,
    pageCount,
    searchTerm,
  } = result;
  const loadErrorNotice = loadErrorCount > 0
    ? [`注意：${loadErrorCount} 个 Plugin Marketplace 加载失败，列表可能不完整。`, ""]
    : [];
  if (totalPluginCount === 0 && loadErrorCount === 0) {
    return "当前没有已安装的 Plugin。";
  }
  const commandSuffix = searchTerm ? ` search ${searchTerm}` : "";
  const hasReservedPluginName = plugins.some((plugin) =>
    plugin.name === "health" || plugin.name === "list"
  );
  const callableCommands = plugins.flatMap((plugin, index) => {
    const selector = selectors[index];
    return plugin.enabled && plugin.available && selector
      ? [`${plugin.displayName}：/plugin ${selector} <任务>`]
      : [];
  });
  if (page > pageCount) {
    return toStructuredMarkdownList([
      `已安装 Plugin（开发中${searchTerm ? `，匹配 ${matchedPluginCount}` : ""}）：`,
      ...loadErrorNotice,
      `第 ${page} 页不存在，共 ${pageCount} 页`,
      `返回第一页：/plugin list 1${commandSuffix}`,
    ].join("\n"));
  }
  if (plugins.length === 0 && searchTerm) {
    return toStructuredMarkdownList([
      "已安装 Plugin（开发中，匹配 0 · 第 1/1 页）：",
      ...loadErrorNotice,
      `没有匹配“${searchTerm}”的 Plugin。`,
      "重新搜索：/plugin list search <关键词>",
    ].join("\n"));
  }
  return toStructuredMarkdownList([
    `已安装 Plugin（开发中，${searchTerm ? `匹配 ${matchedPluginCount}` : `共 ${totalPluginCount}`} · 第 ${page}/${pageCount} 页）：`,
    ...loadErrorNotice,
    ...plugins.map((plugin, index) => {
      const status = !plugin.available
        ? "不可用"
        : plugin.enabled
          ? "已启用"
          : "未启用";
      return `${selectors[index]}. ${plugin.displayName} · ${plugin.id} · ${status}${plugin.description ? ` · ${plugin.description}` : ""}`;
    }),
    "",
    ...(page > 1 ? [`上一页：/plugin list ${page - 1}${commandSuffix}`] : []),
    ...(page < pageCount ? [`下一页：/plugin list ${page + 1}${commandSuffix}`] : []),
    ...(callableCommands.length > 0
      ? ["当前页快捷调用：", ...callableCommands]
      : []),
    "健康检查：/plugin health",
    "搜索：/plugin list search <关键词>",
    ...(hasReservedPluginName
      ? ["提示：名称为 health 或 list 时，查看详情请使用完整 ID 或序号。"]
      : []),
    "详情：/plugin <名称、完整 ID 或序号>",
    "调用：/plugin <名称、完整 ID 或序号> <任务>",
  ].join("\n"));
}

export function formatConversationPluginHealth(
  result: Extract<ConversationCommandResult, { kind: "plugin-health" }>,
): string {
  const { report } = result;
  const visibleIssues = report.issues.slice(0, 8);
  const lines = [
    "Plugin 健康（开发中）",
    `已安装：${report.installedCount}`,
    `已启用：${report.enabledCount}`,
    `可调用：${report.callableCount}`,
    ...(report.marketplaceLoadErrorCount > 0
      ? [`提示：${report.marketplaceLoadErrorCount} 个 Marketplace 加载失败，结果可能不完整。`]
      : []),
    ...(visibleIssues.length > 0 ? ["", "需要处理："] : []),
    ...visibleIssues.map((issue) =>
      `${issue.plugin} · ${pluginHealthIssueLabel(issue.type, issue.reason)} · 详情：/plugin ${issue.selector}`
    ),
    ...(report.issues.length > visibleIssues.length
      ? [`其余 ${report.issues.length - visibleIssues.length} 项已省略，请使用 /plugin 分页查看。`]
      : []),
    ...(report.issues.length === 0 && report.marketplaceLoadErrorCount === 0
      ? ["", "没有需要处理的问题。"]
      : []),
  ];
  return toStructuredMarkdownList(lines.join("\n"));
}

function pluginHealthIssueLabel(
  type: Extract<ConversationCommandResult, { kind: "plugin-health" }>["report"]["issues"][number]["type"],
  reason: Extract<ConversationCommandResult, { kind: "plugin-health" }>["report"]["issues"][number]["reason"],
): string {
  if (type === "notEnabled") return "未启用";
  return reason ? pluginDisabledReasonLabel(reason) : "上游标记不可用";
}

export function formatConversationPluginDetail(
  result: Extract<ConversationCommandResult, { kind: "plugin-detail" }>,
): string {
  const plugin = result.plugin;
  return toStructuredMarkdownList([
    `Plugin：${plugin.displayName}`,
    `ID：${plugin.id}`,
    `Marketplace：${plugin.marketplaceName}`,
    `状态：${pluginStatusLabel(plugin)}`,
    ...(plugin.developerName ? [`开发者：${plugin.developerName}`] : []),
    ...(plugin.category ? [`分类：${plugin.category}`] : []),
    `来源：${pluginSourceLabel(plugin.source)}`,
    `远端版本：${plugin.version ?? "未提供"}`,
    `本地版本：${plugin.localVersion ?? "未提供"}`,
    `安装时间：${formatPluginInstalledAt(plugin.installedAt)}`,
    `认证时机：${pluginAuthPolicyLabel(plugin.authPolicy)}`,
    ...(plugin.capabilities.length > 0
      ? [`能力：${formatPluginValues(plugin.capabilities)}`]
      : []),
    ...(plugin.disabledReason
      ? [`不可用原因：${pluginDisabledReasonLabel(plugin.disabledReason)}`]
      : []),
    ...(plugin.eligiblePlanTypes.length > 0
      ? [`适用套餐（上游标识）：${formatPluginValues(plugin.eligiblePlanTypes)}`]
      : []),
    ...(plugin.description ? [`说明：${plugin.description}`] : []),
    "",
    plugin.enabled && plugin.available
      ? `调用：/plugin ${plugin.id} <任务>`
      : "当前 Plugin 不可调用。",
    "提示：Plugin API 仍处于开发中。",
  ].join("\n"));
}

function pluginStatusLabel(
  plugin: Extract<ConversationCommandResult, { kind: "plugin-detail" }>["plugin"],
): string {
  if (!plugin.available) return "不可用";
  return plugin.enabled ? "已启用" : "未启用";
}

function pluginSourceLabel(
  source: Extract<ConversationCommandResult, { kind: "plugin-detail" }>["plugin"]["source"],
): string {
  return ({
    local: "本地",
    git: "Git",
    npm: "npm",
    remote: "远端",
  } as const)[source];
}

function formatPluginInstalledAt(value: number | null): string {
  if (value === null) return "未提供";
  const date = new Date(value * 1_000);
  return Number.isNaN(date.getTime())
    ? "未提供"
    : date.toISOString().replace(".000Z", "Z");
}

function pluginDisabledReasonLabel(
  reason: NonNullable<
    Extract<ConversationCommandResult, { kind: "plugin-detail" }>["plugin"]["disabledReason"]
  >,
): string {
  return ({
    disabled_by_admin: "被管理员禁用",
    plan_not_eligible: "当前套餐不可用",
    required_app_unavailable: "所需 App 不可用",
    unknown: "上游未提供明确原因",
  } as const)[reason];
}

function pluginAuthPolicyLabel(
  policy: Extract<ConversationCommandResult, { kind: "plugin-detail" }>["plugin"]["authPolicy"],
): string {
  return policy === "onInstall" ? "安装时" : "使用时";
}

function formatPluginValues(values: readonly string[]): string {
  const visible = values.slice(0, 8);
  const omittedCount = values.length - visible.length;
  return `${visible.join("、")}${omittedCount > 0 ? `（另有 ${omittedCount} 项）` : ""}`;
}
