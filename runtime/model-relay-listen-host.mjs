import { isIPv4 } from "node:net";

/** Explicit listener addresses only; no DNS resolution or automatic interface selection. */
export function isRelayListenHost(host) {
  if (host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;
  if (typeof host !== "string" || !isIPv4(host)) return false;
  const [first, second] = host.split(".").map(Number);
  return first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
}
