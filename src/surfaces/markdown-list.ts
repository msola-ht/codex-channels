import { advanceMarkdownFence, type MarkdownFence } from "./markdown-fence.js";

export function toStructuredMarkdownList(text: string): string {
  const output: string[] = [];
  const singleLine = text.split("\n").filter(line => line.trim()).length === 1;
  let firstContent = true;
  let fence: MarkdownFence | undefined;
  for (const rawLine of text.split("\n")) {
    const previous = fence;
    fence = advanceMarkdownFence(fence, rawLine);
    if (previous || fence) {
      output.push(rawLine);
      firstContent = false;
      continue;
    }
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      output.push("");
      continue;
    }
    if (firstContent) {
      firstContent = false;
      if (/^#{1,6}\s+/u.test(trimmed)) {
        output.push(trimmed);
        continue;
      }
      output.push(singleLine || /^\*\*.+\*\*$/u.test(trimmed) ? trimmed : `## ${stripTrailingColon(trimmed)}`);
      continue;
    }
    if (/^#{1,6}\s+/u.test(trimmed)) {
      output.push(trimmed);
      continue;
    }
    if (/^\*\*.+\*\*$/u.test(trimmed)) {
      output.push(trimmed);
      continue;
    }
    if (/^\s{2,}[-*+]\s+/u.test(line)) {
      output.push(line);
      continue;
    }
    if (/^\s*[-*+]\s+/u.test(line) || /^\s*\d+[.)]\s+/u.test(line)) {
      output.push(line);
      continue;
    }
    if (trimmed.endsWith("：")) {
      output.push(`### ${stripTrailingColon(trimmed)}`);
      continue;
    }
    // Field/value rows are lists; explanatory prose is not another field.
    output.push(/^[^：\n]{1,64}：\s*\S/u.test(trimmed) ? `- ${trimmed}` : trimmed);
  }
  return output.join("\n");
}

function stripTrailingColon(value: string): string {
  return value.endsWith("：") ? value.slice(0, -1) : value;
}
