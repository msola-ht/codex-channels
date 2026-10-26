import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { modelRelayConfigSchema } from "./model-relay-config.mjs";
import { validateModelDisplayAliases } from "./model-display-name.mjs";
import { messageDisplayOverridesSchema } from "./message-display-policy.mjs";

import {
  PrivateFileWriteCommittedError,
  securePrivateDirectorySync,
  writePrivateFileAtomicSync,
} from "./private-file.mjs";
import {
  PrivateDirectoryLockBusyError,
  PrivateDirectoryLockReleaseError,
  withPrivateDirectoryLockSync,
} from "./private-directory-lock.mjs";

const sourceByDocument = new WeakMap();

/** Compare validated runtime QQ identities; disabled configurations project to undefined. */
export function classifyQqConfigChanges(current, next) {
  const changes = [];
  if (Boolean(current) !== Boolean(next)) changes.push({ kind: "enabled", restart: true });
  if (current && next) {
    if (current.appId !== next.appId) changes.push({ kind: "account", restart: true });
    if (current.appSecret !== next.appSecret) changes.push({ kind: "credentials", restart: true });
    const before = new Set(current.allowedUserOpenIds);
    const after = new Set(next.allowedUserOpenIds);
    const removed = [...before].some(id => !after.has(id));
    if (removed || [...after].some(id => !before.has(id))) changes.push({ kind: "allowed-users", restart: removed });
  }
  return changes;
}
const activeGatewayConfigLocks = new Set();

export class GatewayConfigConflictError extends Error {
  constructor(message = "config.toml 在写入期间已发生变化") {
    super(message);
    this.name = "GatewayConfigConflictError";
  }
}

/** The synchronous operation returned; this does not establish a file commit. */
export class GatewayConfigLockReleaseError extends Error {
  constructor(result, cause) {
    super("配置锁内操作已完成，但配置锁释放失败；请先检查当前状态，勿重复执行写入", { cause });
    this.name = "GatewayConfigLockReleaseError";
    Object.defineProperty(this, "result", { value: result });
  }
}

/** Only emitted after the destination's atomic replacement is confirmed. */
export class GatewayConfigWriteCommittedError extends Error {
  constructor(cause) {
    super("Gateway 配置已保存，但保存后清理失败；请先检查配置、锁和临时目录状态，勿重复保存，仍需按原要求激活配置", { cause });
    this.name = "GatewayConfigWriteCommittedError";
  }
}

/** Structured validation metadata; never carries rejected input values. */
export class GatewayConfigValidationError extends Error {
  constructor(message, issues) {
    super(message);
    this.name = "GatewayConfigValidationError";
    this.issues = issues.map(({ path, code }) => ({ path: [...path], code }));
  }
}

const workspaceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(64),
  cwd: z.string().trim().min(1),
});

const feishuSchema = z.strictObject({
  enabled: z.boolean(),
  app_id: z.string().regex(/^cli_[0-9a-fA-F]{16}$/u).optional(),
  app_secret: z.string().min(1).refine(
    (value) => value.trim().length > 0,
    "app_secret 不能为空",
  ).optional(),
  allowed_open_ids: z.array(
    z.string().trim().regex(
      /^ou_[^\s,，;；]+$/u,
      "每个 Open ID 须以 ou_ 开头，不能包含空白、逗号或分号",
    ),
  ).min(1).refine(
    (values) => new Set(values).size === values.length,
    "allowed_open_ids 不能包含重复项",
  ).optional(),
}).superRefine((value, context) => {
  if (!value.enabled) {
    return;
  }
  for (const field of ["app_id", "app_secret", "allowed_open_ids"]) {
    if (value[field] === undefined) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `飞书启用时必须配置 ${field}`,
      });
    }
  }
});

const weixinSetupSchema = z.strictObject({
  enabled: z.boolean(),
  account_id: z.string().regex(/^[^\s@]{1,1000}@im\.bot$/u),
  allowed_user_ids: z.array(
    z.string().regex(/^[^\s@]{1,1000}@im\.wechat$/u),
  ).min(1).refine(
    (values) => new Set(values).size === values.length,
    "allowed_user_ids 不能包含重复项",
  ),
});

