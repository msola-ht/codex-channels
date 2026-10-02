import {
  formatRequestCount,
  formatTokenCount,
} from "../dist/surfaces/token-format.js";

export { formatRequestCount, formatTokenCount };
export { formatElapsedDuration } from "../dist/surfaces/elapsed-duration.js";

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function formatLocalTime(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ");
}

export function formatLocalTimeZone() {
  // A report can span DST changes; one current offset cannot describe all records.
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" && /^[=+\-@\t\r\n]/u.test(value)
    ? `'${value}`
    : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
