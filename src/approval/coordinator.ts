import type { SessionRouter } from "../session-routing/index.js";
import type {
  AdditionalPermissionProfile,
  ApprovalRequest,
  ApprovalRequestHandler,
  ApprovalResponse,
  CommandApprovalOption,
  CommandApprovalResult,
  ExecPolicyAmendment,
  FileSystemPath,
  JsonValue,
  NetworkApprovalContext,
  NetworkPolicyAmendment,
} from "./requests.js";
import type { InteractionDecision, InteractionPort } from "./types.js";

export class ApprovalCoordinator implements ApprovalRequestHandler {
  constructor(
    private readonly router: SessionRouter,
    private readonly interaction: InteractionPort,
    private readonly timeoutMs: number,
  ) {}

  async handle(request: ApprovalRequest): Promise<ApprovalResponse> {
    const target = this.router.targetForThread(request.threadId);
    if (!target) {
      return safeDecline(request);
    }

    const requestId = String(request.requestId);
    switch (request.type) {
      case "command": {
        if (!offersCommandDecision(request.availableDecisions, "accept")) {
          return { type: "command", decision: "decline" };
        }
        const hasCommand = request.command !== null && request.command.trim().length > 0;
        if (!hasCommand && !request.networkApprovalContext) {
          return { type: "command", decision: "decline" };
        }
        const execPolicyAmendment = offeredExecPolicyAmendment(request);
        const networkPolicyAmendments = offeredNetworkPolicyAmendments(request);
        if (!networkPolicyAmendments.valid) {
          return { type: "command", decision: "decline" };
        }
        const isNetworkOnly = request.networkApprovalContext !== null && !hasCommand;
        const decision = await this.interaction.request(target, {
          type: "approval",
          requestId,
          kind: "command",
          threadId: request.threadId,
          turnId: request.turnId,
          itemId: request.itemId,
          title: isNetworkOnly ? "Codex 请求访问网络" : "Codex 请求执行命令",
          detail: [
            request.reason ?? undefined,
            hasCommand ? request.command ?? undefined : undefined,
            request.networkApprovalContext
              ? formatNetworkApprovalContext(request.networkApprovalContext)
              : undefined,
            formatAdditionalPermissions(request.additionalPermissions),
            execPolicyAmendment
              ? `持久规则前缀：${JSON.stringify(execPolicyAmendment)}`
              : undefined,
            ...networkPolicyAmendments.amendments.map((amendment) =>
              `持久网络规则：${amendment.action === "allow" ? "允许" : "拒绝"} ${amendment.host}`),
          ].filter(Boolean).join("\n\n"),
          allowSession: offersCommandDecision(
            request.availableDecisions,
            "acceptForSession",
          ),
          ...(execPolicyAmendment ? { execPolicyAmendment } : {}),
          ...(request.networkApprovalContext
            ? { networkApprovalContext: request.networkApprovalContext }
            : {}),
          ...(networkPolicyAmendments.amendments.length > 0
            ? { networkPolicyAmendments: networkPolicyAmendments.amendments }
            : {}),
          expiresInMs: this.timeoutMs,
        });
        return {
          type: "command",
          decision: commandApprovalDecision(
            decision,
            execPolicyAmendment,
            networkPolicyAmendments.amendments,
          ),
        };
      }
      case "file": {
        const decision = await this.interaction.request(target, {
          type: "approval",
          requestId,
          kind: "file",
          threadId: request.threadId,
          turnId: request.turnId,
          itemId: request.itemId,
          title: "Codex 请求修改文件",
          detail: request.reason ?? "Codex 请求修改文件",
          allowSession: true,
          expiresInMs: this.timeoutMs,
        });
        return {
          type: "file",
          decision: basicApprovalDecision(decision),
        };
      }
      case "permissions": {
        const decision = await this.interaction.request(target, {
          type: "approval",
          requestId,
          kind: "permissions",
          threadId: request.threadId,
          turnId: request.turnId,
          itemId: request.itemId,
          title: "Codex 请求临时权限",
          detail: request.reason ?? JSON.stringify(request.permissions, null, 2),
          allowSession: false,
          expiresInMs: this.timeoutMs,
        });
        return {
          type: "permissions",
          permissions: isApproved(decision)
            ? request.permissions
            : emptyPermissionProfile(),
          scope: "turn",
        };
      }
      case "user-input": {
        const decision = await this.interaction.request(target, {
          type: "user-input",
          requestId,
          threadId: request.threadId,
          turnId: request.turnId,
          itemId: request.itemId,
          title: "Codex 需要补充信息",
          questions: request.questions.map((question) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            options: question.options?.map((option) => option.label) ?? [],
            allowOther: question.allowOther,
            secret: question.secret,
          })),
          expiresInMs: request.autoResolutionMs ?? this.timeoutMs,
        });
        return {
          type: "user-input",
          answers: decision.type === "user-input" ? decision.answers : {},
        };
      }
      case "elicitation": {
        const decision = await this.interaction.request(target, {
          type: "elicitation",
          requestId,
          threadId: request.threadId,
          turnId: request.turnId,
          title: `MCP ${request.serverName} 请求输入`,
          message: request.message,
          mode: request.mode === "url" ? "url" : "form",
          ...(request.mode === "url" ? { url: request.url } : {}),
          expiresInMs: this.timeoutMs,
        });
        if (decision.type !== "elicitation" || !isJsonValue(decision.content)) {
          return { type: "elicitation", action: "cancel", content: null };
        }
        return {
          type: "elicitation",
          action: decision.action,
          content: decision.action === "accept" ? decision.content : null,
        };
      }
    }
  }

  resolved(requestId: string | number): void {
    this.interaction.resolved?.(String(requestId));
  }
}

