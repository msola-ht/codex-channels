import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { parse, stringify } from "smol-toml";
import { z } from "zod";

const sourceByDocument = new WeakMap();

const workspaceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(64),
  cwd: z.string().trim().min(1),
});

const gatewayDocumentSchema = z.strictObject({
  version: z.literal(1),
  default_workspace: z.string().trim().min(1),
  telegram: z.strictObject({
    bot_token: z.string().min(1),
    allowed_user_ids: z.array(z.number().int().positive()).min(1),
    proxy_url: z.string().optional(),
    message_format: z.enum(["html", "rich"]).default("html"),
  }),
  network: z.strictObject({
    http_proxy: z.string().optional(),
    https_proxy: z.string().optional(),
    all_proxy: z.string().optional(),
    no_proxy: z.string().optional(),
  }).optional(),
  codex: z.strictObject({
    binary: z.string().min(1).default("codex"),
    socket_path: z.string().min(1).default("runtime/codex-app-server.sock"),
    default_model: z.string().optional(),
    sandbox: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
  }),
  approval: z.strictObject({
    timeout_seconds: z.number().int().min(30).max(3600).default(300),
  }).default({ timeout_seconds: 300 }),
  storage: z.strictObject({
    database_path: z.string().min(1).default("data/gateway.sqlite3"),
  }).default({ database_path: "data/gateway.sqlite3" }),
  logging: z.strictObject({
    level: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  }).default({ level: "info" }),
  workspaces: z.array(workspaceSchema).min(1),
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

export function readGatewayConfig(configPath) {
  return parseGatewayConfig(readFileSync(configPath, "utf8"), configPath);
}

export function writeGatewayConfig(configPath, document) {
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  try {
    const generated = stringify(document);
    const source = sourceByDocument.get(document);
    const content = source === undefined
      ? generated
      : preserveTomlComments(
          source.content,
          generated,
          source.workspaceIds,
          workspaceIds(document),
        );
    writeFileSync(temporaryPath, content, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, configPath);
    chmodSync(configPath, 0o600);
    sourceByDocument.set(document, {
      content,
      workspaceIds: workspaceIds(document),
    });
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
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