const qqSchema = z.strictObject({
  enabled: z.boolean(),
  app_id: z.string().regex(/^[0-9]+$/u, "app_id 必须是 QQ 应用的数字标识").optional(),
  app_secret: z.string().min(1).refine(
    (value) => !/\s/u.test(value) && !containsControlCharacter(value),
    "app_secret 不能为空或包含空白及控制字符",
  ).optional(),
  allowed_user_openids: z.array(
    z.string().min(1).refine(
      (value) => !/[\s,，;；]/u.test(value) && !containsControlCharacter(value),
      "每个 QQ 用户 OpenID 不能为空或包含空白、逗号、分号及控制字符",
    ),
  ).refine(
    (values) => new Set(values).size === values.length,
    "allowed_user_openids 不能包含重复项",
  ).optional(),
}).superRefine((value, context) => {
  if (!value.enabled) return;
  for (const field of ["app_id", "app_secret", "allowed_user_openids"]) {
    if (value[field] === undefined) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `QQ 启用时必须配置 ${field}`,
      });
    }
  }
});

const webuiSchema = z.strictObject({
  enabled: z.boolean().optional(),
  host: z.enum(["127.0.0.1", "::1", "0.0.0.0"]).default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8787),
  token: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if (value.host === "0.0.0.0" && value.token === undefined) {
    context.addIssue({
      code: "custom",
      path: ["token"],
      message: "绑定非回环地址时必须设置 token",
    });
  }
});

const clientIdentitySchema = z.strictObject({
  name: z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
    "client_identity.name 必须是 1–64 个 HTTP token 字符，且首字符为字母或数字",
  ).optional(),
  title: z.string().trim().min(1).max(128).refine(
    (value) => !containsControlCharacter(value),
    "client_identity.title 不能包含换行或其他控制字符",
  ).optional(),
  version: z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u,
    "client_identity.version 必须是 1–64 个 ASCII 字符，且首字符为字母或数字",
  ).optional(),
});

const upstreamUserAgentSchema = z.string().min(1).max(512).refine(
  (value) => /^[\x20-\x7e]+$/u.test(value) && value === value.trim(),
  "upstream_user_agent 必须是 1–512 个可显示 ASCII 字符，且不允许首尾空白或其他控制字符",
);

/** `[codex].terminal_identity` 的字面格式：`终端名` 或 `终端名/版本`，总长 1–64。 */
export const terminalIdentityPattern =
  /^(?=.{1,64}$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/u;

const terminalIdentitySchema = z.string().max(
  64,
  "terminal_identity 长度不能超过 64 个字符",
).regex(
  terminalIdentityPattern,
  "terminal_identity 必须是「终端名」或「终端名/版本」，字符限字母、数字、.、_、-，且以字母或数字开头",
);

/** `[codex].timezone` 的字面格式：IANA 时区名称，例如 `Asia/Shanghai`、`Etc/GMT+8`。 */
export const timezonePattern = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;

const timezoneSchema = z.string().max(
  64,
  "timezone 长度不能超过 64 个字符",
).regex(
  timezonePattern,
  "timezone 必须是 IANA 时区名称（如 Asia/Shanghai），字符限字母、数字、_、+、- 与 /，且以字母开头",
);

function containsControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isTelegramEnabled(telegram) {
  return telegram?.enabled !== false && typeof telegram?.bot_token === "string" && telegram.bot_token.trim().length > 0;
}

const telegramSchema = z.strictObject({
  enabled: z.boolean().optional(),
  bot_token: z.string().optional(),
  allowed_user_ids: z.array(z.number().int().positive()).optional(),
  proxy_url: z.string().optional(),
  message_format: z.enum(["html", "rich"]).default("html"),
}).superRefine((value, context) => {
  if (value.enabled === false) return;
  if (!value.bot_token?.trim()) {
    if (value.enabled === true) context.addIssue({
      code: "custom", path: ["bot_token"], message: "Telegram 启用时必须配置 bot_token",
    });
    return;
  }
  if (!value.allowed_user_ids?.length) {
    context.addIssue({
      code: "custom",
      path: ["allowed_user_ids"],
      message: "Telegram 启用时必须配置 allowed_user_ids",
    });
  }
});

export const officialTuiUserAgentPattern = /^codex-tui\/([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._+-]+)?) (\([^();\r\n]+; [A-Za-z0-9_+-]+\) [A-Za-z0-9._/-]+) \(codex-tui; \1\)$/u;

