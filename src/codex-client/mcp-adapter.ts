import type {
  McpOAuthLogin,
  McpResourceReadResult,
  McpServerDetail,
  McpServerSummary,
} from "../application/index.js";
import type {
  ListMcpServerStatusResponse,
  McpResourceReadResponse,
  McpServerOauthLoginResponse,
} from "../codex-protocol/index.js";

export interface McpServerSummaryPage {
  servers: McpServerSummary[];
  nextCursor: string | null;
}

export interface McpServerDetailPage {
  servers: McpServerDetail[];
  nextCursor: string | null;
}

const maximumResourceContentEntries = 8;
const maximumResourceTextCharacters = 8_000;

const mcpAuthStatuses = new Set<McpServerSummary["authStatus"]>([
  "unknown",
  "unsupported",
  "notLoggedIn",
  "bearerToken",
  "oAuth",
]);

export function toMcpServerSummaryPage(
  response: ListMcpServerStatusResponse,
): McpServerSummaryPage {
  validatePage(response);
  return {
    servers: response.data.map(toServerSummary),
    nextCursor: response.nextCursor,
  };
}

export function toMcpServerDetailPage(
  response: ListMcpServerStatusResponse,
): McpServerDetailPage {
  validatePage(response);
  return {
    servers: response.data.map((server) => {
      const summary = toServerSummary(server);
      const serverInfo = server.serverInfo;
      if (serverInfo !== null && (typeof serverInfo !== "object" || Array.isArray(serverInfo))) {
        throw new Error("Codex 响应缺少有效 MCP serverInfo");
      }
      if (!Array.isArray(server.resources) || !Array.isArray(server.resourceTemplates)) {
        throw new Error("Codex 响应缺少有效 MCP resources");
      }
      return {
        ...summary,
        serverTitle: serverInfo ? optionalText(serverInfo.title, "MCP server title") : null,
        serverVersion: serverInfo
          ? requiredText(serverInfo.version, "MCP server version")
          : null,
        serverDescription: serverInfo
          ? optionalText(serverInfo.description, "MCP server description")
          : null,
        tools: Object.entries(server.tools).flatMap(([key, tool]) => {
          if (!tool) return [];
          const name = requiredText(tool.name, "MCP tool name");
          if (name !== key) {
            throw new Error("Codex 响应包含不一致的 MCP tool name");
          }
          return [{
            name,
            title: optionalText(tool.title, "MCP tool title"),
            description: optionalText(tool.description, "MCP tool description"),
          }];
        }),
        resources: server.resources.map((resource) => ({
          uri: requiredText(resource.uri, "MCP resource uri", 4_096),
          name: requiredText(resource.name, "MCP resource name"),
          title: optionalText(resource.title, "MCP resource title"),
          description: optionalText(resource.description, "MCP resource description"),
          mimeType: optionalText(resource.mimeType, "MCP resource mime type"),
        })),
        resourceTemplates: server.resourceTemplates.map((template) => ({
          uriTemplate: requiredText(
            template.uriTemplate,
            "MCP resource template uri",
            4_096,
          ),
          name: requiredText(template.name, "MCP resource template name"),
          title: optionalText(template.title, "MCP resource template title"),
          description: optionalText(
            template.description,
            "MCP resource template description",
          ),
          mimeType: optionalText(template.mimeType, "MCP resource template mime type"),
        })),
      };
    }),
    nextCursor: response.nextCursor,
  };
}

export function toMcpOAuthLogin(
  server: string,
  response: McpServerOauthLoginResponse,
): McpOAuthLogin {
  const authorizationUrl = requiredText(
    response.authorizationUrl,
    "MCP OAuth authorization URL",
    4_096,
  );
  let parsed: URL;
  try {
    parsed = new URL(authorizationUrl);
  } catch {
    throw new Error("Codex 响应缺少有效 MCP OAuth authorization URL");
  }
  const loopbackHttp = parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost");
  if ((parsed.protocol !== "https:" && !loopbackHttp) || parsed.username || parsed.password) {
    throw new Error("Codex 响应缺少安全的 MCP OAuth authorization URL");
  }
  return { server, authorizationUrl };
}

export function toMcpResourceReadResult(
  server: string,
  requestedUri: string,
  response: McpResourceReadResponse,
): McpResourceReadResult {
  if (!Array.isArray(response.contents)) {
    throw new Error("Codex 响应缺少有效 MCP resource contents");
  }
  const contents: McpResourceReadResult["contents"] = [];
  let remainingTextCharacters = maximumResourceTextCharacters;
  for (const content of response.contents.slice(0, maximumResourceContentEntries)) {
    const uri = requiredText(content.uri, "MCP resource content uri", 4_096);
    const mimeType = optionalText(content.mimeType, "MCP resource content mime type");
    if ("text" in content) {
      if (
        typeof content.text !== "string"
        || content.text.length > 1_000_000
      ) {
        throw new Error("Codex 响应缺少有效 MCP resource text");
      }
      if (remainingTextCharacters === 0) continue;
      const text = content.text.slice(0, remainingTextCharacters);
      remainingTextCharacters -= text.length;
      contents.push({
        kind: "text",
        uri,
        mimeType,
        text,
        truncated: text.length < content.text.length,
      });
      continue;
    }
    const blob = content.blob;
    if (
      typeof blob !== "string"
      || blob.length > 4_000_000
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(blob)
    ) {
      throw new Error("Codex 响应缺少有效 MCP resource blob");
    }
    contents.push({
      kind: "blob",
      uri,
      mimeType,
      encodedCharacters: blob.length,
    });
  }
  return {
    server,
    requestedUri,
    contents,
    omittedContentCount: response.contents.length - contents.length,
  };
}

function validatePage(response: ListMcpServerStatusResponse): void {
  if (!Array.isArray(response.data)) {
    throw new Error("Codex 响应缺少有效 MCP server data");
  }
  if (response.nextCursor !== null && typeof response.nextCursor !== "string") {
    throw new Error("Codex 响应缺少有效 MCP server nextCursor");
  }
}

function toServerSummary(
  server: ListMcpServerStatusResponse["data"][number],
): McpServerSummary {
  const name = requiredText(server.name, "MCP server name");
  if (typeof server.authStatus !== "string" || !mcpAuthStatuses.has(server.authStatus)) {
    throw new Error("Codex 响应缺少有效 MCP server authStatus");
  }
  if (typeof server.tools !== "object" || server.tools === null || Array.isArray(server.tools)) {
    throw new Error("Codex 响应缺少有效 MCP server tools");
  }
  return { name, authStatus: server.authStatus, toolCount: Object.keys(server.tools).length };
}

function requiredText(value: unknown, field: string, maximum = 512): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || hasControlCharacters(value)
  ) {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  return requiredText(value, field, 2_000);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}
