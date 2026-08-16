import { isSafeFeishuResourceIdentifier } from "./media.js";
import { isSafeFeishuFileName } from "./file-input.js";

export type FeishuParsedContent =
  | { kind: "text"; text: string }
  | { kind: "image"; imageKeys: readonly string[]; text?: string }
  | { kind: "file"; fileKey: string; fileName: string }
  | { kind: "audio"; fileKey: string; durationMs?: number };

export function parseFeishuTextContent(value: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
  ) {
    return undefined;
  }
  const text = (parsed as Record<string, unknown>).text;
  return typeof text === "string" ? text : undefined;
}

export function parseFeishuImageContent(
  value: string,
): Extract<FeishuParsedContent, { kind: "image" }> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
  ) {
    return undefined;
  }
  const imageKey = (parsed as Record<string, unknown>).image_key;
  if (
    typeof imageKey !== "string"
    || !isSafeFeishuResourceIdentifier(imageKey)
  ) {
    return undefined;
  }
  return { kind: "image", imageKeys: [imageKey] };
}

export function parseFeishuFileContent(
  value: string,
): Extract<FeishuParsedContent, { kind: "file" }> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
  ) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.file_key !== "string"
    || !isSafeFeishuResourceIdentifier(record.file_key)
    || typeof record.file_name !== "string"
    || !isSafeFeishuFileName(record.file_name)
  ) {
    return undefined;
  }
  return {
    kind: "file",
    fileKey: record.file_key,
    fileName: record.file_name.trim(),
  };
}

export function parseFeishuAudioContent(
  value: string,
): Extract<FeishuParsedContent, { kind: "audio" }> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
  ) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.file_key !== "string"
    || !isSafeFeishuResourceIdentifier(record.file_key)
  ) {
    return undefined;
  }
  const durationMs = record.duration;
  if (
    durationMs !== undefined
    && (
      typeof durationMs !== "number"
      || !Number.isSafeInteger(durationMs)
      || durationMs < 0
    )
  ) {
    return undefined;
  }
  return {
    kind: "audio",
    fileKey: record.file_key,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

export function parseFeishuPostContent(
  value: string,
): Exclude<FeishuParsedContent, { kind: "file" }> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const body = unwrapPostLocale(parsed);
  if (body === undefined || !Array.isArray(body.content)) {
    return undefined;
  }

  const imageKeys: string[] = [];
  const lines: string[] = [];
  if (typeof body.title === "string" && body.title.length > 0) {
    lines.push(body.title);
  }
  for (const paragraph of body.content) {
    if (!Array.isArray(paragraph)) {
      return undefined;
    }
    let line = "";
    for (const element of paragraph) {
      if (
        typeof element !== "object"
        || element === null
        || Array.isArray(element)
      ) {
        return undefined;
      }
      const item = element as Record<string, unknown>;
      if (
        item.tag === "text"
        || item.tag === "md"
        || item.tag === "code_block"
      ) {
        if (typeof item.text !== "string") {
          return undefined;
        }
        line += item.text;
      } else if (item.tag === "a") {
        if (
          typeof item.text !== "string"
          || typeof item.href !== "string"
        ) {
          return undefined;
        }
        line += item.text;
        if (item.href.length > 0 && item.href !== item.text) {
          line += ` (${item.href})`;
        }
      } else if (item.tag === "img") {
        if (
          typeof item.image_key !== "string"
          || !isSafeFeishuResourceIdentifier(item.image_key)
        ) {
          return undefined;
        }
        imageKeys.push(item.image_key);
      } else {
        return undefined;
      }
    }
    lines.push(line);
  }
  const text = lines.join("\n").trim();
  if (imageKeys.length === 0) {
    return text.length === 0 ? undefined : { kind: "text", text };
  }
  return {
    kind: "image",
    imageKeys,
    ...(text.length === 0 ? {} : { text }),
  };
}

