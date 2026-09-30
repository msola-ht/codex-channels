import type { TrafficDumpSession, TrafficDumpStorage, TrafficPayloadPart } from "./traffic-dump-storage.js";

const sensitive = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access_token|refresh_token|token|secret|credential|signature)$/iu;
export function redactRelayValue(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => sensitive.test(key) ? "[REDACTED]" : item);
}

/** Shared bounded JSON/SSE payload for upstream and client-delivery capture. */
export class RelayDumpPayload {
  private readonly parts: TrafficPayloadPart[] = [];
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  bytes = 0;
  truncated = false;
  constructor(private readonly storage: TrafficDumpStorage, private readonly session: TrafficDumpSession, private readonly limit: number) {}
  value(value: unknown, stream: boolean): void {
    this.append(Buffer.from(value === undefined ? "data: [DONE]\n\n" : stream ? `data: ${redactRelayValue(value)}\n\n` : redactRelayValue(value)));
  }
  invalid(bytes: number): void { this.bytes += bytes; this.truncated = true; }
  private append(content: Buffer): void {
    this.bytes += content.length;
    if (this.truncated || this.bytes > this.limit) { this.truncated = true; return; }
    this.pending.push(content); this.pendingBytes += content.length;
    if (this.pendingBytes >= 32 * 1024) this.flush();
  }
  private flush(): void {
    if (!this.pendingBytes) return;
    const content = Buffer.concat(this.pending, this.pendingBytes); this.discard();
    const part = this.storage.writePayload(this.session, content, "utf8");
    if (!part) return;
    const previous = this.parts.at(-1);
    if (previous && previous.file === part.file && previous.offset + previous.bytes === part.offset) previous.bytes += part.bytes;
    else this.parts.push(part);
  }
  finish(): { bytes: number; parts: TrafficPayloadPart[]; truncated: boolean } {
    this.flush();
    return { bytes: this.parts.reduce((sum, part) => sum + part.bytes, 0), parts: this.parts, truncated: this.truncated };
  }
  discard(): void { this.pending = []; this.pendingBytes = 0; }
}
