/** Strict, side-effect-free projection shared by readers and retention owners. */
export function projectTrafficDumpManifest(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).some(key => !["createdAtMs", "label", "session", "version"].includes(key))
    || typeof value.createdAtMs !== "number" || !Number.isFinite(value.createdAtMs)
    || typeof value.label !== "string" || value.label.length === 0
    || typeof value.session !== "string" || value.session.length === 0
    || typeof value.version !== "number" || !Number.isFinite(value.version)) return undefined;
  return { createdAtMs: value.createdAtMs, label: value.label, session: value.session, version: value.version };
}
