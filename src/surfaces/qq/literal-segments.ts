const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** An unterminated resource can still grow on the next delta. Do not confirm
 * its prefix in an old stream bubble which might have to close immediately. */
export function qqLiteralStablePrefix(text: string): string {
  let end = text.length;
  let offset = 0;
  for (const segment of qqLiteralSegments(text)) {
    if (offset + segment.length === text.length
      && (graphemes.segment(segment)[Symbol.iterator]().next().value!.segment.length < segment.length
        || /^(?:\/|\\)$/u.test(segment))) end = offset;
    offset += segment.length;
  }
  const tail = /\S+$/u.exec(text);
  if (tail && (["http://", "https://"].some(prefix => prefix.startsWith(tail[0].toLowerCase()))
    || /^[A-Z]:$/iu.test(tail[0]))) end = Math.min(end, tail.index);
  const partial = /(?:^|[^\p{L}\p{N}_])(h|ht|htt|http|https|https?:\/{0,2})$/iu.exec(text);
  if (partial) end = Math.min(end, text.length - partial[1]!.length);
  // Prefix patterns can begin inside a Unicode grapheme; round down once.
  for (const segment of graphemes.segment(text)) {
    if (segment.index < end && segment.index + segment.segment.length > end) { end = segment.index; break; }
  }
  return text.slice(0, end);
}

/** Keep copyable destinations together without treating ordinary prose as a
 * token. Match offsets may fall inside a grapheme (for example after Prepend),
 * so collect protected ranges before consuming whole original graphemes. */
export function* qqLiteralSegments(text: string): Iterable<string> {
  const ranges: { start: number; end: number }[] = [];
  const patterns = [
    /https?:\/\/[^\s]+/giu,
    /(?<![\p{L}\p{N}_/\\])(?:\/(?!\/)|[A-Z]:[\\/]|\\\\)[^\s`"'<>]+/giu,
    /(["'`])(?:\/(?!\/)|[A-Z]:[\\/]|\\\\)[^\r\n]*?\1/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  // Link targets can contain escaped or balanced parentheses and angle-bracket
  // destinations with spaces. Preserve their original spelling, including any
  // title, instead of parsing and re-encoding a URL or local path.
  const parentheses: (number | undefined)[] = [];
  let targets = 0;
  let angle = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\n" || character === "\r") {
      parentheses.length = 0; targets = 0; angle = false;
    } else if (character === "\\") index += 1;
    else if (angle) { if (character === ">") angle = false; }
    else if (targets && character === "<") angle = true;
    else if (character === "(") {
      const start = text[index - 1] === "]" ? index + 1 : undefined;
      parentheses.push(start);
      if (start !== undefined) targets += 1;
    } else if (character === ")") {
      const start = parentheses.pop();
      if (start !== undefined) {
        targets -= 1;
        if (index > start) ranges.push({ start, end: index });
      }
    }
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  let nextRange = 0;
  let protectedEnd = 0;
  let pending = "";
  for (const { segment, index } of graphemes.segment(text)) {
    const end = index + segment.length;
    while (nextRange < ranges.length && ranges[nextRange]!.start < end) {
      protectedEnd = Math.max(protectedEnd, ranges[nextRange]!.end);
      nextRange += 1;
    }
    if (pending || protectedEnd > index) {
      pending += segment;
      if (end >= protectedEnd) { yield pending; pending = ""; }
    } else yield segment;
  }
  if (pending) yield pending;
}