export function extractFeishuQuotedText(
  messageType: string,
  content: string,
): string | undefined {
  if (messageType === "text") {
    return parseFeishuTextContent(content)?.trim() || undefined;
  }
  if (messageType === "interactive") {
    return parseFeishuInteractiveContent(content);
  }
  if (messageType !== "post") {
    return undefined;
  }
  const parsed = parseFeishuPostContent(content);
  return parsed?.kind === "text" || parsed?.kind === "image"
    ? parsed.text?.trim() || undefined
    : undefined;
}

function parseFeishuInteractiveContent(
  value: string,
): string | undefined {
  const raw = parseRecord(value);
  if (raw === undefined || typeof raw.json_card !== "string") {
    return undefined;
  }
  const card = parseRecord(raw.json_card);
  if (card === undefined) {
    return undefined;
  }

  const lines: string[] = [];
  const header = asRecord(card.header);
  const headerProperty = asRecord(header?.property) ?? header;
  const title = extractCardText(headerProperty?.title);
  if (title !== undefined) {
    lines.push(title);
  }

  const body = asRecord(card.body);
  const bodyProperty = asRecord(body?.property) ?? body;
  const elements = Array.isArray(bodyProperty?.elements)
    ? bodyProperty.elements
    : Array.isArray(card.elements)
      ? card.elements
      : [];
  const budget = { elements: 0 };
  for (const element of elements) {
    collectCardText(element, lines, budget, 0);
  }
  const text = lines.map((line) => line.trim()).filter(Boolean).join("\n");
  return text || undefined;
}

function collectCardText(
  value: unknown,
  lines: string[],
  budget: { elements: number },
  depth: number,
): void {
  if (depth > 8 || budget.elements >= 200) {
    return;
  }
  const element = asRecord(value);
  if (element === undefined) {
    return;
  }
  budget.elements += 1;
  const property = asRecord(element.property) ?? element;
  const tag = element.tag;

  if (tag === "markdown" || tag === "markdown_v1") {
    if (Array.isArray(property.elements)) {
      const parts: string[] = [];
      collectCardArray(property.elements, parts, budget, depth);
      const text = parts.join("").trim();
      if (text.length > 0) {
        lines.push(text);
      }
      return;
    }
    const text = extractCardText(property);
    if (text !== undefined) {
      lines.push(text);
    }
    return;
  }
  if (
    tag === "plain_text"
    || tag === "text"
    || tag === "lark_md"
  ) {
    const text = extractCardText(property);
    if (text !== undefined) {
      lines.push(text);
    }
    return;
  }
  if (tag === "div") {
    const text = extractCardText(property.text);
    if (text !== undefined) {
      lines.push(text);
    }
    collectCardArray(property.fields, lines, budget, depth);
    return;
  }
  if (tag === "note") {
    collectCardArray(property.elements, lines, budget, depth);
    return;
  }
  if (tag === "column_set") {
    collectCardArray(property.columns, lines, budget, depth);
    return;
  }
  if (tag === "column" || tag === "collapsible_panel") {
    collectCardArray(property.elements, lines, budget, depth);
  }
}

function collectCardArray(
  value: unknown,
  lines: string[],
  budget: { elements: number },
  depth: number,
): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const child of value) {
    collectCardText(child, lines, budget, depth + 1);
  }
}

function extractCardText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : undefined;
  }
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const property = asRecord(record.property) ?? record;
  for (const field of ["content", "text"]) {
    const candidate = property[field];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object"
      && value !== null
      && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function unwrapPostLocale(
  value: unknown,
): Record<string, unknown> | undefined {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if ("title" in record || "content" in record) {
    return record;
  }
  for (const locale of ["zh_cn", "en_us", "ja_jp"]) {
    const body = record[locale];
    if (
      typeof body === "object"
      && body !== null
      && !Array.isArray(body)
    ) {
      return body as Record<string, unknown>;
    }
  }
  return undefined;
}
