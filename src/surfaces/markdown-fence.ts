/** 仅识别围栏与推进状态；字符预算、分片和平台渲染由调用方负责。 */
export interface MarkdownFence {
  marker: string;
  info: string;
  opening: string;
}

export function advanceMarkdownFence(
  active: MarkdownFence | undefined,
  line: string,
): MarkdownFence | undefined {
  const opening = line.replace(/\r?\n$/u, "");
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/u.exec(opening);
  if (!match) return active;
  const marker = match[1]!;
  const info = match[2]!;
  if (active) {
    return marker[0] === active.marker[0] && marker.length >= active.marker.length
      && info.trim().length === 0 ? undefined : active;
  }
  if (marker[0] === "`" && info.includes("`")) return undefined;
  return { marker, info, opening };
}
