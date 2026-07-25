export type McpAuthStatus = "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";

export interface McpServerSummary {
  name: string;
  authStatus: McpAuthStatus;
  toolCount: number;
}

export interface McpQueryPort {
  listMcpServers(threadId?: string): Promise<McpServerSummary[]>;
}
