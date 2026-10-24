/** Last submitted model destination; never retain URL credentials or query secrets. */
export function sanitizeModelRequestUrl(value) {
  if (typeof value !== "string") return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return null;
  }
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
    const address = `${url.origin}${url.pathname}`;
    return address.length <= 2048 ? address : null;
  } catch { return null; }
}
