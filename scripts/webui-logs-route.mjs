import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { serviceDefinitions } from "../runtime/service-targets.mjs";
import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { userDataDir } from "./runtime-config.mjs";
import { ApiError, sendJson } from "./webui-http.mjs";

const maximumBytes = 256 * 1024;
const targets = new Map(serviceDefinitions.map((definition) => [
  definition.target === "model-relay" ? "relay" : definition.target, definition,
]));

export function parseLogQuery(params) {
  for (const key of params.keys()) {
    if (!["target", "lines"].includes(key) || params.getAll(key).length !== 1) {
      throw new ApiError(400, "invalid_parameter", "日志查询参数无效");
    }
  }
  const target = params.get("target") ?? "gateway";
  const value = params.get("lines") ?? "100";
  if (!targets.has(target) || !/^[1-9]\d{0,3}$/u.test(value) || Number(value) > 1000) {
    throw new ApiError(400, "invalid_parameter", "日志查询参数无效");
  }
  return { target, lines: Number(value) };
}

// Redact before returning any text, including structured and plain service output.
function sanitizePlainText(value) {
  return value
    // eslint-disable-next-line no-control-regex -- Strip terminal escape sequences from service output.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/(["']?(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/giu, "$1[REDACTED]")
    .replace(/(?<![\w?&-])(["']?[\w-]*(?:tokens?|secrets?|password|passwd|api[_-]?key|credentials?)["']?\s*[:=]\s*)(?:[[{][^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/giu, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/giu, "$1 [REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(/([?&][\w-]*(?:token|secret|password|api[_-]?key)=)[^&\s"']*/giu, "$1[REDACTED]")
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}/gu, "[REDACTED]")
    // eslint-disable-next-line no-control-regex -- Preserve only printable output, tabs and newlines.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "");
}

function sanitizeStructuredLog(value, depth = 0) {
  if (depth > 32) return "[REDACTED]";
  if (typeof value === "string") return sanitizePlainText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeStructuredLog(entry, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      /(?:tokens?|secrets?|password|passwd|apikey|credentials?|authorization|cookies?)$/iu.test(key.replace(/[-_ ]/gu, ""))
        ? "[REDACTED]" : sanitizeStructuredLog(entry, depth + 1),
    ]));
  }
  return value;
}

export function sanitizeLogText(value) {
  return value.split(/\r?\n/u).map((line) => {
    // journald can prefix a JSON record with a timestamp and process name.
    const start = line.indexOf("{");
    if (start >= 0) {
      try {
        return sanitizePlainText(line.slice(0, start)) + JSON.stringify(sanitizeStructuredLog(JSON.parse(line.slice(start))));
      } catch {
        // Plain text and incomplete JSON are conservatively redacted below.
      }
    }
    return sanitizePlainText(line);
  }).join("\n");
}

function logLines(text, limit, truncated = false) {
  const rows = sanitizeLogText(text).split(/\r?\n/u).filter((line) => line.trim() && line !== "-- No entries --");
  return { lines: rows.slice(-limit), truncated: truncated || rows.length > limit };
}

function journalLines(text, limit) {
  const rows = text.split(/\r?\n/u).filter(line => line.trim()).map(line => {
    const entry = JSON.parse(line);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid journal entry");
    let message = entry.MESSAGE;
    // Journal JSON encodes binary values as byte arrays and repeated fields as arrays.
    if (Array.isArray(message) && message.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
      message = Buffer.from(message).toString("utf8");
    } else if (Array.isArray(message) && message.every(value => typeof value === "string")) {
      message = message.join("\n");
    }
    if (typeof message !== "string") throw new Error("Journal message unavailable");
    // Never forward the full journal object (e.g. process command lines or environment).
    const safe = { MESSAGE: sanitizeLogText(message) };
    for (const key of ["__REALTIME_TIMESTAMP", "PRIORITY"]) {
      const value = entry[key];
      if (typeof value === "string" && (key === "PRIORITY" ? /^[0-7]$/u : /^\d{1,16}$/u).test(value)) safe[key] = value;
    }
    for (const key of ["SYSLOG_IDENTIFIER", "_COMM"]) {
      if (typeof entry[key] === "string") safe[key] = sanitizePlainText(entry[key]).slice(0, 256);
    }
    return JSON.stringify(safe);
  });
  return { lines: rows.slice(-limit), truncated: rows.length > limit };
}

async function readLogFile(path, limit) {
  let file;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Unsafe log file");
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stats = await file.stat();
    if (!stats.isFile() || stats.ino !== before.ino || stats.dev !== before.dev) throw new Error("Log file changed");
    const start = Math.max(0, stats.size - maximumBytes);
    const buffer = Buffer.alloc(Math.min(stats.size, maximumBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8", 0, bytesRead);
    if (start > 0) text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
    return { ...logLines(text, limit, start > 0), missing: false };
  } catch (error) {
    if (error.code === "ENOENT") return { lines: [], truncated: false, missing: true };
    throw error;
  } finally {
    await file?.close();
  }
}

export async function readServiceLogs(query, {
  environment = process.env,
  platform = process.platform,
  run = promisify(execFile),
  signal,
} = {}) {
  const definition = targets.get(query.target);
  if (!definition || !Number.isInteger(query.lines) || query.lines < 1 || query.lines > 1000) {
    throw new ApiError(400, "invalid_parameter", "日志查询参数无效");
  }
  try {
    let streams;
    if (platform === "linux") {
      const { stdout } = await run(environment.JOURNALCTL_BINARY?.trim() || "journalctl", [
        `--user-unit=${definition.systemd}`, `--lines=${query.lines + 1}`,
        "--no-pager", "--quiet", "--output=json", "--all",
        "--output-fields=MESSAGE,PRIORITY,SYSLOG_IDENTIFIER,_COMM",
      ], { env: environment, encoding: "utf8", timeout: 5000, maxBuffer: maximumBytes, signal });
      streams = [{ source: "journal", ...journalLines(stdout, query.lines), missing: false }];
    } else if (platform === "darwin" || platform === "win32") {
      const configPath = resolve(environment.CODEX_CONNECT_CONFIG_FILE?.trim() || join(userDataDir(environment), "config.toml"));
      const directory = dirname(resolvePrimaryAppServerSocketPath(readGatewayConfig(configPath), dirname(configPath)));
      const directoryStats = await lstat(directory).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (directoryStats && (!directoryStats.isDirectory() || directoryStats.isSymbolicLink())) throw new Error("Unsafe log directory");
      const base = definition.target === "app-server" ? "codex-app-server" : definition.target;
      streams = await Promise.all(["stdout", "stderr"].map(async (source) => ({
        source, ...await readLogFile(join(directory, `${base}${source === "stderr" ? ".error" : ""}.log`), query.lines),
      })));
    } else {
      throw new Error("Unsupported platform");
    }
    return { target: query.target, observedAt: new Date().toISOString(), streams };
  } catch {
    throw new ApiError(503, "logs_unavailable", "服务日志暂不可读取");
  }
}

export async function routeLogsApi({ environment, url, response }) {
  const query = parseLogQuery(url.searchParams);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  response.once("close", cancel);
  try {
    const snapshot = await readServiceLogs(query, { environment, signal: controller.signal });
    if (!response.destroyed) sendJson(response, 200, snapshot);
  } finally {
    response.off("close", cancel);
  }
}
