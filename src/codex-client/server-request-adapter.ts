import type {
  AdditionalFileSystemPermissions,
  AdditionalPermissionProfile,
  ApprovalRequest,
  ApprovalRequestHandler,
  ApprovalResponse,
  CommandApprovalOption,
  FileSystemPath,
  FileSystemSandboxEntry,
  JsonValue,
  McpToolApproval,
  NetworkApprovalContext,
  NetworkPolicyAmendment,
} from "../approval/index.js";
import type { ServerRequest } from "../codex-protocol/index.js";
import { JsonRpcError, type RpcServerRequest } from "./json-rpc.js";

type SupportedServerRequest = Extract<
  ServerRequest,
  {
    method:
      | "item/commandExecution/requestApproval"
      | "item/fileChange/requestApproval"
      | "item/permissions/requestApproval"
      | "item/tool/requestUserInput"
      | "mcpServer/elicitation/request";
  }
>;

const methods = {
  command: "item/commandExecution/requestApproval",
  file: "item/fileChange/requestApproval",
  permissions: "item/permissions/requestApproval",
  userInput: "item/tool/requestUserInput",
  elicitation: "mcpServer/elicitation/request",
} as const satisfies Record<string, SupportedServerRequest["method"]>;

type DecodeResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; response: unknown };

export async function handleApprovalServerRequest(
  request: RpcServerRequest,
  handler: ApprovalRequestHandler,
): Promise<unknown> {
  const decoded = decodeApprovalServerRequest(request);
  if (!decoded.ok) {
    return decoded.response;
  }
  const response = await handler.handle(decoded.request);
  return encodeApprovalResponse(decoded.request, response);
}

export function decodeApprovalServerRequest(
  request: RpcServerRequest,
): DecodeResult {
  switch (request.method) {
    case methods.command: {
      const decoded = decodeCommandRequest(request);
      return decoded
        ? { ok: true, request: decoded }
        : { ok: false, response: { decision: "decline" } };
    }
    case methods.file: {
      const decoded = decodeFileRequest(request);
      return decoded
        ? { ok: true, request: decoded }
        : { ok: false, response: { decision: "decline" } };
    }
    case methods.permissions: {
      const decoded = decodePermissionsRequest(request);
      return decoded
        ? { ok: true, request: decoded }
        : { ok: false, response: { permissions: {}, scope: "turn" } };
    }
    case methods.userInput: {
      const decoded = decodeUserInputRequest(request);
      return decoded
        ? { ok: true, request: decoded }
        : { ok: false, response: { answers: {} } };
    }
    case methods.elicitation: {
      const decoded = decodeElicitationRequest(request);
      return decoded
        ? { ok: true, request: decoded }
        : {
            ok: false,
            response: { action: "cancel", content: null, _meta: null },
          };
    }
    default:
      throw new JsonRpcError(
        -32601,
        `不支持的 App Server 请求：${request.method}`,
      );
  }
}

function decodeCommandRequest(
  request: RpcServerRequest,
): Extract<ApprovalRequest, { type: "command" }> | undefined {
  const params = asRecord(request.params);
  const base = approvalIdentity(request, params);
  const command = nullableOptionalString(params?.command);
  const reason = nullableOptionalString(params?.reason);
  const additionalPermissions = parseOptionalPermissionProfile(
    params?.additionalPermissions,
  );
  const networkApprovalContext = parseOptionalNetworkApprovalContext(
    params?.networkApprovalContext,
  );
  const proposedExecPolicyAmendment = parseOptionalStringArray(
    params?.proposedExecpolicyAmendment,
  );
  const proposedNetworkPolicyAmendments = parseOptionalNetworkAmendments(
    params?.proposedNetworkPolicyAmendments,
  );
  const availableDecisions = parseOptionalCommandDecisions(
    params?.availableDecisions,
  );
  if (
    !base
    || !command.valid
    || !reason.valid
    || !additionalPermissions.valid
    || !networkApprovalContext.valid
    || !proposedExecPolicyAmendment.valid
    || !proposedNetworkPolicyAmendments.valid
    || !availableDecisions.valid
  ) {
    return undefined;
  }
  return {
    type: "command",
    ...base,
    command: command.value,
    reason: reason.value,
    additionalPermissions: additionalPermissions.value,
    networkApprovalContext: networkApprovalContext.value,
    proposedExecPolicyAmendment: proposedExecPolicyAmendment.value,
    proposedNetworkPolicyAmendments: proposedNetworkPolicyAmendments.value,
    availableDecisions: availableDecisions.value,
  };
}

