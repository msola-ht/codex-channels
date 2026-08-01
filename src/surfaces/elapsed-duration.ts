export function formatElapsedDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}毫秒`;
  }
  return formatElapsedSeconds(Math.round(durationMs / 1_000));
}

export function formatTokensPerSecond(value: number): string {
  const rounded = value >= 10
    ? Math.round(value)
    : Math.round(value * 10) / 10;
  return `${rounded} token/s`;
}

export function formatElapsedSeconds(
  durationSeconds: bigint | number,
): string {
  const wholeSeconds = typeof durationSeconds === "bigint"
    ? durationSeconds
    : BigInt(Math.round(durationSeconds));
  const hours = wholeSeconds / 3_600n;
  const minutes = wholeSeconds % 3_600n / 60n;
  const seconds = wholeSeconds % 60n;
  return [
    ...(hours > 0n ? [`${hours}小时`] : []),
    ...(minutes > 0n ? [`${minutes}分`] : []),
    ...(seconds > 0n || (hours === 0n && minutes === 0n)
      ? [`${seconds}秒`]
      : []),
  ].join("");
}
