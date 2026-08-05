export function toStructuredMarkdownList(text: string): string {
  const output: string[] = [];
  let firstContent = true;
  let fenced = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      output.push("");
      continue;
    }
    if (/^```/u.test(trimmed)) {
      fenced = !fenced;
      output.push(line);
      continue;
    }
    if (fenced) {
      output.push(line);
      continue;
    }
    if (firstContent) {
      firstContent = false;
      if (/^#{1,6}\s+/u.test(trimmed)) {
        output.push(trimmed);
        continue;
      }
      output.push(`## ${stripTrailingColon(trimmed)}`);
      continue;
    }
    if (/^#{1,6}\s+/u.test(trimmed)) {
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
    output.push(`- ${trimmed}`);
  }
  return output.join("\n");
}

function stripTrailingColon(value: string): string {
  return value.endsWith("：") ? value.slice(0, -1) : value;
}