function decodeFileRequest(
  request: RpcServerRequest,
): Extract<ApprovalRequest, { type: "file" }> | undefined {
  const params = asRecord(request.params);
  const base = approvalIdentity(request, params);
  const reason = nullableOptionalString(params?.reason);
  return base && reason.valid
    ? { type: "file", ...base, reason: reason.value }
    : undefined;
}

function decodePermissionsRequest(
  request: RpcServerRequest,
): Extract<ApprovalRequest, { type: "permissions" }> | undefined {
  const params = asRecord(request.params);
  const base = approvalIdentity(request, params);
  const reason = nullableOptionalString(params?.reason);
  const permissions = parsePermissionProfile(params?.permissions);
  return base && reason.valid && permissions
    ? {
        type: "permissions",
        ...base,
        reason: reason.value,
        permissions,
      }
    : undefined;
}

function decodeUserInputRequest(
  request: RpcServerRequest,
): Extract<ApprovalRequest, { type: "user-input" }> | undefined {
  const params = asRecord(request.params);
  const base = approvalIdentity(request, params);
  if (!base || !Array.isArray(params?.questions)) {
    return undefined;
  }
  const questions = params.questions.map(parseQuestion);
  if (questions.some((question) => question === undefined)) {
    return undefined;
  }
  const autoResolutionMs = nullableOptionalFiniteNumber(params.autoResolutionMs);
  return autoResolutionMs.valid
    ? {
        type: "user-input",
        ...base,
        questions: questions.filter(
          (question): question is NonNullable<typeof question> =>
            question !== undefined,
        ),
        autoResolutionMs: autoResolutionMs.value,
      }
    : undefined;
}

function decodeElicitationRequest(
  request: RpcServerRequest,
): Extract<ApprovalRequest, { type: "elicitation" }> | undefined {
  const params = asRecord(request.params);
  const threadId = nonEmptyString(params?.threadId);
  const turnId = strictNullableString(params?.turnId);
  const serverName = nonEmptyString(params?.serverName);
  const message = nonEmptyString(params?.message);
  if (!threadId || !turnId.valid || !serverName || !message) {
    return undefined;
  }
  if (params?.mode === "url") {
    const url = nonEmptyString(params.url);
    return url
      ? {
          type: "elicitation",
          requestId: request.id,
          threadId,
          turnId: turnId.value,
          serverName,
          mode: "url",
          message,
          url,
        }
      : undefined;
  }
  if (params?.mode === "form" || params?.mode === "openai/form") {
    const parsedToolApproval = params.mode === "form"
      ? parseMcpToolApproval(params.requestedSchema, params._meta)
      : { kind: "not-tool" as const };
    if (parsedToolApproval.kind === "invalid") {
      return undefined;
    }
    return {
      type: "elicitation",
      requestId: request.id,
      threadId,
      turnId: turnId.value,
      serverName,
      mode: params.mode,
      message,
      ...(parsedToolApproval.kind === "valid"
        ? { toolApproval: parsedToolApproval.value }
        : {}),
    };
  }
  return undefined;
}

function encodeApprovalResponse(
  request: ApprovalRequest,
  response: ApprovalResponse,
): unknown {
  if (request.type !== response.type) {
    throw new JsonRpcError(-32603, "审批响应类型与请求不匹配");
  }
  switch (response.type) {
    case "command":
      return { decision: encodeCommandDecision(response.decision) };
    case "file":
      return { decision: response.decision };
    case "permissions":
      return {
        permissions: encodePermissionProfile(response.permissions),
        scope: response.scope,
      };
    case "user-input":
      return {
        answers: Object.fromEntries(
          Object.entries(response.answers).map(([id, answers]) => [
            id,
            { answers },
          ]),
        ),
      };
    case "elicitation":
      return {
        action: response.action,
        content: response.action === "accept" ? response.content : null,
        _meta: response.action === "accept" && response.persist
          ? { persist: response.persist }
          : null,
      };
  }
}

