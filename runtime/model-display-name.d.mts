export function validateModelDisplayAliases(value: unknown): Record<string, string>;

export function modelDisplayName(
  model: string,
  aliases?: Readonly<Record<string, string>>,
  fallback?: string,
): string;
