import type { ServiceLogsResponse } from "./types"

export const logLevels = ["trace", "debug", "info", "warn", "error", "fatal", "unknown"] as const
export type LogLevel = typeof logLevels[number]
export type LogLevelFilter = LogLevel | "all" | "problems"
export interface LogEntry {
  id: string
  source: ServiceLogsResponse["streams"][number]["source"]
  time: number | null
  level: LogLevel
  module: string | null
  message: string
  fields: Record<string, unknown> | null
  raw: string
}

const pinoLevels: Record<number, LogLevel> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" }
const journalLevels: Record<string, LogLevel> = { "0": "fatal", "1": "fatal", "2": "fatal", "3": "error", "4": "warn", "5": "info", "6": "info", "7": "debug" }
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u

function timestamp(value: unknown): number | null {
  const time = typeof value === "number" ? value : typeof value === "string" && isoTime.test(value) ? Date.parse(value) : NaN
  return Number.isFinite(time) && !Number.isNaN(new Date(time).getTime()) ? time : null
}

/** Input has already passed server redaction. Unknown formats remain plain text. */
export function parseLogLine(raw: string): Omit<LogEntry, "id" | "source"> {
  const journal = /^(\S+)\s+(\S+)\s+[^\s:]+(?:\[\d+\])?:\s(.*)$/u.exec(raw)
  const journalTime = journal && !["TRACE", "DEBUG", "INFO", "WARN", "ERROR"].includes(journal[2]!) ? timestamp(journal[1]) : null
  const body = journalTime !== null ? journal![3]! : raw
  let record: Record<string, unknown> | null = null
  try {
    const value: unknown = JSON.parse(body)
    if (typeof value === "object" && value !== null && !Array.isArray(value)) record = value as Record<string, unknown>
  } catch { /* Plain text or a partial JSON line is displayed unchanged. */ }
  if (record && typeof record.level === "number" && typeof record.msg === "string") {
    const { time, level, msg, module, ...fields } = record
    return {
      time: timestamp(time) ?? journalTime,
      level: pinoLevels[level as number] ?? "unknown",
      module: typeof module === "string" ? module : null,
      message: msg as string,
      fields: { ...fields, ...(module !== undefined && typeof module !== "string" ? { module } : {}) },
      raw,
    }
  }
  // Recognize timestamped tracing output only; stderr and message keywords are not severity.
  const tracing = /^(\S+)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([A-Za-z_][\w:.-]*):\s?(.*)$/u.exec(body)
  if (tracing && timestamp(tracing[1]) !== null) return {
    time: timestamp(tracing[1]), level: tracing[2]!.toLowerCase() as LogLevel,
    module: tracing[3]!, message: tracing[4]!, fields: null, raw,
  }
  return { time: journalTime, level: "unknown", module: null, message: body, fields: record, raw }
}

export function serviceLogEntries(snapshot: ServiceLogsResponse): LogEntry[] {
  const entries = snapshot.streams.flatMap(stream => {
    const occurrences = new Map<string, number>()
    return stream.lines.map(raw => {
      const occurrence = (occurrences.get(raw) ?? 0) + 1
      occurrences.set(raw, occurrence)
      return { ...(stream.source === "journal" ? parseJournalLine(raw) : parseLogLine(raw)), source: stream.source, id: JSON.stringify([stream.source, raw, occurrence]) }
    })
  })
  // Keep undated source order so multiline plain errors are not reversed.
  return entries.sort((a, b) => a.time === null ? b.time === null ? 0 : 1 : b.time === null ? -1 : b.time - a.time)
}

function parseJournalLine(raw: string): ReturnType<typeof parseLogLine> {
  const entry: unknown = JSON.parse(raw)
  if (typeof entry !== "object" || entry === null || !("MESSAGE" in entry) || typeof entry.MESSAGE !== "string") {
    return { time: null, level: "unknown", module: null, message: raw, fields: null, raw }
  }
  const journal = entry as Record<string, unknown>
  const parsed = parseLogLine(entry.MESSAGE)
  const microseconds = typeof journal.__REALTIME_TIMESTAMP === "string" && /^\d{1,16}$/u.test(journal.__REALTIME_TIMESTAMP) ? Number(journal.__REALTIME_TIMESTAMP) : NaN
  const time = Number.isSafeInteger(microseconds) ? timestamp(microseconds / 1000) : null
  const identifier = [journal.SYSLOG_IDENTIFIER, journal._COMM].find(value => typeof value === "string" && value.trim())
  const priority = typeof journal.PRIORITY === "string" ? journalLevels[journal.PRIORITY] : undefined
  return { ...parsed, raw, time: parsed.time ?? time, level: parsed.level === "unknown" ? priority ?? "unknown" : parsed.level,
    module: parsed.module ?? (typeof identifier === "string" ? identifier : null),
    fields: { ...parsed.fields, journal: Object.fromEntries(Object.entries(journal).filter(([key]) => key !== "MESSAGE")) },
  }
}

export function filterLogEntries(entries: LogEntry[], level: LogLevelFilter, search: string): LogEntry[] {
  const needle = search.toLocaleLowerCase()
  return entries.filter(entry => (level === "all" || level === "problems"
    ? level === "all" || ["warn", "error", "fatal"].includes(entry.level)
    : entry.level === level) && entry.raw.toLocaleLowerCase().includes(needle))
}
