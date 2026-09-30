import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const sensitiveName = /authorization|authentication|cookie|token|secret|credential|signature|nonce|password|passwd|api[-_]?key|(?:^|[-_])(?:auth|sig)(?:$|[-_])/iu;

/** Captured headers preserve diagnostic evidence; only recognizable credentials are removed. */
export function redactTrafficHeaderValue(name: string, value: string): string {
  if (sensitiveName.test(name) || /^\s*(?:Bearer|Basic|Digest)\s+/iu.test(value)) return "[REDACTED]";
  const text = name.toLowerCase().startsWith("content-security-policy")
    ? value.replace(/'nonce-[^']*'/giu, "'nonce-[REDACTED]'") : value;
  const urls = text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, raw => {
    try {
      const url = new URL(raw);
      let changed = false;
      if (url.username || url.password) { url.username = "redacted"; url.password = ""; changed = true; }
      for (const key of new Set(url.searchParams.keys())) {
        if (sensitiveName.test(key) || /^(?:key|code)$/iu.test(key)) { url.searchParams.set(key, "[REDACTED]"); changed = true; }
      }
      if (url.hash) { url.hash = "[REDACTED]"; changed = true; }
      return changed ? url.href : raw;
    } catch { return "[REDACTED URL]"; }
  });
  // Relative reporting/redirect URLs can carry the same credential query parameters.
  return urls.replace(/([?&#])([^=?&#\s"'<>]+)=([^&#\s"'<>]*)/gu, (match, separator: string, encodedKey: string) => {
    let key: string;
    try { key = decodeURIComponent(encodedKey); } catch { return match; }
    return sensitiveName.test(key) || /^(?:key|code)$/iu.test(key) ? `${separator}${encodedKey}=[REDACTED]` : match;
  });
}

/** Bounded header capture for Relay in every capture mode; never modifies headers used for forwarding. */
export function capturedTrafficHeaders(input: IncomingHttpHeaders | OutgoingHttpHeaders): {
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
      const text = redactTrafficHeaderValue(name, String(part));
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