function parseMcpToolApproval(
  requestedSchema: unknown,
  metaValue: unknown,
):
  | { kind: "not-tool" }
  | { kind: "invalid" }
  | { kind: "valid"; value: McpToolApproval } {
  const schema = asRecord(requestedSchema);
  const properties = asRecord(schema?.properties);
  const meta = asRecord(metaValue);
  if (meta?.codex_approval_kind !== "mcp_tool_call") {
    return { kind: "not-tool" };
  }
  if (
    schema?.type !== "object"
    || !properties
    || Object.keys(properties).length > 0
  ) {
    return { kind: "invalid" };
  }
  const persist = parseMcpToolApprovalPersist(meta.persist);
  const parameters = parseMcpToolApprovalParameters(meta.tool_params_display);
  if (!persist.valid || !parameters.valid) {
    return { kind: "invalid" };
  }
  return {
    kind: "valid",
    value: {
      connectorName: optionalNonEmptyString(meta.connector_name),
      toolTitle: optionalNonEmptyString(meta.tool_title),
      toolDescription: optionalNonEmptyString(meta.tool_description),
      parameters: parameters.value,
      allowSession: persist.value.includes("session"),
      allowAlways: persist.value.includes("always"),
    },
  };
}

function parseMcpToolApprovalPersist(
  value: unknown,
): { valid: true; value: Array<"session" | "always"> } | { valid: false } {
  if (value === undefined) {
    return { valid: true, value: [] };
  }
  const values = Array.isArray(value) ? value : [value];
  if (
    values.some((entry) => entry !== "session" && entry !== "always")
  ) {
    return { valid: false };
  }
  return {
    valid: true,
    value: [...new Set(values as Array<"session" | "always">)],
  };
}

function parseMcpToolApprovalParameters(
  value: unknown,
): {
  valid: true;
  value: McpToolApproval["parameters"];
} | { valid: false } {
  if (value === undefined) {
    return { valid: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return { valid: false };
  }
  const parameters = value.map((entry) => {
    const record = asRecord(entry);
    const name = nonEmptyString(record?.name);
    const displayName = nonEmptyString(record?.display_name);
    return name && displayName && isJsonValue(record?.value)
      ? { name, displayName, value: record.value }
      : undefined;
  });
  return parameters.some((entry) => entry === undefined)
    ? { valid: false }
    : {
        valid: true,
        value: parameters.filter(
          (entry): entry is NonNullable<typeof entry> => entry !== undefined,
        ),
      };
}

function encodeCommandDecision(
  decision: Extract<ApprovalResponse, { type: "command" }>["decision"],
): unknown {
  if (typeof decision === "string") {
    return decision;
  }
  return decision.type === "execpolicy"
    ? {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: decision.amendment,
        },
      }
    : {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: decision.amendment,
        },
      };
}

function encodePermissionProfile(
  permissions: AdditionalPermissionProfile,
): Record<string, unknown> {
  return {
    ...(permissions.network ? { network: permissions.network } : {}),
    ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}),
  };
}

function approvalIdentity(
  request: RpcServerRequest,
  params: Record<string, unknown> | undefined,
): {
  requestId: string | number;
  threadId: string;
  turnId: string;
  itemId: string;
} | undefined {
  const threadId = nonEmptyString(params?.threadId);
  const turnId = nonEmptyString(params?.turnId);
  const itemId = nonEmptyString(params?.itemId);
  return threadId && turnId && itemId
    ? { requestId: request.id, threadId, turnId, itemId }
    : undefined;
}

function parseQuestion(value: unknown): Extract<
  ApprovalRequest,
  { type: "user-input" }
>["questions"][number] | undefined {
  const record = asRecord(value);
  const id = nonEmptyString(record?.id);
  const header = nonEmptyString(record?.header);
  const question = nonEmptyString(record?.question);
  const options = parseQuestionOptions(record?.options);
  if (
    !id
    || !header
    || !question
    || !options.valid
    || typeof record?.isOther !== "boolean"
    || typeof record.isSecret !== "boolean"
  ) {
    return undefined;
  }
  return {
    id,
    header,
    question,
    options: options.value,
    allowOther: record.isOther,
    secret: record.isSecret,
  };
}

function parseQuestionOptions(
  value: unknown,
): {
  valid: true;
  value: Array<{ label: string; description: string }> | null;
} | { valid: false } {
  if (value === null) {
    return { valid: true, value: null };
  }
  if (!Array.isArray(value)) {
    return { valid: false };
  }
  const options = value.map((entry) => {
    const record = asRecord(entry);
    const label = nonEmptyString(record?.label);
    const description = stringValue(record?.description);
    return label && description !== undefined ? { label, description } : undefined;
  });
  return options.some((option) => option === undefined)
    ? { valid: false }
    : {
        valid: true,
        value: options.filter(
          (option): option is NonNullable<typeof option> => option !== undefined,
        ),
      };
}

