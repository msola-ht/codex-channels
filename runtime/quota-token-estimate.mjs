/** Optional, read-time enrichment; failures never hide the official quota. */
export function withQuotaTokenEstimates(windows, read) {
  let estimates;
  try { estimates = read?.(); } catch { /* Represent a failed metrics read explicitly. */ }
  return windows.map(window => ({
    ...window,
    tokenEstimate: estimates === undefined ? { status: "unavailable" }
      : estimates.find(estimate => estimate.windowId === window.windowId && estimate.resetsAt === window.resetsAt)?.tokenEstimate
        ?? { status: "sampling" },
  }));
}
