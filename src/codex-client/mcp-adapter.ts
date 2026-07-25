import type { McpServerSummary } from "../application/index.js";
import type { ListMcpServerStatusResponse } from "../codex-protocol/index.js";

export interface McpServerSummaryPage {
  servers: McpServerSummary[];
  nextCursor: string | null;
}

const mcpAuthStatuses = new Set<McpServerSummary["authStatus"]>([
  "unsupported",
  "notLoggedIn",
  "bearerToken",
  "oAuth",
]);

export function toMcpServerSummaryPage(
  response: ListMcpServerStatusResponse,
): McpServerSummaryPage {
  if (!Array.isArray(response.data)) {
    throw new Error("Codex 响应缺少有效 MCP server data");
  }
  if (response.nextCursor !== null && typeof response.nextCursor !== "string") {
    throw new Error("Codex 响应缺少有效 MCP server nextCursor");
  }
  return {
    servers: response.data.map((server) => {
      if (typeof server.name !== "string" || server.name.length === 0) {
        throw new Error("Codex 响应缺少有效 MCP server name");
      }
      if (
        typeof server.authStatus !== "string"
        || !mcpAuthStatuses.has(server.authStatus)
      ) {
        throw new Error("Codex 响应缺少有效 MCP server authStatus");
      }
      if (
        typeof server.tools !== "object"
        || server.tools === null
        || Array.isArray(server.tools)
      ) {
        throw new Error("Codex 响应缺少有效 MCP server tools");
      }
      return {
        name: server.name,
        authStatus: server.authStatus,
        toolCount: Object.keys(server.tools).length,
      };
    }),
    nextCursor: response.nextCursor,
  };
}
