import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketBackpressure } from "../src/provider-proxy/websocket-backpressure.js";

afterEach(() => vi.useRealTimers());

describe("WebSocket forwarding backpressure", () => {
  function fixture(timeout = 50) {
    const source = { readyState: WebSocket.OPEN, pause: vi.fn(), resume: vi.fn() };
    const fail = vi.fn();
    const pressure = new WebSocketBackpressure(source as unknown as WebSocket, timeout, fail);
    return { pressure, source, fail };
  }

  it("pauses a slow receiver and resumes only below the low watermark", () => {
    const { pressure, source } = fixture();
    const release1 = pressure.reserve(Buffer.alloc(700_000))!;
    const release2 = pressure.reserve(Buffer.alloc(700_000))!;
    expect(source.pause).toHaveBeenCalledOnce();
    release1();
    expect(source.resume).not.toHaveBeenCalled();
    release2();
    expect(source.resume).toHaveBeenCalledOnce();
    pressure.close();
  });

  it("keeps reading paused while metrics or handshake acknowledgement is pending", () => {
    const { pressure, source } = fixture();
    const releaseFrame = pressure.reserve(Buffer.from("frame"))!;
    const releaseHold = pressure.hold();
    releaseFrame();
    expect(source.resume).not.toHaveBeenCalled();
    releaseHold();
    expect(source.resume).toHaveBeenCalledOnce();
    pressure.close();
  });

  it("bounds frames already decoded from one buffered network read", () => {
    const { pressure, fail } = fixture();
    for (let index = 0; index < 4096; index++) expect(pressure.reserve(Buffer.alloc(0))).toBeTypeOf("function");
    expect(pressure.reserve(Buffer.alloc(0))).toBeUndefined();
    expect(fail).toHaveBeenCalledOnce();
  });

  it("bounds pending bytes even when the first frame is large", () => {
    const { pressure, fail } = fixture();
    const buffer = Buffer.alloc(1_048_576);
    for (let index = 0; index < 128; index++) expect(pressure.reserve(buffer)).toBeTypeOf("function");
    expect(pressure.reserve(buffer)).toBeUndefined();
    expect(fail).toHaveBeenCalledOnce();
  });

  it("ends a stalled send but does not impose a total duration on a progressing stream", async () => {
    vi.useFakeTimers();
    const { pressure, fail } = fixture();
    const first = pressure.reserve(Buffer.from("one"))!;
    await vi.advanceTimersByTimeAsync(40);
    pressure.reserve(Buffer.from("two"));
    first();
    await vi.advanceTimersByTimeAsync(40);
    expect(fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(fail).toHaveBeenCalledOnce();
  });

  it("cancels deadlines and ignores late callbacks after close", async () => {
    vi.useFakeTimers();
    const { pressure, fail, source } = fixture();
    const release = pressure.reserve(Buffer.alloc(1_048_576))!;
    pressure.close();
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(fail).not.toHaveBeenCalled();
    expect(source.resume).not.toHaveBeenCalled();
  });
});