const codexSchema = z.strictObject({
  binary: z.string().min(1).refine(
    (value) => value.trim().length > 0,
    "binary 不能为空",
  ).default("codex"),
  socket_path: z.string().min(1).default("runtime/codex-app-server.sock"),
  default_model: z.string().optional(),
  client_identity: clientIdentitySchema.optional(),
  follow_cli_version: z.boolean().optional(),
  upstream_user_agent: upstreamUserAgentSchema.optional(),
  terminal_identity: terminalIdentitySchema.optional(),
  timezone: timezoneSchema.optional(),
  desktop_app: z.strictObject({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1).max(65_535).default(47_821),
  }).optional(),
}).superRefine((value, context) => {
  if (value.follow_cli_version !== true) return;
  if (value.client_identity?.name !== undefined && value.client_identity.name !== "codex-tui") {
    context.addIssue({ code: "custom", path: ["client_identity", "name"], message: "跟随 CLI 版本时客户端名称必须为 codex-tui；自定义身份请关闭 follow_cli_version" });
  }
  if (value.upstream_user_agent !== undefined && !officialTuiUserAgentPattern.test(value.upstream_user_agent)) {
    context.addIssue({ code: "custom", path: ["upstream_user_agent"], message: "跟随 CLI 版本需要两处版本一致的完整官方 TUI UA；请重新一键设置或关闭 follow_cli_version" });
  }
});

const debugSchema = z.strictObject({
  model_traffic_dump: z.boolean().default(false),
  model_traffic_input_items: z.number().int().min(0).default(3),
  model_traffic_item_max_bytes: z.number().int().min(0).default(65_536),
  model_traffic_retention_days: z.number().int().min(0).max(36_500).default(30),
});

const gatewaySchema = z.strictObject({
  timezone: z.union([
    z.literal("system"),
    timezoneSchema.refine((timeZone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone });
        return true;
      } catch {
        return false;
      }
    }, "网关时区必须是 Node.js 支持的 IANA 名称"),
  ]).optional(),
});

const modelDisplayAliasesSchema = z.unknown().transform((value, context) => {
  try {
    return validateModelDisplayAliases(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error.message });
    return z.NEVER;
  }
});

const gatewayConfigStructureSchema = z.strictObject({
  version: z.literal(1),
  default_workspace: z.string().trim().min(1),
  telegram: telegramSchema.optional(),
  feishu: feishuSchema.optional(),
  weixin: weixinSetupSchema.optional(),
  qq: qqSchema.optional(),
  codex: codexSchema,
  gateway: gatewaySchema.optional(),
  model_relay: modelRelayConfigSchema.optional(),
  approval: z.strictObject({
    timeout_seconds: z.number().int().min(30).max(3600).default(900),
  }).default({ timeout_seconds: 900 }),
  conversation: z.strictObject({
    idle_release_minutes: z.number().int().min(0).max(1440).default(15),
  }).default({ idle_release_minutes: 15 }),
  display: z.strictObject({
    operation_updates: z.enum(["full", "detailed", "compact", "failures", "hidden"]).default("compact"),
    subagents: z.boolean().optional(),
    streaming: z.boolean().optional(),
    commentary: z.boolean().optional(),
    routine_notifications: z.boolean().optional(),
    plan_updates: z.boolean().default(true),
    reasoning: z.boolean().default(false),
    completion: z.enum(["off", "brief", "detailed"]).optional(),
    presentation_detail: z.enum(["basic", "detailed", "full"]).optional(),
    overrides: messageDisplayOverridesSchema.optional(),
    model_aliases: modelDisplayAliasesSchema.optional(),
  }).default({
    operation_updates: "compact",
    plan_updates: true,
    reasoning: false,
  }),
  debug: debugSchema.optional(),
  scheduled_tasks: z.strictObject({
    enabled: z.boolean().default(false),
  }).default({ enabled: false }),
  storage: z.strictObject({
    database_path: z.string().min(1).default("data/gateway.sqlite3"),
  }).default({ database_path: "data/gateway.sqlite3" }),
  logging: z.strictObject({
    level: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  }).default({ level: "info" }),
  webui: webuiSchema.optional(),
  metrics: z.strictObject({
    storage: z.strictObject({
      retention_days: z.number().int().min(1).max(3650).default(365),
      max_rows: z.number().int().min(1_000).max(10_000_000).default(1_000_000),
    }).default({ retention_days: 365, max_rows: 1_000_000 }),
  }).default({
    storage: { retention_days: 365, max_rows: 1_000_000 },
  }),
  workspaces: z.array(workspaceSchema).min(1),
});

