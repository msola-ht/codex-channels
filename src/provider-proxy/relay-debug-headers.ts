import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const visible = new Set([
  "accept", "accept-encoding", "accept-language", "cache-control", "connection",
  "content-type", "content-length", "content-encoding", "date", "host", "origin",
  "referer", "user-agent", "transfer-encoding", "vary",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
]);
// Only named diagnostic fields with bounded, recognizable formats are recorded.
const diagnostic = new Map<string, RegExp>([
  ...["x-request-id", "x-relay-request-id", "x-trace-id", "x-root-request-id"].map(name =>
    [name, /^(?:[a-f0-9]{16,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu] as const),
  ["traceparent", /^[a-f0-9]{2}-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/iu],
  ["b3", /^[a-f0-9]{16}(?:[a-f0-9]{16})?-[a-f0-9]{16}(?:-[01d](?:-[a-f0-9]{16})?)?$/iu],
  ...["x-b3-traceid", "x-b3-spanid", "x-b3-parentspanid"].map(name => [name, /^(?:[a-f0-9]{16}|[a-f0-9]{32})$/iu] as const),
  ["x-b3-sampled", /^[01]$/u],
  ...["x-stainless-lang", "x-stainless-package-version", "x-stainless-os", "x-stainless-arch",
    "x-stainless-runtime", "x-stainless-runtime-version", "x-ide-name", "x-ide-type", "x-ide-version", "x-product"]
    .map(name => [name, /^[a-z0-9][a-z0-9 ._+()/-]{0,95}$/iu] as const),
  ["x-stainless-retry-count", /^\d{1,4}$/u],
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
      let text = String(part);
      if (secret.test(name) || !visible.has(name) && !diagnostic.get(name)?.test(text)) return "[REDACTED]";
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
