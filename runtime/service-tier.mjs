/** Pure catalog selection; return the upstream ID without inventing capabilities. */
export function acceleratedServiceTierId(serviceTiers, requested) {
  return serviceTiers.find((tier) => requested === "fast"
    ? tier.id === "fast" || tier.id === "priority"
    : requested === "ultrafast" && tier.id === "ultrafast")?.id;
}

/** Normalize only the documented Fast wire ID; other values remain observable. */
export function normalizeServiceTier(tier) {
  return tier === "priority" ? "fast" : tier;
}
