/** Read one whole backtick run, consuming a code span only for an equal closing run. */
export function markdownInlineCodeAt(
  text: string,
  start: number,
): { end: number; content: string | undefined } {
  let openingEnd = start;
  while (text[openingEnd] === "`") openingEnd += 1;
  const width = openingEnd - start;
  let cursor = openingEnd;
  while (cursor < text.length && text[cursor] !== "\n") {
    if (text[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    const closingStart = cursor;
    while (text[cursor] === "`") cursor += 1;
    if (cursor - closingStart === width) {
      return { end: cursor, content: text.slice(openingEnd, closingStart) };
    }
  }
  return { end: openingEnd, content: undefined };
}
