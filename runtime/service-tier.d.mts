export function acceleratedServiceTierId(
  serviceTiers: readonly { id: string }[],
  requested: "fast" | "ultrafast",
): string | undefined;

export function normalizeServiceTier(tier: string): string;
export function normalizeServiceTier(tier: null): null;
export function normalizeServiceTier(tier: undefined): undefined;
export function normalizeServiceTier(tier: string | null | undefined): string | null | undefined;
