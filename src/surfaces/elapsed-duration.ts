export function formatElapsedDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}毫秒`;
  }
  const wholeSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor(wholeSeconds % 3_600 / 60);
  const seconds = wholeSeconds % 60;
  return [
    ...(hours > 0 ? [`${hours}小时`] : []),
    ...(minutes > 0 ? [`${minutes}分`] : []),
    ...(seconds > 0 || (hours === 0 && minutes === 0) ? [`${seconds}秒`] : []),
  ].join("");
}
