export function formatElapsedDuration(durationMs: number): string {
  const milliseconds = Math.round(durationMs * 100) / 100;
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const seconds = Math.round(durationMs / 10) / 100;
  if (seconds < 60) return `${seconds} s`;
  const wholeSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor(wholeSeconds % 3_600 / 60);
  const remainingSeconds = wholeSeconds % 60;
  return [
    ...(hours > 0 ? [`${hours} h`] : []),
    ...(minutes > 0 ? [`${minutes} min`] : []),
    ...(remainingSeconds > 0 ? [`${remainingSeconds} s`] : []),
  ].join(" ");
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
