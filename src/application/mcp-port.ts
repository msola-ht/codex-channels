export type McpAuthStatus =
  | "unknown"
  | "unsupported"
  | "notLoggedIn"
  | "bearerToken"
  | "oAuth";

export interface McpServerSummary {
  name: string;
  authStatus: McpAuthStatus;
  toolCount: number;
}

export interface McpToolSummary {
  name: string;
  title: string | null;
  description: string | null;
}

export interface McpResourceSummary {
  uri: string;
  name: string;
  title: string | null;
  description: string | null;
  mimeType: string | null;
}

export interface McpResourceTemplateSummary {
  uriTemplate: string;
  name: string;
  title: string | null;
  description: string | null;
  mimeType: string | null;
}

export interface McpServerDetail extends McpServerSummary {
  serverTitle: string | null;
  serverVersion: string | null;
  serverDescription: string | null;
  tools: McpToolSummary[];
  resources: McpResourceSummary[];
  resourceTemplates: McpResourceTemplateSummary[];
}

export interface McpOAuthLogin {
  server: string;
  authorizationUrl: string;
}

export type McpResourceContent =
  | {
      kind: "text";
      uri: string;
      mimeType: string | null;
      text: string;
      truncated: boolean;
    }
  | {
      kind: "blob";
      uri: string;
      mimeType: string | null;
      encodedCharacters: number;
    };

export interface McpResourceReadResult {
  server: string;
  requestedUri: string;
  contents: McpResourceContent[];
  omittedContentCount: number;
}

export interface McpQueryPort {
  listMcpServers(threadId?: string): Promise<McpServerSummary[]>;
  listMcpServerDetails(threadId?: string): Promise<McpServerDetail[]>;
  startMcpOAuthLogin(name: string, threadId?: string): Promise<McpOAuthLogin>;
  readMcpResource(
    server: string,
    uri: string,
    threadId?: string,
  ): Promise<McpResourceReadResult>;
}
