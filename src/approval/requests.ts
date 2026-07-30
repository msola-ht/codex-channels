export type ServerRequestId = string | number;

export type ExecPolicyAmendment = string[];

export interface NetworkApprovalContext {
  host: string;
  protocol: "http" | "https" | "socks5Tcp" | "socks5Udp";
}

export interface NetworkPolicyAmendment {
  host: string;
  action: "allow" | "deny";
}

export type FileSystemSpecialPath =
  | { kind: "root" | "minimal" | "tmpdir" | "slash_tmp" }
  | { kind: "project_roots"; subpath: string | null }
  | { kind: "unknown"; path: string; subpath: string | null };

export type FileSystemPath =
  | { type: "path"; path: string }
  | { type: "glob_pattern"; pattern: string }
  | { type: "special"; value: FileSystemSpecialPath };

export interface FileSystemSandboxEntry {
  path: FileSystemPath;
  access: "read" | "write" | "deny";
}

export interface AdditionalFileSystemPermissions {
  read: string[] | null;
  write: string[] | null;
  globScanMaxDepth?: number;
  entries?: FileSystemSandboxEntry[];
}

export interface AdditionalPermissionProfile {
  network: { enabled: boolean | null } | null;
  fileSystem: AdditionalFileSystemPermissions | null;
}

export interface McpToolApproval {
  connectorName: string | null;
  toolTitle: string | null;
  toolDescription: string | null;
  parameters: Array<{
    name: string;
    displayName: string;
    value: JsonValue;
  }>;
  allowSession: boolean;
  allowAlways: boolean;
}

export type CommandApprovalOption =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | { type: "execpolicy"; amendment: ExecPolicyAmendment }
  | { type: "networkpolicy"; amendment: NetworkPolicyAmendment };

interface BaseApprovalRequest {
  requestId: ServerRequestId;
  threadId: string;
}

export type ApprovalRequest =
  | (BaseApprovalRequest & {
      type: "command";
      turnId: string;
      itemId: string;
      command: string | null;
      reason: string | null;
      additionalPermissions: AdditionalPermissionProfile | null;
      networkApprovalContext: NetworkApprovalContext | null;
      proposedExecPolicyAmendment: ExecPolicyAmendment | null;
      proposedNetworkPolicyAmendments: NetworkPolicyAmendment[] | null;
      availableDecisions: CommandApprovalOption[] | null;
    })
  | (BaseApprovalRequest & {
      type: "file";
      turnId: string;
      itemId: string;
      reason: string | null;
    })
  | (BaseApprovalRequest & {
      type: "permissions";
      turnId: string;
      itemId: string;
      reason: string | null;
      permissions: AdditionalPermissionProfile;
    })
  | (BaseApprovalRequest & {
      type: "user-input";
      turnId: string;
      itemId: string;
      questions: Array<{
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }> | null;
        allowOther: boolean;
        secret: boolean;
      }>;
      autoResolutionMs: number | null;
    })
  | (BaseApprovalRequest & {
      type: "elicitation";
      turnId: string | null;
      serverName: string;
      mode: "form" | "openai/form" | "url";
      message: string;
      url?: string;
      toolApproval?: McpToolApproval;
    });

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type CommandApprovalResult =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | { type: "execpolicy"; amendment: ExecPolicyAmendment }
  | { type: "networkpolicy"; amendment: NetworkPolicyAmendment };

export type ApprovalResponse =
  | { type: "command"; decision: CommandApprovalResult }
  | { type: "file"; decision: "accept" | "acceptForSession" | "decline" | "cancel" }
  | {
      type: "permissions";
      permissions: AdditionalPermissionProfile;
      scope: "turn";
    }
  | { type: "user-input"; answers: Record<string, string[]> }
  | {
      type: "elicitation";
      action: "accept" | "decline" | "cancel";
      content: JsonValue | null;
      persist: "session" | "always" | null;
    };

export interface ApprovalRequestHandler {
  handle(request: ApprovalRequest): Promise<ApprovalResponse>;
}
