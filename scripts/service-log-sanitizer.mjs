// Shared safety projection for service diagnostics; callers own selection and budgets.
const sensitiveKey = /(?:tokens?|secrets?|password|passwd|apikey|credentials?|authorization|cookies?)$/iu;
const sensitiveHeader = /(?<![\w?&-])((?:\\?["'])?(?:authorization|proxy-authorization|cookie|set-cookie)(?:\\?["'])?\s*[:=]\s*)[^\r\n]*/giu;
const sensitiveField = /(?<![\w?&-])((?:\\?["'])?[\w-]*(?:tokens?|secrets?|password|passwd|api[-_ ]?key|credentials?)(?:\\?["'])?\s*[:=]\s*)(?:[[{][^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/giu;
const queryParameter = /([?&])([^?=&\s"']+)=/gu;
const queryValue = /^(?:[[{][^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|["'][^\r\n]*|[^&\s"']*)/u;

function isSensitiveKey(key) {
  return sensitiveKey.test(stripTerminalEscapes(key).replace(/[-_ ]/gu, ""));
}

function isSensitiveQueryKey(key) {
  try {
    return isSensitiveKey(decodeURIComponent(key));
  } catch {
    // Unreadable query keys cannot establish that the value is safe.
    return true;
  }
}

function sensitiveQueryValues(value) {
  const ranges = [];
  let end = 0;
  for (const match of value.matchAll(queryParameter)) {
    // Safe keys must not consume a value containing subsequent sensitive keys.
    if (match.index < end || !isSensitiveQueryKey(match[2])) continue;
    const start = match.index + match[0].length;
    end = start + queryValue.exec(value.slice(start))[0].length;
    ranges.push({ start, end });
  }
  return ranges;
}

function sanitizeQueryValues(value) {
  const parts = [];
  let offset = 0;
  for (const { start, end } of sensitiveQueryValues(value)) {
    parts.push(value.slice(offset, start), "[REDACTED]");
    offset = end;
  }
  parts.push(value.slice(offset));
  return parts.join("");
}

function stripTerminalEscapes(value) {
  return value
    // eslint-disable-next-line no-control-regex -- Strip terminal escape sequences before parsing or matching secrets.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    // eslint-disable-next-line no-control-regex -- Strip terminal title/hyperlink sequences, including an incomplete tail.
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/gu, "")
    // eslint-disable-next-line no-control-regex -- Remove controls before matching so they cannot split a sensitive key.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "");
}

// Plain or incomplete records fail conservatively: headers consume the full line,
// including Cookie entries following a quoted first value.
export function sanitizePlainLogText(value) {
  return sanitizeQueryValues(stripTerminalEscapes(value))
    .replace(sensitiveHeader, "$1[REDACTED]")
    .replace(sensitiveField, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/giu, "$1 [REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}/gu, "[REDACTED]");
}

function sanitizeStructuredLog(value, depth = 0) {
  if (depth > 32) return "[REDACTED]";
  if (typeof value === "string") return sanitizePlainLogText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeStructuredLog(entry, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      isSensitiveKey(key) ? "[REDACTED]" : sanitizeStructuredLog(entry, depth + 1),
    ]));
  }
  return value;
}

export function sanitizeLogText(value) {
  return stripTerminalEscapes(value).split(/\r?\n/u).map((line) => {
    // journald can prefix a JSON record with a timestamp and process name.
    const start = line.indexOf("{");
    // A JSON-shaped header/secret value is still sensitive, not a new record.
    const insideSensitiveValue = start >= 0 && ([sensitiveHeader, sensitiveField].some((pattern) => {
      for (const match of line.matchAll(pattern)) {
        if (match.index < start && match.index + match[0].length > start) return true;
      }
      return false;
    }) || sensitiveQueryValues(line).some((range) => range.start <= start && range.end > start));
    if (start >= 0 && !insideSensitiveValue) {
      try {
        return sanitizePlainLogText(line.slice(0, start)) + JSON.stringify(sanitizeStructuredLog(JSON.parse(line.slice(start))));
      } catch {
        // Plain text and incomplete JSON are conservatively redacted below.
      }
    }
    return sanitizePlainLogText(line);
  }).join("\n");
}
