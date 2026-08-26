import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { parse, stringify } from "smol-toml";
import { z } from "zod";

import { writePrivateFileAtomicSync } from "./private-file.mjs";

const sourceByDocument = new WeakMap();
const gatewayConfigLockTimeoutMs = 2_000;
const staleGatewayConfigLockMs = 30_000;

export class GatewayConfigConflictError extends Error {
  constructor(message = "config.toml 在写入期间已发生变化") {
    super(message);
    this.name = "GatewayConfigConflictError";
  }
}

const workspaceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(64),
  cwd: z.string().trim().min(1),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  approval_policy: z.enum(["untrusted", "on-request", "never"]).optional(),
  permissions: z.string().trim().min(1).max(128).optional(),
}).superRefine((workspace, context) => {
  if (workspace.sandbox !== undefined && workspace.permissions !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["permissions"],
      message: "workspace 的 permissions 与 sandbox 不能同时设置",
    });
  }
});

const feishuSchema = z.strictObject({
  enabled: z.boolean(),
  app_id: z.string().regex(/^cli_[0-9a-fA-F]{16}$/u).optional(),
  app_secret: z.string().min(1).refine(
    (value) => value.trim().length > 0,
    "app_secret 不能为空",
  ).optional(),
  allowed_open_ids: z.array(
    z.string().trim().regex(/^ou_.+$/u),
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

const apiProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);

const apiProviderSchema = z.strictObject({
  id: apiProviderIdSchema,
  name: z.string().trim().min(1).max(64),
  protocol: z.literal("responses"),
  endpoint: z.url(),
});

const priceCurrencySchema = z.enum(["cny", "usd"]).default("cny");

const threadSectionPrincipalSchema = z.string().regex(
  /^(?:telegram|feishu|weixin):\S+$/u,
  "Thread 分区管理员必须使用 <渠道>:<用户 ID>",
);

const threadSectionsSchema = z.strictObject({
  administrators: z.array(threadSectionPrincipalSchema).refine(
    (values) => new Set(values).size === values.length,
    "thread_sections.administrators 不能包含重复项",
  ).default([]),
}).default({ administrators: [] });

const webuiSchema = z.strictObject({
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

const metricsSyncSchema = z.strictObject({
  enabled: z.boolean().default(false),
  endpoint: z.url().optional(),
  device_token: z.string().min(1).optional(),
  device_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u).optional(),
  batch_size: z.number().int().min(1).max(500).default(200),
  interval_seconds: z.number().int().min(10).max(86400).default(60),
}).superRefine((value, context) => {
  if (!value.enabled) {
    return;
  }
  for (const field of ["endpoint", "device_token"]) {
    if (value[field] === undefined) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `metrics.sync 启用时必须配置 ${field}`,
      });
    }
  }
  if (value.endpoint !== undefined) {
    let url;
    try {
      url = new URL(value.endpoint);
    } catch {
      return;
    }
    if (url.protocol !== "https:" && !isPrivateHttpEndpoint(url)) {
      context.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: "metrics.sync.endpoint 必须使用 HTTPS，或回环/私网 HTTP",
      });
    }
  }
});

const metricsCenterSchema = z.strictObject({
  enabled: z.boolean().default(false),
  host: z.enum(["127.0.0.1", "::1", "0.0.0.0"]).default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8790),
  token: z.string().min(1).optional(),
  device_token: z.string().min(1).optional(),
  database_path: z.string().min(1).default("data/central-metrics.sqlite3"),
}).superRefine((value, context) => {
  if (value.host === "0.0.0.0") {
    for (const field of ["token", "device_token"]) {
      if (value[field] === undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `metrics.center 绑定非回环地址时必须设置 ${field}`,
        });
      }
    }
  }
  if (
    value.token !== undefined
    && value.device_token !== undefined
    && value.token === value.device_token
  ) {
    context.addIssue({
      code: "custom",
      path: ["device_token"],
      message: "metrics.center 的 device_token 与 token 必须不同",
    });
  }
});

const metricsViewSchema = z.strictObject({
  enabled: z.boolean().default(false),
  endpoint: z.url().optional(),
  token: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if (!value.enabled) {
    return;
  }
  for (const field of ["endpoint", "token"]) {
    if (value[field] === undefined) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `metrics.view 启用时必须配置 ${field}`,
      });
    }
  }
  if (value.endpoint !== undefined) {
    let url;
    try {
      url = new URL(value.endpoint);
    } catch {
      return;
    }
    if (url.protocol !== "https:" && !isPrivateHttpEndpoint(url)) {
      context.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: "metrics.view.endpoint 必须使用 HTTPS，或回环/私网 HTTP",
      });
    }
  }
});

