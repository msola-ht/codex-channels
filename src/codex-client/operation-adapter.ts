import type {
  OperationStatus,
  OperationUpdate,
  SubagentState,
  SubagentStatus,
} from "../conversation-core/index.js";

type ItemPhase = "started" | "completed";

export function toOperationUpdate(
  item: Record<string, unknown>,
  phase: ItemPhase,
): OperationUpdate | undefined {
  const itemId = stringValue(item.id);
  const type = stringValue(item.type);
  if (!itemId || !type) {
    return undefined;
  }
  const common = {
    itemId,
    status: operationStatus(item, phase),
    ...optionalNumber(item, "durationMs"),
  };
  switch (type) {
    case "commandExecution": {
      const command = stringValue(item.command);
      if (!command) {
        return undefined;
      }
      const exitCode = finiteNumber(item.exitCode);
      return {
        ...common,
        kind: "command",
        detail: sanitizeOperationText(command),
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
    }
    case "fileChange": {
      const paths = arrayValue(item.changes)
        .map((change) => stringValue(recordValue(change)?.path))
        .filter((path): path is string => path !== undefined);
      return {
        ...common,
        kind: "fileChange",
        ...(paths.length > 0 ? { detail: summarizeValues(paths) } : {}),
      };
    }
    case "mcpToolCall": {
      const server = stringValue(item.server);
      const tool = stringValue(item.tool);
      return {
        ...common,
        kind: "mcpTool",
        ...(tool ? { detail: server ? `${server}.${tool}` : tool } : {}),
        readOnlyHint: typeof item.readOnlyHint === "boolean"
          ? item.readOnlyHint
          : null,
      };
    }
    case "dynamicToolCall": {
      const namespace = stringValue(item.namespace);
      const tool = stringValue(item.tool);
      return {
        ...common,
        kind: "dynamicTool",
        ...(tool ? { detail: namespace ? `${namespace}.${tool}` : tool } : {}),
      };
    }
    case "collabAgentToolCall": {
      const tool = stringValue(item.tool);
      const receiverThreadIds = arrayValue(item.receiverThreadIds)
        .map(stringValue)
        .filter((threadId): threadId is string => threadId !== undefined);
      const subagentStates = parseSubagentStates(item.agentsStates);
      return {
        ...common,
        kind: "subagent",
        status: subagentOperationStatus(common.status, subagentStates),
        ...(tool ? { action: tool } : {}),
        ...(receiverThreadIds.length > 0 ? { receiverThreadIds } : {}),
        ...(subagentStates.length > 0 ? { subagentStates } : {}),
      };
    }
    case "subAgentActivity": {
      const kind = stringValue(item.kind);
      const path = stringValue(item.agentPath);
      return {
        ...common,
        kind: "subagent",
        ...(kind ? { action: kind } : {}),
        ...(path ? { detail: truncate(path, 180) } : {}),
      };
    }
    case "webSearch": {
      const query = stringValue(item.query);
      return {
        ...common,
        kind: "webSearch",
        ...(query ? { detail: sanitizeOperationText(query) } : {}),
      };
    }
    case "imageView": {
      const path = stringValue(item.path);
      return {
        ...common,
        kind: "imageView",
        ...(path ? { detail: truncate(path, 220) } : {}),
      };
    }
    case "imageGeneration": {
      const imagePath = stringValue(item.savedPath);
      const failure = recordValue(item.failure);
      const detail = stringValue(failure?.type) === "usageLimitExceeded"
        ? "图片生成额度已用尽"
        : undefined;
      return {
        ...common,
        kind: "imageGeneration",
        ...(detail ? { detail } : {}),
        ...(imagePath ? { imagePath } : {}),
      };
    }
    case "sleep":
      return { ...common, kind: "sleep" };
    case "plan":
      return { ...common, kind: "plan" };
    case "contextCompaction":
      return { ...common, kind: "contextCompaction" };
    case "enteredReviewMode":
      return { ...common, kind: "reviewMode", action: "entered" };
    case "exitedReviewMode":
      return { ...common, kind: "reviewMode", action: "exited" };
    default:
      return undefined;
  }
}

function subagentOperationStatus(
  status: OperationStatus,
  states: SubagentState[],
): OperationStatus {
  return states.some((state) =>
    state.status === "errored"
    || state.status === "interrupted"
    || state.status === "notFound"
  )
    ? "failed"
    : status;
}

function parseSubagentStates(value: unknown): SubagentState[] {
  const states = recordValue(value);
  if (states === undefined) {
    return [];
  }
  return Object.entries(states)
    .flatMap(([threadId, rawState]) => {
      const status = subagentStatus(recordValue(rawState)?.status);
      return status === undefined ? [] : [{ threadId, status }];
    })
    .sort((left, right) => left.threadId.localeCompare(right.threadId));
}

function subagentStatus(value: unknown): SubagentStatus | undefined {
  return value === "pendingInit"
      || value === "running"
      || value === "interrupted"
      || value === "completed"
      || value === "errored"
      || value === "shutdown"
      || value === "notFound"
    ? value
    : undefined;
}

export function sanitizeOperationText(value: string): string {
  return truncate(redactCredentialText(value), 320);
}

export function redactCredentialText(value: string): string {
  return value
      .replace(
        /(authorization\s*:\s*(?:bearer|basic)\s+)([^\s'";]+)/gi,
        "$1[REDACTED]",
      )
      .replace(
        /(authorization\s*:\s*)(?!(?:bearer|basic)\b)([^\s'";]+)/gi,
        "$1[REDACTED]",
      )
      .replace(/((?:set-)?cookie\s*:\s*)([^\r\n]+)/gi, "$1[REDACTED]")
      .replace(
        /(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|COOKIE)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|[^\s;]+)/gi,
        "$1[REDACTED]",
      )
      .replace(
        /(\b(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|cookie)\s*:\s*)([^\s'";]+)/gi,
        "$1[REDACTED]",
      )
      .replace(
        /((?:^|[\s'"])(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|cookie)\s+)("[^"]*"|'[^']*'|[^\s;]+)/gi,
        "$1[REDACTED]",
      )
      .replace(
        /(--(?:token|secret|password|passwd|api-key|cookie|authorization)(?:=|\s+))("[^"]*"|'[^']*'|[^\s;]+)/gi,
        "$1[REDACTED]",
      )
      .replace(/(\/bot)\d{6,}:[A-Za-z0-9_-]{20,}/g, "$1[REDACTED]")
      .replace(/((?:^|\s)-u\s+)([^\s;]+)/gi, "$1[REDACTED]")
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/]+:)([^\s@/]+)(@)/gi, "$1[REDACTED]$3");
}

function operationStatus(item: Record<string, unknown>, phase: ItemPhase): OperationStatus {
  if (phase === "started") {
    return "running";
  }
  const status = stringValue(item.status)?.toLowerCase();
  if (status === "failed" || item.success === false) {
    return "failed";
  }
  if (status === "declined") {
    return "declined";
  }
  return "completed";
}

function optionalNumber(
  item: Record<string, unknown>,
  key: string,
): { durationMs?: number } {
  const value = finiteNumber(item[key]);
  return value === undefined ? {} : { durationMs: value };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function summarizeValues(values: string[]): string {
  const visible = values.slice(0, 4).map((value) => truncate(value, 90));
  return `${visible.join("、")}${values.length > visible.length ? ` 等 ${values.length} 个文件` : ""}`;
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : normalized;
}
