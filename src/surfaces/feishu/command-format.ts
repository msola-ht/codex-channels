import { conversationCommandDescriptions } from "../conversation-command-help.js";
import { advanceMarkdownFence, type MarkdownFence } from "../markdown-fence.js";
import { surfaceCommandAliases } from "../slash-command.js";

/**
 * 只在飞书 Markdown 里识别已知命令，避免把工作区路径或普通斜杠文本当作命令。
 * 取值来自共享命令表、别名表与飞书专有命令。
 */
const commandNames: ReadonlySet<string> = new Set([
  ...Object.keys(conversationCommandDescriptions),
  ...Object.keys(surfaceCommandAliases),
  "fs",
  "help",
  "whoami",
  "start",
]);

const listMarker = /^(\s*(?:[-*+]\s+|\d+[.)]\s+)?)([\s\S]*)$/u;
const fieldPrefix = /^([^：\n]{1,32}：)(\S[\s\S]*)$/u;
const commandToken = /^\/([a-z][a-z0-9-]*)(?:\s|$)/u;
const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const descriptionSeparator = /[\s·；，。、（）]/u;
const trailingPunctuation = /[\s。；，、！？…]+$/u;
/** 目录、路径与文件字段的值是路径，即使与命令同名也不是命令。 */
const pathField = /(目录|路径|文件)/u;
/** 四空格或制表符缩进在 Markdown 里可能是代码块，不再重复包装。 */
const indentedBlock = /^(?:\t| {4,})/u;
/** 过长的跨度可能跨越卡片分片边界，保留原文更安全。 */
const maximumCommandCharacters = 200;

/**
 * 把飞书 Gateway 文案里的命令渲染为行内代码，便于在客户端识别与复制。
 * 只处理独立成行的命令和以“标签：”引出的命令；代码围栏内容、句内提及和表格行保持原样。
 */
export function formatFeishuCommandMarkdown(text: string): string {
  let fence: MarkdownFence | undefined;
  return text
    .split("\n")
    .map((line) => {
      const previous = fence;
      fence = advanceMarkdownFence(fence, line);
      if (previous !== undefined || fence !== undefined) {
        return line;
      }
      return formatFeishuCommandLine(line);
    })
    .join("\n");
}

function formatFeishuCommandLine(line: string): string {
  if (
    line.trim().length === 0
    || line.trimStart().startsWith("|")
    || indentedBlock.test(line)
  ) {
    return line;
  }
  const marked = listMarker.exec(line);
  if (marked === null) {
    return line;
  }
  const marker = marked[1]!;
  const body = marked[2]!;
  const field = fieldPrefix.exec(body);
  if (field !== null && pathField.test(field[1]!)) {
    return line;
  }
  const rendered = wrapCommandRun(field === null ? body : field[2]!);
  if (rendered === undefined) {
    return line;
  }
  return `${marker}${field === null ? "" : field[1]!}${rendered}`;
}

function wrapCommandRun(value: string): string | undefined {
  const segments = value.split(" · ");
  let consumed = 0;
  while (consumed < segments.length && isCommandSegment(segments[consumed]!)) {
    consumed += 1;
  }
  if (consumed === 0) {
    return undefined;
  }
  const last = stopAtDescription(segments[consumed - 1]!);
  const command = [
    ...segments.slice(0, consumed - 1),
    last.code,
  ].join(" · ");
  const rest = segments.slice(consumed).join(" · ");
  const tail = rest.length === 0
    ? last.suffix
    : `${last.suffix} · ${rest}`;
  // 反引号无法配对或跨度会跨分片边界时保留原文，避免产出损坏的 Markdown。
  if (
    command.trim().length === 0
    || [...command].length > maximumCommandCharacters
    || command.includes("`")
    || tail.includes("`")
  ) {
    return undefined;
  }
  return `\`${command}\`${tail}`;
}

function isCommandSegment(segment: string): boolean {
  const match = commandToken.exec(segment.trim());
  return match !== null && commandNames.has(match[1]!);
}

/**
 * 命令之后的中文说明不属于命令本身：占位符括号内的中文照旧保留，
 * 括号外的首个中文字符起为说明，结尾的命令标点留在代码之外。
 */
function stopAtDescription(segment: string): { code: string; suffix: string } {
  let depth = 0;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!;
    if (character === "<" || character === "[" || character === "(") {
      depth += 1;
      continue;
    }
    if (character === ">" || character === "]" || character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && (character === "（" || cjk.test(character))) {
      let end = index;
      while (end > 0 && descriptionSeparator.test(segment[end - 1]!)) {
        end -= 1;
      }
      return {
        code: segment.slice(0, end),
        suffix: segment.slice(end),
      };
    }
  }
  const code = segment.trimEnd();
  const trimmed = code.replace(trailingPunctuation, "");
  return { code: trimmed, suffix: code.slice(trimmed.length) };
}