const gatewayDocumentSchema = gatewayConfigStructureSchema.superRefine((value, context) => {
  if (
    !isTelegramEnabled(value.telegram)
    && value.feishu?.enabled !== true
    && value.weixin?.enabled !== true
    && value.qq?.enabled !== true
  ) {
    context.addIssue({
      code: "custom",
      path: ["telegram", "bot_token"],
      message: "至少需要配置一个通讯渠道：Telegram、飞书、微信或 QQ",
    });
  }

});

export function parseGatewayConfig(content, source = "config.toml") {
  try {
    const document = parse(content);
    sourceByDocument.set(document, {
      content,
      workspaceIds: workspaceIds(document),
    });
    return document;
  } catch (error) {
    // TomlError 会包含原始配置行，不能通过 cause 暴露 Token 等敏感内容。
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `${source} 语法无效：${tomlErrorSummary(error)}`,
    );
  }
}

export function tomlErrorSummary(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n/, 1)[0] || "未知解析错误";
}

export function validateGatewayConfigDocument(document) {
  const parsed = gatewayDocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

/** Read-only settings do not require Gateway's channel startup prerequisite. */
export function validateGatewayConfigStructureDocument(document) {
  const parsed = gatewayConfigStructureSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

export function validateCodexConfigDocument(document) {
  const parsed = codexSchema.safeParse(document);
  if (!parsed.success) {
    throw new GatewayConfigValidationError(`config.toml 的 [codex] 配置无效：\n${z.prettifyError(parsed.error)}`, parsed.error.issues);
  }
  return parsed.data;
}

export function validateGatewayProcessConfigDocument(document) {
  const parsed = gatewaySchema.safeParse(document);
  if (!parsed.success) {
    throw new GatewayConfigValidationError(`config.toml 的 [gateway] 配置无效：\n${z.prettifyError(parsed.error)}`, parsed.error.issues);
  }
  return parsed.data;
}

export function validateWebuiConfigDocument(document) {
  const parsed = webuiSchema.safeParse(
    document !== null && typeof document === "object"
      ? document.webui ?? {}
      : {},
  );
  if (!parsed.success) {
    throw new Error(`config.toml 的 [webui] 配置无效：\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * WebUI 服务开关：true / false 为显式设置；
 * undefined 表示未设置，服务生命周期沿用既有安装状态。
 */
export function webuiServiceEnabled(document) {
  const webui = document !== null && typeof document === "object" ? document.webui : undefined;
  if (webui === null || typeof webui !== "object" || Array.isArray(webui)) return undefined;
  return typeof webui.enabled === "boolean" ? webui.enabled : undefined;
}

export function validateDebugConfigDocument(document) {
  const parsed = debugSchema.safeParse(
    document !== null && typeof document === "object" ? document : {},
  );
  if (!parsed.success) {
    throw new Error(`config.toml 的 [debug] 配置无效：\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function readGatewayConfig(configPath) {
  return parseGatewayConfig(readFileSync(configPath, "utf8"), configPath);
}

export function materializeGatewayConfigDefaults(configPath, document) {
  const defaults = validateGatewayConfigDocument(document);
  if (!mergeMissingDefaults(document, defaults)) {
    return false;
  }
  const source = sourceByDocument.get(document);
  if (
    source === undefined
    || readFileSync(configPath, "utf8") !== source.content
  ) {
    throw new Error("config.toml 在自动补齐期间已发生变化");
  }
  writeGatewayConfig(configPath, document);
  return true;
}

export function writeGatewayConfig(configPath, document, { maximumBytes } = {}) {
  if (process.platform === "win32" && !existsSync(configPath)) {
    const parent = dirname(resolve(configPath));
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      securePrivateDirectorySync(parent);
    }
  }
  try {
    return withGatewayConfigLock(configPath, () => {
      const generated = stringify(document);
      const source = sourceByDocument.get(document);
      if (source !== undefined && currentGatewayConfig(configPath) !== source.content) {
        throw new GatewayConfigConflictError();
      }
      const content = source === undefined
        ? generated
        : preserveTomlComments(
            source.content,
            generated,
            source.workspaceIds,
            workspaceIds(document),
          );
      if (maximumBytes !== undefined && Buffer.byteLength(content, "utf8") > maximumBytes) throw new Error("配置文件超过容量上限，未保存");
      let cleanupError;
      try {
        writePrivateFileAtomicSync(configPath, content);
      } catch (error) {
        if (!(error instanceof PrivateFileWriteCommittedError)) throw error;
        cleanupError = error;
      }
      sourceByDocument.set(document, {
        content,
        workspaceIds: workspaceIds(document),
      });
      if (cleanupError !== undefined) throw new GatewayConfigWriteCommittedError(cleanupError);
    });
  } catch (error) {
    if (error instanceof GatewayConfigLockReleaseError) {
      throw new GatewayConfigWriteCommittedError(error);
    }
    throw error;
  }
}

function currentGatewayConfig(configPath) {
  try {
    return readFileSync(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new GatewayConfigConflictError();
    }
    throw error;
  }
}

export function withGatewayConfigLock(configPath, operation) {
  const normalizedPath = resolve(configPath);
  if (activeGatewayConfigLocks.has(normalizedPath)) return synchronousGatewayConfigOperation(operation);
  mkdirSync(dirname(normalizedPath), { recursive: true, mode: 0o700 });
  try {
    return withPrivateDirectoryLockSync(`${normalizedPath}.lock`, () => {
      activeGatewayConfigLocks.add(normalizedPath);
      try {
        return synchronousGatewayConfigOperation(operation);
      } finally {
        activeGatewayConfigLocks.delete(normalizedPath);
      }
    });
  } catch (error) {
    if (error instanceof PrivateDirectoryLockReleaseError) {
      throw new GatewayConfigLockReleaseError(error.result, error);
    }
    if (error instanceof PrivateDirectoryLockBusyError) {
      throw new GatewayConfigConflictError("配置正被其他进程修改，或锁所有者无法确认；请稍后重试并核对锁状态");
    }
    throw error;
  }
}

function synchronousGatewayConfigOperation(operation) {
  const result = operation();
  if (result && typeof result.then === "function") {
    Promise.resolve(result).catch(() => undefined);
    throw new TypeError("withGatewayConfigLock 只接受同步操作");
  }
  return result;
}

function mergeMissingDefaults(target, defaults) {
  let changed = false;
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.hasOwn(target, key)) {
      target[key] = value;
      changed = true;
      continue;
    }
    if (isTomlTable(target[key]) && isTomlTable(value)) {
      changed = mergeMissingDefaults(target[key], value) || changed;
    }
  }
  return changed;
}

function isTomlTable(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && !(value instanceof Date);
}

function preserveTomlComments(source, generated, sourceWorkspaceIds, generatedWorkspaceIds) {
  const comments = collectTomlComments(source, sourceWorkspaceIds);
  if (comments.length === 0) {
    return generated;
  }

  const pending = new Map();
  for (const comment of comments) {
    const entries = pending.get(comment.anchor) ?? [];
    entries.push(comment);
    pending.set(comment.anchor, entries);
  }

  const output = [];
  for (const statement of scanTomlStatements(generated, generatedWorkspaceIds)) {
    const anchored = pending.get(statement.anchor) ?? [];
    for (const comment of anchored) {
      if (comment.kind === "before") {
        output.push(comment.text);
      }
    }
    const inline = anchored.find((comment) => comment.kind === "inline");
    output.push(inline ? `${statement.line} ${inline.text}` : statement.line);
    pending.delete(statement.anchor);
  }

  const trailing = [...pending.values()].flat();
  if (trailing.length > 0) {
    if (output.at(-1) !== "") {
      output.push("");
    }
    output.push(...trailing.map((comment) => comment.text));
  }
  return `${output.join("\n").replace(/\n*$/, "")}\n`;
}

function collectTomlComments(source, workspaceIds) {
  const comments = [];
  const pending = [];
  for (const statement of scanTomlStatements(source, workspaceIds, true)) {
    if (statement.comment && statement.code.trim()) {
      comments.push({
        anchor: statement.anchor,
        kind: "inline",
        text: statement.comment,
      });
    }
    if (statement.comment && !statement.code.trim()) {
      pending.push(statement.comment);
      continue;
    }
    if (!statement.code.trim()) {
      continue;
    }
    comments.push(...pending.map((text) => ({
      anchor: statement.anchor,
      kind: "before",
      text,
    })));
    pending.length = 0;
  }
  comments.push(...pending.map((text) => ({
    anchor: "\0end",
    kind: "before",
    text,
  })));
  return comments;
}

function scanTomlStatements(content, workspaceIds, includeComments = false) {
  const statements = [];
  const arrayIndexes = new Map();
  let table = "$";
  let stringState;
  let fallback = 0;
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const split = splitTomlComment(line, stringState);
    stringState = split.stringState;
    const trimmed = split.code.trim();
    let anchor;
    const arrayTable = trimmed.match(/^\[\[([A-Za-z0-9_.-]+)\]\]$/);
    const regularTable = trimmed.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    const key = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (arrayTable) {
      const path = arrayTable[1];
      const index = arrayIndexes.get(path) ?? 0;
      arrayIndexes.set(path, index + 1);
      const identity = path === "workspaces"
        ? workspaceIds[index]
        : undefined;
      table = `${path}#${identity ?? index}`;
      anchor = `@${table}`;
    } else if (regularTable) {
      table = regularTable[1];
      anchor = `@${table}`;
    } else if (key) {
      anchor = `${table}.${key[1]}`;
    } else {
      anchor = `${table}.\0${fallback}`;
      fallback += 1;
    }
    statements.push({
      anchor,
      line,
      code: split.code,
      ...(includeComments && split.comment ? { comment: split.comment } : {}),
    });
  }
  return statements;
}

function workspaceIds(document) {
  return Array.isArray(document.workspaces)
    ? document.workspaces.map((workspace) => (
        workspace && typeof workspace === "object" && !Array.isArray(workspace)
          ? String(workspace.id ?? "")
          : ""
      ))
    : [];
}

function splitTomlComment(line, initialState) {
  let stringState = initialState;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const rest = line.slice(index);
    const character = line[index];
    if (stringState === "multiline-basic") {
      if (!escaped && rest.startsWith('"""')) {
        stringState = undefined;
        index += 2;
      }
      escaped = !escaped && character === "\\";
      if (character !== "\\") {
        escaped = false;
      }
      continue;
    }
    if (stringState === "multiline-literal") {
      if (rest.startsWith("'''")) {
        stringState = undefined;
        index += 2;
      }
      continue;
    }
    if (stringState === "basic") {
      if (!escaped && character === '"') {
        stringState = undefined;
      }
      escaped = !escaped && character === "\\";
      if (character !== "\\") {
        escaped = false;
      }
      continue;
    }
    if (stringState === "literal") {
      if (character === "'") {
        stringState = undefined;
      }
      continue;
    }
    if (rest.startsWith('"""')) {
      stringState = "multiline-basic";
      index += 2;
    } else if (rest.startsWith("'''")) {
      stringState = "multiline-literal";
      index += 2;
    } else if (character === '"') {
      stringState = "basic";
    } else if (character === "'") {
      stringState = "literal";
    } else if (character === "#") {
      return {
        code: line.slice(0, index).trimEnd(),
        comment: line.slice(index),
        stringState,
      };
    }
  }
  if (stringState === "basic" || stringState === "literal") {
    stringState = undefined;
  }
  return { code: line, stringState };
}
