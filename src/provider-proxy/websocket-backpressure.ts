import type { RawData } from "ws";
import WebSocket from "ws";

const highWaterBytes = 1_048_576;
const lowWaterBytes = 262_144;
const maximumPendingBytes = 128 * 1_048_576;
const maximumPendingFrames = 4_096;

/** Accounts for both application-held frames and frames awaiting the ws send callback. */
export class WebSocketBackpressure {
  private bytes = 0;
  private frames = 0;
  private holds = 0;
  private paused = false;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly source: WebSocket,
    private readonly timeoutMs: number,
    private readonly fail: (error: Error) => void,
  ) {}

  reserve(data: RawData): (() => void) | undefined {
    if (this.closed) return undefined;
    const bytes = Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength;
    if (this.bytes + bytes > maximumPendingBytes || this.frames >= maximumPendingFrames) {
      this.close();
      this.fail(new Error("WebSocket 转发积压超过上限"));
      return undefined;
    }
    this.bytes += bytes;
    this.frames++;
    this.updateReading();
    if (!this.timer) this.armTimeout();
    let released = false;
    return () => {
      if (released || this.closed) return;
      released = true;
      this.bytes -= bytes;
      this.frames--;
      clearTimeout(this.timer);
      this.timer = undefined;
      if (this.frames > 0) this.armTimeout();
      this.updateReading();
    };
  }

  hold(): () => void {
    this.holds++;
    this.updateReading();
    let released = false;
    return () => {
      if (released || this.closed) return;
      released = true;
      this.holds--;
      this.updateReading();
    };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.bytes = 0;
    this.frames = 0;
  }

  private armTimeout(): void {
    this.timer = setTimeout(() => {
      this.close();
      this.fail(new Error("WebSocket 转发等待超时"));
    }, this.timeoutMs);
    this.timer.unref();
  }

  private updateReading(): void {
    if (this.closed) return;
    if (!this.paused && (this.holds > 0 || this.bytes >= highWaterBytes || this.frames >= 64)) {
      this.paused = true;
      this.source.pause();
    } else if (this.paused && this.holds === 0 && this.bytes <= lowWaterBytes && this.frames <= 16) {
      this.paused = false;
      if (this.source.readyState === WebSocket.OPEN) this.source.resume();
    }
  }
}