function safeDecline(request: ApprovalRequest): ApprovalResponse {
  switch (request.type) {
    case "command":
      return { type: "command", decision: "decline" };
    case "file":
      return { type: "file", decision: "decline" };
    case "permissions":
      return {
        type: "permissions",
        permissions: emptyPermissionProfile(),
        scope: "turn",
      };
    case "user-input":
      return { type: "user-input", answers: {} };
    case "elicitation":
      return { type: "elicitation", action: "cancel", content: null };
  }
}

function emptyPermissionProfile(): AdditionalPermissionProfile {
  return { network: null, fileSystem: null };
}

function isApproved(decision: InteractionDecision): boolean {
  return decision.type === "approval" && decision.approved;
}

function basicApprovalDecision(
  decision: InteractionDecision,
): "accept" | "acceptForSession" | "decline" {
  if (decision.type !== "approval" || !decision.approved) {
    return "decline";
  }
  return decision.scope === "session" ? "acceptForSession" : "accept";
}

function commandApprovalDecision(
  decision: InteractionDecision,
  execPolicyAmendment?: ExecPolicyAmendment,
  networkPolicyAmendments: readonly NetworkPolicyAmendment[] = [],
): CommandApprovalResult {
  if (decision.type !== "approval" || !decision.approved) {
    return "decline";
  }
  if (decision.scope === "session") {
    return "acceptForSession";
  }
  if (decision.scope === "execpolicy") {
    return execPolicyAmendment
      ? { type: "execpolicy", amendment: execPolicyAmendment }
      : "decline";
  }
  if (decision.scope === "networkpolicy") {
    const amendment = networkPolicyAmendments.find((offered) =>
      sameNetworkPolicyAmendment(offered, decision.networkPolicyAmendment));
    return amendment
      ? { type: "networkpolicy", amendment }
      : "decline";
  }
  return "accept";
}

