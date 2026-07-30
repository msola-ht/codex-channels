import { describe, expect, it, vi } from "vitest";

import {
  withWeixinRequestAbort,
} from "../src/surfaces/weixin/request-abort.js";

describe("withWeixinRequestAbort", () => {
  it("distinguishes timeout, external cancellation and network abort", async () => {
    await expect(withWeixinRequestAbort(
      { timeoutMs: 1 },
      abortableRequest,
    )).rejects.toMatchObject({ reason: "timeout" });

    const controller = new AbortController();
    const cancelled = withWeixinRequestAbort(
      { timeoutMs: 1_000, signal: controller.signal },
      abortableRequest,
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ reason: "aborted" });

    await expect(withWeixinRequestAbort(
      { timeoutMs: 1_000 },
      async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    )).rejects.toMatchObject({ reason: "network-abort" });
  });

  it("preserves non-abort failures", async () => {
    const failure = new Error("request failed");
    await expect(withWeixinRequestAbort(
      { timeoutMs: 1_000 },
      async () => {
        throw failure;
      },
    )).rejects.toBe(failure);
  });

  it("does not start a request after prior cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(abortableRequest);
    await expect(withWeixinRequestAbort(
      { timeoutMs: 1_000, signal: controller.signal },
      request,
    )).rejects.toMatchObject({ reason: "aborted" });
    expect(request).not.toHaveBeenCalled();
  });
});

function abortableRequest(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
