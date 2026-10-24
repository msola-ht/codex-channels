import { advanceMarkdownFence } from "../markdown-fence.js";

/** A complete semantic block and its optional QQ representation. Text is never a truncated preview. */
export interface QqContentBlock { text: string; markdown?: string }

function literal(text: string): QqContentBlock {
  // QQ's escape/entity behavior is not documented. Unrepresentable literal fields stay text.
  const safe = !/[<>&\\`|*[\]~\p{Cc}]/u.test(text)
    && !/(?:^|[^\p{L}\p{N}])_|_(?:$|[^\p{L}\p{N}])/u.test(text)
    && !/qqbot[-:]/iu.test(text);
  return { text, ...(safe ? { markdown: text } : {}) };
}

/** Read a complete link before interpreting its label; destinations are always literal. */
function readLink(source: string): { raw: string; image: boolean; label: string; destination: string } | undefined {
  const opening = /^(!?)\[([^\]\n]*)\]\(/u.exec(source);
  if (!opening) return undefined;
  let index = opening[0].length;
  const start = index;
  let nesting = 0;
  let angle = false;
  if (source[index] === "<") { angle = true; index++; }
  for (; index < source.length; index++) {
    const character = source[index]!;
    if (character === "\\" && index + 1 < source.length) { index++; continue; }
    if (angle) {
      if (character !== ">") continue;
      if (source[index + 1] !== ")") return undefined;
      return { raw: source.slice(0, index + 2), image: opening[1] === "!", label: opening[2]!,
        destination: source.slice(start + 1, index) };
    }
    if (character === "(") nesting++;
    if (character === ")") {
      if (nesting > 0) { nesting--; continue; }
      const destination = source.slice(start, index);
      if (!destination || /\s/u.test(destination)) return undefined;
      return { raw: source.slice(0, index + 1), image: opening[1] === "!", label: opening[2]!, destination };
    }
  }
  return undefined;
}

/** Bounded inline conversion. Code and unknown syntax never become executable QQ tags. */
function inline(source: string, depth = 0): QqContentBlock {
  if (depth > 4) return { text: source };
  let text = "";
  let markdown = "";
  let supported = true;
  const append = (part: QqContentBlock): void => {
    text += part.text;
    if (part.markdown === undefined) supported = false;
    else markdown += part.markdown;
  };
  for (let index = 0; index < source.length;) {
    const rest = source.slice(index);
    const escape = /^\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/u.exec(rest);
    if (escape) {
      // Keep escaped punctuation visibly literal even if it is meaningful to QQ Markdown.
      append({ text: escape[1]! });
      index += escape[0].length;
      continue;
    }
    const code = /^(`+)([^\n]*?)\1(?!`)/u.exec(rest);
    if (code && !code[2]!.includes(code[1]!)) {
      append({ text: code[2]! });
      index += code[0].length;
      continue;
    }
    const link = readLink(rest);
    const autolink = /^<(https?:\/\/[^\s<>]+)>/iu.exec(rest);
    if (link || autolink) {
      const destination = link?.destination ?? autolink![1]!;
      const label = link ? inline(link.label, depth + 1).text : destination;
      let safe = false;
      try {
        const url = new URL(destination);
        safe = ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
          && !/[<>&\\`[\]()"'\s]/u.test(destination);
      } catch { /* Local references and unknown schemes are rendered literally. */ }
      const labelValue = literal(label);
      append({ text: label === destination ? destination : `${label} (${destination})`,
        ...(safe && !link?.image && labelValue.markdown !== undefined
          ? { markdown: `[${label}](${destination})` } : {}) });
      index += (link?.raw ?? autolink![0]).length;
      continue;
    }
    // URLs and file paths often contain Markdown delimiters; their spelling is data.
    const path = /^(?:[A-Za-z]:\\[^\s`[\]<>]*|[^\s*`[\]<>]*\/[^\s*`[\]<>]*)/u.exec(rest);
    if (path) {
      append(literal(path[0]));
      index += path[0].length;
      continue;
    }
    const emphasis = /^(\*\*\*|\*\*|__|~~|\*|_)(\S(?:.*?\S)?)\1/u.exec(rest);
    if (emphasis && !(emphasis[1]!.includes("_")
      && (/[\p{L}\p{N}]/u.test(source[index - 1] ?? "") || /[\p{L}\p{N}]/u.test(rest[emphasis[0].length] ?? "")))) {
      const part = inline(emphasis[2]!, depth + 1);
      append({ text: part.text, ...(part.markdown === undefined ? {} : { markdown: `${emphasis[1]}${part.markdown}${emphasis[1]}` }) });
      index += emphasis[0].length;
      continue;
    }
    // Consume ordinary text together so identifiers such as Los_Angeles retain their context.
    let length = 1;
    while (length < rest.length && !/[\\`[<!*~\s]/u.test(rest[length]!)
      && !(rest[length] === "_" && !/[\p{L}\p{N}]/u.test(rest[length - 1]!))) length++;
    append(literal(rest.slice(0, length)));
    index += length;
  }
  return { text, ...(supported ? { markdown } : {}) };
}