function parseOptionalCommandDecisions(
  value: unknown,
): { valid: true; value: CommandApprovalOption[] | null } | { valid: false } {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  if (!Array.isArray(value)) {
    return { valid: false };
  }
  const decisions = value.map(parseCommandDecision);
  return decisions.some((decision) => decision === undefined)
    ? { valid: false }
    : {
        valid: true,
        value: decisions.filter(
          (decision): decision is CommandApprovalOption =>
            decision !== undefined,
        ),
      };
}

function parseCommandDecision(value: unknown): CommandApprovalOption | undefined {
  if (
    value === "accept"
    || value === "acceptForSession"
    || value === "decline"
    || value === "cancel"
  ) {
    return value;
  }
  const record = asRecord(value);
  const exec = asRecord(record?.acceptWithExecpolicyAmendment);
  if (exec) {
    const amendment = parseStringArray(exec.execpolicy_amendment);
    return amendment ? { type: "execpolicy", amendment } : undefined;
  }
  const network = asRecord(record?.applyNetworkPolicyAmendment);
  if (network) {
    const amendment = parseNetworkAmendment(network.network_policy_amendment);
    return amendment ? { type: "networkpolicy", amendment } : undefined;
  }
  return undefined;
}

function parseOptionalPermissionProfile(
  value: unknown,
): { valid: true; value: AdditionalPermissionProfile | null } | { valid: false } {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  const parsed = parsePermissionProfile(value);
  return parsed
    ? { valid: true, value: parsed }
    : { valid: false };
}

function parsePermissionProfile(
  value: unknown,
): AdditionalPermissionProfile | undefined {
  const record = asRecordWithOnly(value, ["network", "fileSystem"]);
  if (!record) {
    return undefined;
  }
  const network = parseNetworkPermissions(record.network);
  const fileSystem = parseFileSystemPermissions(record.fileSystem);
  return network.valid && fileSystem.valid
    ? { network: network.value, fileSystem: fileSystem.value }
    : undefined;
}

function parseNetworkPermissions(
  value: unknown,
): {
  valid: true;
  value: AdditionalPermissionProfile["network"];
} | { valid: false } {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  const record = asRecordWithOnly(value, ["enabled"]);
  return record && (record.enabled === null || typeof record.enabled === "boolean")
    ? { valid: true, value: { enabled: record.enabled } }
    : { valid: false };
}

function parseFileSystemPermissions(
  value: unknown,
): {
  valid: true;
  value: AdditionalFileSystemPermissions | null;
} | { valid: false } {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  const record = asRecordWithOnly(
    value,
    ["read", "write", "globScanMaxDepth", "entries"],
  );
  const read = nullableOptionalStringArray(record?.read);
  const write = nullableOptionalStringArray(record?.write);
  const depth = record?.globScanMaxDepth;
  const entries = parseOptionalFileSystemEntries(record?.entries);
  if (
    !record
    || !read.valid
    || !write.valid
    || (
      depth !== undefined
      && (
        typeof depth !== "number"
        || !Number.isInteger(depth)
        || depth < 0
      )
    )
    || !entries.valid
  ) {
    return { valid: false };
  }
  return {
    valid: true,
    value: {
      read: read.value,
      write: write.value,
      ...(depth !== undefined ? { globScanMaxDepth: depth } : {}),
      ...(entries.value !== undefined ? { entries: entries.value } : {}),
    },
  };
}

function parseOptionalFileSystemEntries(
  value: unknown,
): { valid: true; value?: Array<{ path: FileSystemPath; access: "read" | "write" | "deny" }> }
  | { valid: false } {
  if (value === undefined) {
    return { valid: true };
  }
  if (!Array.isArray(value)) {
    return { valid: false };
  }
  const entries = value.map((entry) => {
    const record = asRecordWithOnly(entry, ["path", "access"]);
    const path = parseFileSystemPath(record?.path);
    const access = record?.access;
    return record
      && path
      && (access === "read" || access === "write" || access === "deny")
      ? { path, access } satisfies FileSystemSandboxEntry
      : undefined;
  });
  return entries.some((entry) => entry === undefined)
    ? { valid: false }
    : {
        valid: true,
        value: entries.filter(
          (entry): entry is NonNullable<typeof entry> => entry !== undefined,
        ),
      };
}

