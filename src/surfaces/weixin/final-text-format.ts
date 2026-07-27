export function formatWeixinFinalText(text: string): string {
  const lines = text.split(/\r?\n/u);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index]!;
    if (!/^```[a-zA-Z0-9_+-]*\s*$/u.test(opening)) {
      output.push(opening);
      continue;
    }
    const closingIndex = lines.findIndex(
      (line, candidate) =>
        candidate > index && /^```\s*$/u.test(line),
    );
    if (closingIndex < 0) {
      output.push(opening);
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
