export function encodeFeishuPostContent(markdown: string): string {
  const safeMarkdown = sanitizeFeishuMarkdown(markdown);
  return JSON.stringify({
    zh_cn: {
      title: "",
      content: [[{
        tag: "md",
        text: safeMarkdown,
      }]],
    },
  });
}

export function sanitizeFeishuMarkdown(markdown: string): string {
  return markdown.replace(
    /<(?=\/?at(?:\s|>))/giu,
    "&lt;",
  );
}

const feishuMarkdownEscapeCharacters = /([`*_~[\]()>#+\-.!|])/gu;
const feishuCardMarkdownEscapeCharacters = /([`*_~[\]()>#+\-.!|{}])/gu;

function escapeFeishuMarkdownCharacters(
  value: string,
  characters: RegExp,
  normalizeNewlines: boolean,
): string {
  const normalized = normalizeNewlines ? value.replace(/[\r\n]+/gu, " ") : value;
  return normalized
    .replaceAll("\\", "\\\\")
    .replaceAll(characters, "\\$1");
}

export function escapeFeishuMarkdown(value: string): string {
  return escapeFeishuMarkdownCharacters(value, feishuMarkdownEscapeCharacters, false);
}

export function escapeFeishuCardMarkdown(value: string): string {
  return escapeFeishuMarkdownCharacters(value, feishuCardMarkdownEscapeCharacters, true);
}