function parseFileSystemPath(value: unknown): FileSystemPath | undefined {
  const record = asRecord(value);
  if (record?.type === "path") {
    const path = nonEmptyString(record.path);
    return path && hasOnlyKeys(record, ["type", "path"])
      ? { type: "path", path }
      : undefined;
  }
  if (record?.type === "glob_pattern") {
    const pattern = nonEmptyString(record.pattern);
    return pattern && hasOnlyKeys(record, ["type", "pattern"])
      ? { type: "glob_pattern", pattern }
      : undefined;
  }
  if (record?.type !== "special" || !hasOnlyKeys(record, ["type", "value"])) {
    return undefined;
  }
  const special = asRecord(record.value);
  if (
    special
    && (
      special.kind === "root"
      || special.kind === "minimal"
      || special.kind === "tmpdir"
      || special.kind === "slash_tmp"
    )
    && hasOnlyKeys(special, ["kind"])
  ) {
    return { type: "special", value: { kind: special.kind } };
  }
  if (
    special?.kind === "project_roots"
    && hasOnlyKeys(special, ["kind", "subpath"])
  ) {
    const subpath = strictNullableString(special.subpath);
    return subpath.valid
      ? { type: "special", value: { kind: "project_roots", subpath: subpath.value } }
      : undefined;
  }
  if (
    special?.kind === "unknown"
    && hasOnlyKeys(special, ["kind", "path", "subpath"])
  ) {
    const path = nonEmptyString(special.path);
    const subpath = strictNullableString(special.subpath);
    return path && subpath.valid
      ? {
          type: "special",
          value: { kind: "unknown", path, subpath: subpath.value },
        }
      : undefined;
  }
  return undefined;
}

function parseOptionalNetworkApprovalContext(
  value: unknown,
): { valid: true; value: NetworkApprovalContext | null } | { valid: false } {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  const record = asRecordWithOnly(value, ["host", "protocol"]);
  const host = nonEmptyString(record?.host);
  return record
    && host
    && (
      record.protocol === "http"
      || record.protocol === "https"
      || record.protocol === "socks5Tcp"
      || record.protocol === "socks5Udp"
    )
    ? { valid: true, value: { host, protocol: record.protocol } }
    : { valid: false };
}

function parseOptionalNetworkAmendments(
  value: unknown,
): { valid: true; value: NetworkPolicyAmendment[] | null } | { valid: false } {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  if (!Array.isArray(value)) {
    return { valid: false };
  }
  const amendments = value.map(parseNetworkAmendment);
  return amendments.some((amendment) => amendment === undefined)
    ? { valid: false }
    : {
        valid: true,
        value: amendments.filter(
          (amendment): amendment is NetworkPolicyAmendment =>
            amendment !== undefined,
        ),
      };
}

function parseNetworkAmendment(value: unknown): NetworkPolicyAmendment | undefined {
  const record = asRecordWithOnly(value, ["host", "action"]);
  const host = nonEmptyString(record?.host);
  return record
    && host
    && (record.action === "allow" || record.action === "deny")
    ? { host, action: record.action }
    : undefined;
}

function parseOptionalStringArray(
  value: unknown,
): { valid: true; value: string[] | null } | { valid: false } {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  const parsed = parseStringArray(value);
  return parsed
    ? { valid: true, value: parsed }
    : { valid: false };
}

function parseStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}

function nullableOptionalStringArray(
  value: unknown,
): { valid: true; value: string[] | null } | { valid: false } {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? { valid: true, value: [...value] }
    : { valid: false };
}

function nullableOptionalString(
  value: unknown,
): { valid: true; value: string | null } | { valid: false } {
  return value === undefined || value === null
    ? { valid: true, value: null }
    : typeof value === "string"
      ? { valid: true, value }
      : { valid: false };
}

function strictNullableString(
  value: unknown,
): { valid: true; value: string | null } | { valid: false } {
  return value === null || typeof value === "string"
    ? { valid: true, value }
    : { valid: false };
}

function nullableOptionalFiniteNumber(
  value: unknown,
): { valid: true; value: number | null } | { valid: false } {
  return value === undefined || value === null
    ? { valid: true, value: null }
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? { valid: true, value }
      : { valid: false };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asRecordWithOnly(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return record && hasOnlyKeys(record, keys) ? record : undefined;
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNonEmptyString(value: unknown): string | null {
  return nonEmptyString(value) ?? null;
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
    && value !== null
    && Object.values(value as Record<string, unknown>).every(isJsonValue);
}
