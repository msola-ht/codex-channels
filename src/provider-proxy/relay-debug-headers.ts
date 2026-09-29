import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const visible = new Set([
  "accept", "accept-encoding", "accept-language", "cache-control", "connection",
  "content-type", "content-length", "content-encoding", "date", "host", "origin",
  "referer", "user-agent", "transfer-encoding", "vary",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
]);
const secret = /authorization|cookie|token|secret|credential|signature|api[-_]?key/iu;

/** Pure sanitization for Relay debug capture; never performs I/O. */
export function relayDebugHeaders(input: IncomingHttpHeaders | OutgoingHttpHeaders): {
  headers: Record<string, string | string[]>;
  truncated: boolean;
} {
  const headers: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
  let truncated = false;
  let bytes = 2;
  for (const [rawName, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    const sanitize = (part: string | number): string => {
      if (secret.test(name) || !visible.has(name)) return "[REDACTED]";
      let text = String(part);
      if (name === "origin" || name === "referer") {
        try {
          const url = new URL(text);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "[REDACTED]";
          text = url.origin;
        } catch { return "[REDACTED]"; }
      }
      if (Buffer.byteLength(text) > 1024) { truncated = true; return "[OMITTED: TOO LARGE]"; }
      return text;
    };
    const safe = Array.isArray(value) ? value.map(sanitize) : sanitize(value);
    const size = Buffer.byteLength(JSON.stringify({ [name]: safe }));
    if (bytes + size > 16 * 1024) { truncated = true; break; }
    headers[name] = safe; bytes += size;
  }
  return { headers, truncated };
}