function formatAdditionalPermissions(
  permissions: AdditionalPermissionProfile | null,
): string | undefined {
  if (!permissions) {
    return undefined;
  }
  const lines: string[] = [];
  if (permissions.network) {
    lines.push(
      `网络：${
        permissions.network.enabled === true
          ? "开启"
          : permissions.network.enabled === false ? "关闭" : "不变"
      }`,
    );
  }
  const fileSystem = permissions.fileSystem;
  if (fileSystem) {
    if (fileSystem.read?.length) {
      lines.push(`读取：${fileSystem.read.join("、")}`);
    }
    if (fileSystem.write?.length) {
      lines.push(`写入：${fileSystem.write.join("、")}`);
    }
    if (fileSystem.globScanMaxDepth !== undefined) {
      lines.push(`Glob 扫描深度：${fileSystem.globScanMaxDepth}`);
    }
    for (const entry of fileSystem.entries ?? []) {
      const access = entry.access === "read"
        ? "读取"
        : entry.access === "write" ? "写入" : "拒绝";
      lines.push(`${access}规则：${formatPermissionPath(entry.path)}`);
    }
  }
  return lines.length > 0
    ? `额外权限：\n${lines.join("\n")}`
    : "额外权限：未请求扩展";
}

function offersCommandDecision(
  decisions: readonly CommandApprovalOption[] | null,
  expected: "accept" | "acceptForSession",
): boolean {
  return decisions === null || decisions.includes(expected);
}

function offeredExecPolicyAmendment(
  request: Extract<ApprovalRequest, { type: "command" }>,
): ExecPolicyAmendment | undefined {
  const proposed = request.proposedExecPolicyAmendment;
  if (!proposed?.length) {
    return undefined;
  }
  if (request.availableDecisions === null) {
    return [...proposed];
  }
  return request.availableDecisions.some((decision) =>
    typeof decision === "object"
    && decision.type === "execpolicy"
    && sameStringArray(decision.amendment, proposed))
    ? [...proposed]
    : undefined;
}

function offeredNetworkPolicyAmendments(
  request: Extract<ApprovalRequest, { type: "command" }>,
): { valid: boolean; amendments: NetworkPolicyAmendment[] } {
  const proposed = request.proposedNetworkPolicyAmendments ?? [];
  const context = request.networkApprovalContext;
  if (
    proposed.length > 0
    && (!context || proposed.some((amendment) => amendment.host !== context.host))
  ) {
    return { valid: false, amendments: [] };
  }
  if (request.availableDecisions === null) {
    const legacyAllow = proposed.find((amendment) => amendment.action === "allow");
    return {
      valid: true,
      amendments: legacyAllow ? [legacyAllow] : [],
    };
  }
  const offered = request.availableDecisions.filter(
    (decision): decision is Extract<CommandApprovalOption, { type: "networkpolicy" }> =>
      typeof decision === "object" && decision.type === "networkpolicy",
  ).map((decision) => decision.amendment);
  if (
    offered.some((amendment) =>
      !context
      || amendment.host !== context.host
      || !proposed.some((candidate) =>
        sameNetworkPolicyAmendment(candidate, amendment))
    )
  ) {
    return { valid: false, amendments: [] };
  }
  return {
    valid: true,
    amendments: offered.map((amendment) =>
      proposed.find((candidate) =>
        sameNetworkPolicyAmendment(candidate, amendment))!),
  };
}

function formatNetworkApprovalContext(context: NetworkApprovalContext): string {
  return `网络目标：${context.host}\n协议：${context.protocol}`;
}

function sameNetworkPolicyAmendment(
  left: NetworkPolicyAmendment,
  right: NetworkPolicyAmendment,
): boolean {
  return left.host === right.host && left.action === right.action;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function formatPermissionPath(path: FileSystemPath): string {
  switch (path.type) {
    case "path":
      return path.path;
    case "glob_pattern":
      return path.pattern;
    case "special": {
      const labels = {
        root: "根目录",
        minimal: "最小系统路径",
        project_roots: "项目目录",
        tmpdir: "系统临时目录",
        slash_tmp: "/tmp",
      } as const;
      if (path.value.kind === "unknown") {
        return path.value.subpath
          ? `${path.value.path}/${path.value.subpath}`
          : path.value.path;
      }
      const label = labels[path.value.kind];
      return path.value.kind === "project_roots" && path.value.subpath
        ? `${label}/${path.value.subpath}`
        : label;
    }
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return typeof value === "object"
    && Object.values(value as Record<string, unknown>).every(isJsonValue);
}
