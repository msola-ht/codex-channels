export function parseSemanticHtmlTables(html, label = "HTML 页面") {
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, " ");
  const tables = [];
  const documentText = [];
  let table = null;
  let row = null;
  let cell = null;
  let cursor = 0;
  while (cursor < cleaned.length) {
    const opening = cleaned.indexOf("<", cursor);
    if (opening < 0) {
      appendText(cleaned.slice(cursor));
      break;
    }
    appendText(cleaned.slice(cursor, opening));
    const closing = findTagEnd(cleaned, opening + 1);
    if (closing < 0) throw new Error(`${label} HTML 标签未闭合`);
    const tag = parseTag(cleaned.slice(opening + 1, closing));
    if (tag) handleTag(tag);
    cursor = closing + 1;
  }
  if (table || row || cell) throw new Error(`${label}表格未闭合`);
  return {
    tables,
    text: normalizeText(documentText.join(" ")),
  };

  function appendText(value) {
    const decoded = decodeHtmlEntities(value);
    documentText.push(decoded);
    if (cell !== null) cell.push(decoded);
  }

  function handleTag({ name, closing }) {
    if (name === "br" && !closing) {
      appendText(" ");
      return;
    }
    if (name === "table") {
      if (closing) {
        if (!table) throw new Error(`${label}表格结构无效`);
        tables.push(table);
        table = null;
      } else {
        if (table) throw new Error(`${label}不支持嵌套表格`);
        table = [];
      }
      return;
    }
    if (!table) return;
    if (name === "tr") {
      if (closing) {
        if (!row || cell) throw new Error(`${label}表格行无效`);
        if (row.length > 0) table.push(row);
        row = null;
      } else {
        if (row) throw new Error(`${label}表格行嵌套`);
        row = [];
      }
      return;
    }
    if (name === "td" || name === "th") {
      if (closing) {
        if (!row || cell === null) throw new Error(`${label}单元格无效`);
        row.push(normalizeText(cell.join(" ")));
        cell = null;
      } else {
        if (!row || cell !== null) throw new Error(`${label}单元格嵌套`);
        cell = [];
      }
    }
  }
}

function findTagEnd(html, start) {
  let quote = null;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function parseTag(raw) {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("!") || trimmed.startsWith("?")) return null;
  const closing = trimmed.startsWith("/");
  const name = /^\/?\s*([a-z0-9-]+)/iu.exec(trimmed)?.[1]?.toLowerCase();
  return name ? { name, closing } : null;
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/giu, (match, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return safeCodePoint(Number.parseInt(entity.slice(2), 16), match);
    }
    if (entity.startsWith("#")) {
      return safeCodePoint(Number.parseInt(entity.slice(1), 10), match);
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function safeCodePoint(value, fallback) {
  try {
    return Number.isInteger(value) ? String.fromCodePoint(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return value.replace(/\s+/gu, " ").trim();
}
