import type {
  CommandExplorationKind,
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
      // 与原生 TUI 的 is_exploring_call 一致：用户在终端输入的命令不作只读探索归类。
      const exploration = stringValue(item.source) === "userShell"
        ? undefined
        : summarizeCommandExploration(item.commandActions);
      return {
        ...common,
        kind: "command",
        detail: exploration?.detail ?? sanitizeOperationText(command),
        ...(exploration ? { commandExploration: exploration.kind } : {}),
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
      const computerUse = server === "cua_repl" && (tool === "js" || tool === "js_reset");
      const title = computerUse && tool === "js"
        ? stringValue(recordValue(item.arguments)?.title)
        : undefined;
      const toolName = tool ? server ? `${server}.${tool}` : tool : undefined;
      return {
        ...common,
        kind: "mcpTool",
        ...(computerUse ? { action: "computerUse" } : {}),
        ...(toolName ? {
          detail: title ? `${sanitizeOperationText(title)} · ${toolName}` : toolName,
        } : {}),
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

type ReadAction = { kind: "read"; name: string };
type SearchAction = { kind: "search"; summary: string };
type ListAction = { kind: "listFiles"; summary: string };
type ExplorationAction = ReadAction | SearchAction | ListAction;
type ExplorationSegment = {
  kind: Exclude<CommandExplorationKind, "mixed">;
  text: string;
};

interface CommandExploration {
  kind: CommandExplorationKind;
  detail: string;
}

const maximumExplorationItems = 8;

/**
 * 只读探索命令的展示摘要，语义与原生 TUI 的 “Explored / Read …” 一致。
 *
 * 判定条件与上游 is_exploring_call 相同：commandActions 非空且全部为 read/listFiles/search。
 * 上游只要出现无法识别的片段就把整条命令折叠为 unknown，因此任何缺失、畸形或未知片段都
 * 返回 undefined，由调用方退回原始命令。
 *
 * 该解析是上游声明的最佳近似：上游会忽略部分管道阶段与变更参数，`find … -delete`、
 * `… | tee` 之类仍会被解析为只读动作。因此这里的归类只是展示口径，不是安全或只读保证，
 * 也不参与审批与执行判定。
 */
function summarizeCommandExploration(value: unknown): CommandExploration | undefined {
  const actions = parseExplorationActions(value);
  if (actions === undefined) {
    return undefined;
  }
  const reads = actions.filter((action): action is ReadAction => action.kind === "read");
  const searches = actions.filter((action): action is SearchAction => action.kind === "search");
  const lists = actions.filter((action): action is ListAction => action.kind === "listFiles");
  const readDetail = summarizeNames(reads.map((action) => action.name));
  const searchDetail = summarizeItems(searches.map((action) => action.summary));
  const listDetail = summarizeItems(lists.map((action) => action.summary));
  const segments = [
    reads.length > 0 ? { kind: "read" as const, text: readDetail } : null,
    searches.length > 0 ? { kind: "search" as const, text: searchDetail } : null,
    lists.length > 0 ? { kind: "listFiles" as const, text: listDetail } : null,
  ].filter((segment): segment is ExplorationSegment => segment !== null);
  const only = segments.length === 1 ? segments[0]! : undefined;
  const summary = only !== undefined
    ? only.text
    : segments.map((segment) => `${explorationSegmentLabel(segment.kind)} ${segment.text}`).join("；");
  const detail = sanitizeOperationText(summary);
  return detail.length === 0 ? undefined : { kind: only?.kind ?? "mixed", detail };
}

function explorationSegmentLabel(kind: ExplorationSegment["kind"]): string {
  return ({ read: "读取", search: "搜索", listFiles: "浏览" } as const)[kind];
}

function parseExplorationActions(value: unknown): ExplorationAction[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const actions: ExplorationAction[] = [];
  for (const entry of value) {
    const action = recordValue(entry);
    if (action === undefined) {
      return undefined;
    }
    switch (stringValue(action.type)) {
      case "read": {
        // 官方 name 是必填字段，path 是解析后的绝对路径；缺失 name 时退回原始命令，
        // 不用绝对路径补位。
        const name = stringValue(action.name);
        if (name === undefined) {
          return undefined;
        }
        actions.push({ kind: "read", name });
        break;
      }
      case "search": {
        const query = stringValue(action.query);
        const path = stringValue(action.path);
        const fallback = stringValue(action.command);
        const summary = query !== undefined
          ? path !== undefined ? `${query} in ${path}` : query
          : path ?? fallback;
        if (summary === undefined) {
          return undefined;
        }
        actions.push({ kind: "search", summary });
        break;
      }
      case "listFiles": {
        const summary = stringValue(action.path) ?? stringValue(action.command);
        if (summary === undefined) {
          return undefined;
        }
        actions.push({ kind: "listFiles", summary });
        break;
      }
      default:
        return undefined;
    }
  }
  return actions;
}

function summarizeNames(names: string[]): string {
  const unique = [...new Set(names)];
  const visible = unique.slice(0, maximumExplorationItems);
  return `${visible.join("、")}${unique.length > visible.length ? ` 等 ${unique.length} 个文件` : ""}`;
}

function summarizeItems(items: string[]): string {
  const unique = [...new Set(items)];
  const visible = unique.slice(0, maximumExplorationItems);
  return `${visible.join("、")}${unique.length > visible.length ? ` 等 ${unique.length} 项` : ""}`;
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
  if (status === "failed" || status === "interrupted" || item.success === false) {
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