const telegramSchema = z.strictObject({
  bot_token: z.string().optional(),
  allowed_user_ids: z.array(z.number().int().positive()).optional(),
  proxy_url: z.string().optional(),
  message_format: z.enum(["html", "rich"]).default("html"),
}).superRefine((value, context) => {
  if (!value.bot_token?.trim()) {
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

const codexSchema = z.strictObject({
  binary: z.string().min(1).default("codex"),
  socket_path: z.string().min(1).default("runtime/codex-app-server.sock"),
  default_model: z.string().optional(),
  sandbox: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
});

const gatewayDocumentSchema = z.strictObject({
  version: z.literal(1),
  default_workspace: z.string().trim().min(1),
  telegram: telegramSchema.optional(),
  feishu: feishuSchema.optional(),
  weixin: weixinSetupSchema.optional(),
  network: z.strictObject({
    http_proxy: z.string().optional(),
    https_proxy: z.string().optional(),
    all_proxy: z.string().optional(),
    no_proxy: z.string().optional(),
  }).optional(),
  codex: codexSchema,
  approval: z.strictObject({
    timeout_seconds: z.number().int().min(30).max(3600).default(300),
  }).default({ timeout_seconds: 300 }),
  display: z.strictObject({
    operation_updates: z.enum(["full", "compact", "hidden"]).default("compact"),
    plan_updates: z.boolean().default(true),
    reasoning: z.boolean().default(true),
    price_currency: priceCurrencySchema,
  }).default({
    operation_updates: "compact",
    plan_updates: true,
    reasoning: true,
    price_currency: "cny",
  }),
  experimental: z.strictObject({
    plugin_api: z.boolean().default(false),
  }).default({ plugin_api: false }),
  scheduled_tasks: z.strictObject({
    enabled: z.boolean().default(false),
  }).default({ enabled: false }),
  thread_sections: threadSectionsSchema,
  api_providers: z.array(apiProviderSchema).refine(
    (providers) => new Set(providers.map((provider) => provider.id)).size === providers.length,
    "api_providers 不能包含重复 ID",
  ).default([]),
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
    sync: metricsSyncSchema.default({
      enabled: false,
      batch_size: 200,
      interval_seconds: 60,
    }),
    center: metricsCenterSchema.optional(),
    view: metricsViewSchema.optional(),
  }).default({
    storage: { retention_days: 365, max_rows: 1_000_000 },
    sync: {
      enabled: false,
      batch_size: 200,
      interval_seconds: 60,
    },
  }),
  workspaces: z.array(workspaceSchema).min(1),
}).superRefine((value, context) => {
  if (
    !value.telegram?.bot_token?.trim()
    && value.feishu?.enabled !== true
    && value.weixin?.enabled !== true
  ) {
    context.addIssue({
      code: "custom",
      path: ["telegram", "bot_token"],
      message: "至少需要配置一个通讯渠道：Telegram、飞书或微信",
    });
  }

  const allowedThreadSectionAdministrators = new Set([
    ...(value.telegram?.bot_token?.trim()
      ? (value.telegram.allowed_user_ids ?? []).map((actorId) => `telegram:${actorId}`)
      : []),
    ...(value.feishu?.enabled === true
      ? (value.feishu.allowed_open_ids ?? []).map((actorId) => `feishu:${actorId}`)
      : []),
    ...(value.weixin?.enabled === true
      ? value.weixin.allowed_user_ids.map((actorId) => `weixin:${actorId}`)
      : []),
  ]);
  for (const [index, principal] of value.thread_sections.administrators.entries()) {
    if (!allowedThreadSectionAdministrators.has(principal)) {
      context.addIssue({
        code: "custom",
        path: ["thread_sections", "administrators", index],
        message: "Thread 分区管理员必须属于对应已启用渠道的允许名单",
      });
    }
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

export function validateCodexConfigDocument(document) {
  const parsed = codexSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`config.toml 的 [codex] 配置无效：\n${z.prettifyError(parsed.error)}`);
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

export function validateMetricsCenterConfigDocument(document) {
  const parsed = metricsCenterSchema.safeParse(
    document !== null && typeof document === "object"
      ? document.metrics?.center ?? {}
      : {},
  );
  if (!parsed.success) {
    throw new Error(
      `config.toml 的 [metrics.center] 配置无效：\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function validateMetricsViewConfigDocument(document) {
  const parsed = metricsViewSchema.safeParse(
    document !== null && typeof document === "object"
      ? document.metrics?.view ?? {}
      : {},
  );
  if (!parsed.success) {
    throw new Error(
      `config.toml 的 [metrics.view] 配置无效：\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function isPrivateHttpEndpoint(url) {
  if (url.protocol !== "http:") return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost") return true;
  const address = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (address === "::1" || address.startsWith("127.")) return true;
  if (address.startsWith("10.") || address.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./u.test(address)) return true;
  return false;
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

export function writeGatewayConfig(configPath, document) {
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
    writePrivateFileAtomicSync(configPath, content);
    sourceByDocument.set(document, {
      content,
      workspaceIds: workspaceIds(document),
    });
  });
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

function withGatewayConfigLock(configPath, operation) {
  const normalizedPath = resolve(configPath);
  mkdirSync(dirname(normalizedPath), { recursive: true, mode: 0o700 });
  const lockPath = `${normalizedPath}.lock`;
  const descriptor = acquireGatewayConfigLock(lockPath);
  let result;
  let operationFailed = false;
  let operationError;
  try {
    result = operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let releaseError;
  try {
    closeSync(descriptor);
  } catch (error) {
    releaseError = error;
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT" && releaseError === undefined) releaseError = error;
  }
  if (operationFailed) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return result;
}

function acquireGatewayConfigLock(lockPath) {
  const startedAt = Date.now();
  while (true) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (staleGatewayConfigLock(lockPath)) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        }
      }
      if (Date.now() - startedAt >= gatewayConfigLockTimeoutMs) {
        throw new GatewayConfigConflictError("config.toml 正在由其他进程修改，请稍后重试");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function staleGatewayConfigLock(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleGatewayConfigLockMs;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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
