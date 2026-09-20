import { readFileSync } from "node:fs";
import { join } from "node:path";

import { codexHomePath } from "./codex-home.mjs";
import { GatewayConfigConflictError, withGatewayConfigLock } from "./gateway-config.mjs";
import { writePrivateFileAtomicSync } from "./private-file.mjs";

export const codexProxyFields = ["http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const assignment = /^[\t ]*(?:export[\t ]+)?([A-Za-z_][A-Za-z0-9_]*)[\t ]*=[\t ]*('(?:[^']*)'|"(?:\\[\s\S]|[^"\\])*"|[^\r\n]*)([^\r\n]*)/gm;

export function readCodexProxySnapshot(environment = process.env) {
  const path = join(codexHomePath(environment), ".env");
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    content = null;
  }
  const values = {};
  for (const match of (content ?? "").matchAll(assignment)) {
    const key = match[1];
    if (!codexProxyFields.includes(key.toLowerCase())
      || (key !== key.toLowerCase() && key !== key.toUpperCase())) continue;
    if (match[3].trim() !== "" && !match[3].trimStart().startsWith("#")) {
      throw new Error(`Codex .env 的 ${key} 引号后存在无效内容`);
    }
    values[key] = literalValue(match[2].trim(), key);
  }
  const settings = {};
  for (const field of codexProxyFields) {
    const value = values[field.toUpperCase()] ?? values[field];
    if (value !== undefined) {
      const error = validateCodexProxyValue(field, value);
      if (error) throw new Error(`Codex .env 的 ${field.toUpperCase()} 无效：${error}`);
      settings[field] = value;
    }
  }
  validateProxyCombination(settings);
  return { path, content, settings };
}

export function readCodexProxySettings(environment = process.env) {
  return readCodexProxySnapshot(environment).settings;
}

export function renderCodexProxySettings(snapshot, changes) {
  for (const [field, value] of Object.entries(changes)) {
    if (!codexProxyFields.includes(field)) throw new Error("未知代理字段");
    if (value !== null) {
      const error = validateCodexProxyValue(field, value);
      if (error) throw new Error(error);
    }
  }
  let content = snapshot.content ?? "";
  const settings = { ...snapshot.settings };
  for (const [field, value] of Object.entries(changes)) {
    if (value === null) delete settings[field];
    else settings[field] = value;
  }
  validateProxyCombination(settings);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const remaining = new Set(Object.keys(changes));
  content = content.replace(assignment, (line, key) => {
    const field = key.toLowerCase();
    if (!Object.hasOwn(changes, field)
      || (key !== field && key !== key.toUpperCase())) return line;
    remaining.delete(field);
    return changes[field] === null ? "" : formatAssignment(field, changes[field]);
  });
  for (const field of remaining) {
    if (changes[field] === null) continue;
    if (content !== "" && !content.endsWith("\n")) content += newline;
    content += `${formatAssignment(field, changes[field])}${newline}`;
  }
  return content;
}

export function writeCodexProxySettings(changes, environment = process.env) {
  const snapshot = readCodexProxySnapshot(environment);
  const content = renderCodexProxySettings(snapshot, changes);
  const changed = content !== (snapshot.content ?? "");
  if (changed) writeCodexProxySnapshot(snapshot, content);
  return { configPath: snapshot.path, changed };
}

export function writeCodexProxySnapshot(snapshot, content) {
  return withGatewayConfigLock(snapshot.path, () => {
    let current = null;
    try {
      current = readFileSync(snapshot.path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current !== snapshot.content) {
      throw new GatewayConfigConflictError("Codex .env 在写入期间已发生变化，请重新读取设置");
    }
    writePrivateFileAtomicSync(snapshot.path, content);
  });
}

export function validateCodexProxyValue(field, value) {
  if (typeof value !== "string" || /[\0\r\n]/u.test(value)) return "代理值必须是单行文本";
  if (!codexProxyFields.includes(field)) return "未知代理字段";
  if (field === "no_proxy" || value === "") return undefined;
  if (value.length > 2_048) return "代理 URL 过长";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "代理 URL 无效";
  }
  const protocols = field === "all_proxy"
    ? ["http:", "https:", "socks5:", "socks5h:"] : ["http:", "https:"];
  return protocols.includes(url.protocol) && url.hostname !== ""
    ? undefined : `${field.toUpperCase()} 不支持此代理协议或缺少主机`;
}

function formatAssignment(field, value) {
  return `${field.toUpperCase()}="${value.replace(/[\\$"]/gu, "\\$&")}"`;
}

function validateProxyCombination(settings) {
  if (/^socks5h?:/iu.test(settings.all_proxy ?? "") && !settings.http_proxy) {
    throw new Error("SOCKS ALL_PROXY 必须同时配置 HTTP_PROXY，供共享 HTTP(S) 客户端使用");
  }
}

function literalValue(raw, field) {
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'")) throw new Error(`Codex .env 的 ${field} 引号未闭合`);
    return raw.slice(1, -1);
  }
  let value;
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"')) throw new Error(`Codex .env 的 ${field} 引号未闭合`);
    value = raw.slice(1, -1);
  } else {
    value = raw.split(/\s+#/u)[0].trim();
  }
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "$") throw new Error(`Codex .env 的 ${field} 请填写字面值，美元符号请转义或使用单引号`);
    if (character === "\\") {
      const next = value[++index];
      const escapes = { "\\": "\\", '"': '"', "$": "$", n: "\n", r: "\r", t: "\t", " ": " ", "#": "#" };
      if (!Object.hasOwn(escapes, next)) throw new Error(`Codex .env 的 ${field} 含不支持的转义`);
      result += escapes[next];
    } else result += character;
  }
  return result;
}
