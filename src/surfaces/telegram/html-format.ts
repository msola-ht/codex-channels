import { splitTelegramText } from "./format.js";

export function formatTelegramPanelChunks(text: string, limit = 3_600): string[] {
  const contentLimit = Math.max(1, limit - 128);
  return splitTelegramText(text, contentLimit).map((chunk, index) =>
    formatTelegramPanelHtml(chunk, { emphasizeFirstLine: index === 0 })
  );
}

export function formatTelegramDiffChunks(text: string, limit = 3_600): string[] {
  const separator = text.indexOf("\n\n");
  if (separator < 0 || !text.startsWith("Turn Diff · ")) {
    return formatTelegramPanelChunks(text, limit);
  }

  const title = text.slice(0, separator);
  const diff = text.slice(separator + 2);
  const contentLimit = Math.max(1, limit - Array.from(title).length - 160);
  return splitTelegramText(diff, contentLimit).map((chunk, index) => [
    ...(index === 0 ? [`<b>${escapeTelegramHtml(title)}</b>`, ""] : []),
    `<pre>${escapeTelegramHtml(chunk)}</pre>`,
  ].join("\n"));
}

export function formatTelegramPanelHtml(
  text: string,
  options: { emphasizeFirstLine?: boolean } = {},
): string {
  const emphasizeFirstLine = options.emphasizeFirstLine ?? true;
  const lines = text.split("\n");
  const output: string[] = [];
  let firstContentLine = true;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line) {
      output.push("");
      continue;
    }

    if (line.startsWith("│ ")) {
      const quoted = [line.slice(2)];
      while (index + 1 < lines.length && lines[index + 1]!.startsWith("│ ")) {
        quoted.push(lines[index + 1]!.slice(2));
        index += 1;
      }
      output.push(`<blockquote>${escapeTelegramHtml(quoted.join("\n"))}</blockquote>`);
      firstContentLine = false;
      continue;
    }

    const escaped = escapeTelegramHtml(line);
    if (firstContentLine) {
      firstContentLine = false;
      if (emphasizeFirstLine) {
        output.push(`<b>${escaped}</b>`);
        continue;
      }
    }

    const bullet = line.match(/^(\s*)-\s+(.+)$/);
    if (bullet) {
      output.push(`${bullet[1]}• ${escapeTelegramHtml(bullet[2]!)}`);
      continue;
    }

    if (/^\s*\/[a-z][^\n]*$/i.test(line)) {
      output.push(`<code>${escaped.trimStart()}</code>`);
      continue;
    }

    if (/^\s{2,}(?:\/|[A-Za-z]:\\)/.test(line)) {
      output.push(`<code>${escaped.trimStart()}</code>`);
      continue;
    }

    const field = line.match(/^([^：\n]{1,32}：)(.*)$/);
    if (field) {
      const label = escapeTelegramHtml(field[1]!);
      const value = escapeTelegramHtml(field[2]!);
      const formattedValue = /^(切换|恢复|恢复归档)：$/.test(field[1]!)
        ? `<code>${value.trimStart()}</code>`
        : value;
      output.push(`<b>${label}</b>${formattedValue}`);
      continue;
    }

    output.push(escaped);
  }

  return output.join("\n");
}

export function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
