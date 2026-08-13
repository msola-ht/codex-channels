import { describe, expect, it, vi } from "vitest";

import { readBoundedFetchBody } from "../src/bootstrap/bounded-fetch-body.js";

const errors = {
  invalidContentLength: () => new Error("invalid length"),
  tooLarge: () => new Error("too large"),
  missingBody: () => new Error("missing body"),
};

describe("readBoundedFetchBody", () => {
  it("returns one bounded response body", async () => {
    const response = new Response("hello", {
      headers: { "content-length": "5" },
    });

    await expect(readBoundedFetchBody(response, 5, errors))
      .resolves.toEqual(Buffer.from("hello"));
  });

  it("rejects invalid and excessive declared lengths", async () => {
    const invalidLengthCancel = vi.fn();
    const invalidLengthResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("x"));
      },
      cancel: invalidLengthCancel,
    }), {
      headers: { "content-length": "invalid" },
    });
    await expect(readBoundedFetchBody(invalidLengthResponse, 5, errors))
      .rejects.toThrow("invalid length");
    expect(invalidLengthCancel).toHaveBeenCalledOnce();

    await expect(readBoundedFetchBody(new Response("hello!", {
      headers: { "content-length": "6" },
    }), 5, errors)).rejects.toThrow("too large");
  });

  it("cancels a streaming response that exceeds the limit", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("hello!"));
      },
      cancel,
    }));

    await expect(readBoundedFetchBody(response, 5, errors)).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("distinguishes an optional empty body from a required body", async () => {
    const optional = new Response(null);
    await expect(readBoundedFetchBody(optional, 5, {
      invalidContentLength: errors.invalidContentLength,
      tooLarge: errors.tooLarge,
    })).resolves.toEqual(Buffer.alloc(0));

    await expect(readBoundedFetchBody(new Response(null), 5, errors))
      .rejects.toThrow("missing body");
  });
});
