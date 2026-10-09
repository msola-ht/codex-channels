import type { HookAction, HookCatalog, HookEntry } from "../application/index.js";
import type {
  ConfigBatchWriteParams,
  HookMetadata,
  HooksListResponse,
} from "../codex-protocol/index.js";
import { sanitizeOperationText } from "./operation-adapter.js";

const eventNames = new Set<HookMetadata["eventName"]>([
  "preToolUse", "permissionRequest", "postToolUse", "preCompact", "postCompact",
  "sessionStart", "sessionEnd", "userPromptSubmit", "subagentStart", "subagentStop",
  "stop", "interrupt",
]);
const sources = new Set<HookMetadata["source"]>([
  "system", "user", "project", "mdm", "sessionFlags", "plugin", "cloudRequirements",
  "cloudManagedConfig", "legacyManagedConfigFile", "legacyManagedConfigMdm", "unknown",
]);
const trustStatuses = new Set<HookMetadata["trustStatus"]>([
  "managed", "untrusted", "trusted", "modified",
]);

/** Keep raw diagnostics and handler payloads inside the Client boundary. */
export function toHookCatalog(response: HooksListResponse, cwd: string): HookCatalog {
  if (!response || !Array.isArray(response.data) || response.data.length !== 1) {
    throw new Error("Codex 响应缺少有效 hooks 目录");
  }
  const entry = response.data[0];
  if (!entry || entry.cwd !== cwd || !Array.isArray(entry.hooks)
    || !Array.isArray(entry.warnings) || !entry.warnings.every(value => typeof value === "string")
    || !Array.isArray(entry.errors) || !entry.errors.every(value => value
      && typeof value.path === "string" && typeof value.message === "string")) {
    throw new Error("Codex 响应包含无效 hooks 目录或 Workspace");
  }
  const hooks = entry.hooks.map(toHookEntry);
  if (new Set(hooks.map(hook => hook.key)).size !== hooks.length) {
    throw new Error("Codex 响应包含重复 Hook 标识");
  }
  return { hooks, warningCount: entry.warnings.length, errorCount: entry.errors.length };
}

function toHookEntry(hook: HookMetadata): HookEntry {
  if (!hook || !eventNames.has(hook.eventName) || !sources.has(hook.source)
    || !trustStatuses.has(hook.trustStatus)
    || typeof hook.enabled !== "boolean" || typeof hook.isManaged !== "boolean"
    || (hook.matcher !== null && typeof hook.matcher !== "string")
    || (hook.additionalContextLimit !== null
      && (!Number.isSafeInteger(hook.additionalContextLimit) || hook.additionalContextLimit < 0))) {
    throw new Error("Codex 响应缺少有效 Hook 元数据");
  }
  const key = requiredIdentifier(hook.key, "key");
  const timeoutSec = nonnegativeInteger(hook.timeoutSec, "timeoutSec");
  const currentHash = requiredIdentifier(hook.currentHash, "currentHash");
  const sourcePath = displayText(requiredString(hook.sourcePath, "sourcePath"));
  const matcher = hook.matcher === null ? null : displayText(hook.matcher);
  let description: string;
  let completeHandler: boolean;
  switch (hook.handlerType) {
    case "command": {
      if (typeof hook.async !== "boolean") {
        throw new Error("Codex 响应缺少有效 Hook command async");
      }
      const command = requiredString(hook.command, "command");
      description = displayText(command);
      completeHandler = description === command;
      break;
    }
    case "mcpTool": {
      const server = requiredString(hook.server, "server");
      const tool = requiredString(hook.tool, "tool");
      const raw = `${server}/${tool}`;
      description = displayText(raw);
      // MCP input templates are omitted from hooks/list metadata.
      completeHandler = false;
      break;
    }
    case "prompt":
    case "agent":
      // hooks/list omits the actual prompt/agent configuration needed for review.
      description = hook.handlerType;
      completeHandler = false;
      break;
    default:
      throw new Error("Codex 响应包含不支持的 Hook handlerType");
  }
  return {
    key,
    eventName: hook.eventName,
    matcher,
    handlerType: hook.handlerType,
    timeoutSec,
    async: hook.handlerType === "command" ? hook.async : null,
    additionalContextLimit: hook.additionalContextLimit,
    description,
    source: hook.source,
    sourcePath,
    enabled: hook.enabled,
    isManaged: hook.isManaged,
    currentHash,
    trustStatus: hook.trustStatus,
    reviewable: completeHandler && sourcePath === hook.sourcePath
      && matcher === hook.matcher && hook.source !== "unknown",
  };
}

export function toHookStateWrite(input: {
  key: string;
  currentHash: string;
  action: HookAction;
  expectedVersion: string;
}): ConfigBatchWriteParams {
  const key = requiredIdentifier(input.key, "key");
  const currentHash = requiredIdentifier(input.currentHash, "currentHash");
  const expectedVersion = requiredIdentifier(input.expectedVersion, "expectedVersion");
  if (input.action !== "trust" && input.action !== "enable" && input.action !== "disable") {
    throw new Error("不支持的 Hook 操作");
  }
  return {
    edits: [{
      keyPath: "hooks.state",
      value: { [key]: input.action === "trust"
        ? { trusted_hash: currentHash }
        : { enabled: input.action === "enable" } },
      mergeStrategy: "upsert",
    }],
    expectedVersion,
    reloadUserConfig: true,
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Codex 响应缺少有效 Hook ${field}`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, field: string): number {
  // Generated u64 fields are bigint in TypeScript but arrive as JSON numbers.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Codex 响应缺少有效 Hook ${field}`);
  }
  return value;
}

function requiredIdentifier(value: unknown, field: string): string {
  const identifier = requiredString(value, field);
  if (/[\p{Cc}\p{Cf}]/u.test(identifier)) {
    throw new Error(`Codex 响应包含无效 Hook ${field}`);
  }
  return identifier;
}

function displayText(value: string): string {
  return sanitizeOperationText(value).replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
}
