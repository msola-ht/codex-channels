export function formatWeixinFinalText(text: string): string {
  const lines = text.split(/\r?\n/u);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index]!;
    if (!/^```[a-zA-Z0-9_+-]*\s*$/u.test(opening)) {
      output.push(formatWeixinMarkdownLine(opening));
      continue;
    }
    const closingIndex = lines.findIndex(
      (line, candidate) =>
        candidate > index && /^```\s*$/u.test(line),
    );
    if (closingIndex < 0) {
      // An unclosed fence creates an oversized, unterminated code region in
      // Weixin. Drop only the fence marker and keep formatting the body as
      // ordinary text.
      continue;
    }
    const code = lines.slice(index + 1, closingIndex);
    if (
      code.length === 1
      && code[0]!.trim().length > 0
      && !code[0]!.includes("`")
    ) {
      output.push(`\`${code[0]}\``);
      index = closingIndex;
      continue;
    }
    output.push(...lines.slice(index, closingIndex + 1));
    index = closingIndex;
  }
  return output.join("\n");
}

function formatWeixinMarkdownLine(line: string): string {
  const smallHeading = /^#{5,6}[ \t]+(.+)$/u.exec(line);
  const value = smallHeading === null ? line : `**${smallHeading[1]}**`;
  return formatWeixinMarkdownInline(value);
}

function formatWeixinMarkdownInline(value: string): string {
  let output = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] === "`") {
      const closing = value.indexOf("`", index + 1);
      if (closing < 0) {
        output += value.slice(index + 1);
        break;
      }
      output += value.slice(index, closing + 1);
      index = closing + 1;
      continue;
    }

    if (value.startsWith("![", index)) {
      const imageEnd = markdownDestinationEnd(value, index + 2);
      if (imageEnd !== null) {
        index = imageEnd;
        continue;
      }
    }

    const emphasis = cjkEmphasisAt(value, index);
    if (emphasis !== null) {
      output += emphasis.text;
      index = emphasis.end;
      continue;
    }

    output += value[index];
    index += 1;
  }
  return output;
}

function markdownDestinationEnd(value: string, labelStart: number): number | null {
  const labelEnd = value.indexOf("]", labelStart);
  if (labelEnd < 0 || value[labelEnd + 1] !== "(") {
    return null;
  }
  const destinationEnd = value.indexOf(")", labelEnd + 2);
  return destinationEnd < 0 ? null : destinationEnd + 1;
}

function cjkEmphasisAt(
  value: string,
  start: number,
): { text: string; end: number } | null {
  const markers = ["***", "___", "*", "_"] as const;
  for (const marker of markers) {
    if (!value.startsWith(marker, start)) {
      continue;
    }
    if (
      marker.length === 1
      && (
        value.startsWith(marker.repeat(2), start)
        || value[start - 1] === marker
      )
    ) {
      continue;
    }
    const contentStart = start + marker.length;
    const closing = value.indexOf(marker, contentStart);
    if (closing <= contentStart) {
      continue;
    }
    if (
      marker === "_"
      && (
        isWordCharacter(value[start - 1])
        || isWordCharacter(value[closing + 1])
      )
    ) {
      continue;
    }
    const content = value.slice(contentStart, closing);
    if (!containsCjk(content)) {
      return null;
    }
    return {
      text: formatWeixinMarkdownInline(content),
      end: closing + marker.length,
    };
  }
  return null;
}

function containsCjk(value: string): boolean {
  return /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/u.test(value);
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}