/** Convert body syntax or shared panel structure; panel values are always literal. */
export function renderQqContent(source: string, panel = false): QqContentBlock[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: QqContentBlock[] = [];
  const indents = lines.flatMap(line => {
    const match = /^( +)(?:[-+*]|\d+[.)]) /u.exec(line);
    return match ? [match[1]!.length] : [];
  });
  const indentUnit = panel ? 2 : Math.min(4, ...indents);
  const listStart = panel ? /^( *)(?:[-+*•]|\d+[.)]) /u : /^( *)(?:[-+*]|\d+[.)]) /u;
  let listContext = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = advanceMarkdownFence(undefined, line);
    if (fence && !panel) {
      listContext = false;
      let end = index + 1;
      while (end < lines.length && advanceMarkdownFence(fence, lines[end]!) !== undefined) end++;
      if (end < lines.length) {
        const code = lines.slice(index + 1, end).join("\n");
        // Empty code blocks carry syntax but no code; retain them rather than emit an empty message.
        blocks.push({ text: code.trim() ? code : lines.slice(index, end + 1).join("\n") });
        index = end;
        continue;
      }
      blocks.push({ text: lines.slice(index).join("\n") });
      break;
    }
    if (!line.trim()) { blocks.push({ text: line, markdown: line }); continue; }
    const heading = /^ {0,3}(#{1,6})\s+(.+)$/u.exec(line);
    const list = /^( *)([-+*]|\d+[.)])\s+(.+)$/u.exec(line);
    if (!panel && (!list || !listContext) && /^(?: {4}|\t)/u.test(line)) {
      blocks.push({ text: line });
      continue;
    }
    listContext = list !== null;
    const quote = /^ {0,3}> ?(.*)$/u.exec(line);
    const separator = /^ {0,3}(?:\*{3,}|-{3,}|_{3,})\s*$/u.test(line);
    if (separator) { blocks.push({ text: line, markdown: "***" }); continue; }
    let value = heading?.[2] ?? list?.[3] ?? quote?.[1] ?? line;
    let part: QqContentBlock;
    if (panel) {
      // Only the shared field-label decoration is trusted; never parse the value as Markdown.
      const label = /^\*\*([^*]+)\*\*(?=：|$)/u.exec(value);
      value = value.replace(/^\*\*([^*]+)\*\*(?=：|$)/u, "$1");
      part = literal(value);
      if (label && part.markdown !== undefined) {
        part.markdown = `**${label[1]}**${value.slice(label[1]!.length)}`;
      }
    } else part = inline(value);
    const indent = list ? Math.ceil(list[1]!.length / indentUnit) * 4 : 0;
    const marker = list ? (/^\d/u.test(list[2]!) ? list[2]!.replace(")", ".") : "-") : "";
    const prefix = heading ? `${"#".repeat(Math.min(2, heading[1]!.length))} `
      : list ? `${" ".repeat(indent)}${marker} ` : quote ? "> " : "";
    const plainPrefix = list ? `${list[1]}${panel && !/^\d/u.test(list[2]!) ? "•" : list[2]} ` : quote ? "> " : "";
    const previous = blocks.at(-1);
    if (list && previous?.text.trim() && !listStart.test(previous.markdown ?? previous.text)
      && !/^(?:>|#{1,2} )/u.test(previous.markdown ?? previous.text)) {
      blocks.push({ text: "", markdown: "" });
    }
    blocks.push({ text: plainPrefix + part.text,
      ...(part.markdown === undefined ? {} : { markdown: prefix + part.markdown }) });
  }
  const grouped: QqContentBlock[] = [];
  for (const block of blocks) {
    const previous = grouped.at(-1);
    const quote = /^> /u;
    if (previous && ((listStart.test(previous.text) && listStart.test(block.text))
      || (quote.test(previous.text) && quote.test(block.text)))) {
      previous.text += `\n${block.text}`;
      if (previous.markdown !== undefined && block.markdown !== undefined) previous.markdown += `\n${block.markdown}`;
      else delete previous.markdown;
    } else grouped.push({ ...block });
  }
  return grouped;
}
