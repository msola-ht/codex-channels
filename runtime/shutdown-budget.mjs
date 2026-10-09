// Allow each service's own deadline to expire before an owning wrapper escalates.
// Child delivery may consume 5s; Windows tree termination may consume another
// 10s (two 2s taskkill calls, 5s grace and 1s final exit confirmation).
export const serviceShutdownTimeoutMs = 30_000;
export const serviceGracefulStopTimeoutMs = serviceShutdownTimeoutMs + 5_000;
export const serviceStopTimeoutMs = serviceGracefulStopTimeoutMs + 10_000 + 5_000;
// Unix service managers and launchd unload confirmation share this outer limit.
export const serviceStopTimeoutSeconds = Math.ceil(serviceStopTimeoutMs / 1_000);

// Scheduler confirmation starts only after graceful host shutdown was attempted.
export const windowsTaskStopTimeoutMs = 20_000;
