import { describe, expect, it, vi } from "vitest";

import { checkOpenAiConnectivity } from "../src/bootstrap/openai-connectivity.js";

describe("OpenAI startup connectivity", () => {
  it.each(["api", "chatgpt"] as const)("rejects missing and unexpected inference routes for %s", async (route) => {
    for (const status of [302, 404, 429, 500]) {
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) =>
        new Response(null, { status: init?.method === "HEAD" ? status : 200 }));
      await expect(checkOpenAiConnectivity({ proxy: {}, route, fetchImpl }))
        .resolves.toBe(status === 404 ? "invalid-base-url" : "route-warning");
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });
  it.each(["chatgpt", "api"] as const)("reports a failing inference endpoint on the %s route", async (route) => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) =>
      new Response(null, { status: init?.method === "HEAD" ? 503 : 200 }));
    await expect(checkOpenAiConnectivity({ proxy: {}, route, fetchImpl }))
      .resolves.toBe("route-warning");
  });

  it.each([401, 403, 405])("accepts an unauthenticated HEAD response with status %s", async (status) => {
    await expect(checkOpenAiConnectivity({
      proxy: {}, route: "chatgpt",
      fetchImpl: async () => new Response(null, { status }),
    })).resolves.toBe("reachable");
  });

  it("does not start requests after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("shutdown"));
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(checkOpenAiConnectivity({
      proxy: {}, route: "chatgpt", fetchImpl, signal: controller.signal,
    })).rejects.toThrow("shutdown");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cancels retry backoff without sending another request", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const pending = checkOpenAiConnectivity({
      proxy: {}, route: "chatgpt", fetchImpl, signal: controller.signal,
      retryDelaysMs: [10_000], deadlineMs: 20_000,
    });
    const rejected = expect(pending).rejects.toThrow("shutdown");
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("shutdown"));
    await rejected;
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("probes only the active ChatGPT inference route", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(checkOpenAiConnectivity({
      proxy: {},
      route: "chatgpt",
      fetchImpl,
    })).resolves.toBe("reachable");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses",
      expect.objectContaining({ method: "HEAD", redirect: "manual" }),
    );
  });

  it("checks the API models route and distinguishes a wrong base path", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(checkOpenAiConnectivity({
      proxy: {},
      route: "api",
      fetchImpl,
    })).resolves.toBe("invalid-base-url");

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["https://api.openai.com/v1/responses", "HEAD"],
      ["https://api.openai.com/v1/models", "GET"],
    ]);
  });

  it("probes the inference and models routes below a configured base URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));

    await expect(checkOpenAiConnectivity({
      proxy: {},
      route: "api",
      baseUrl: "https://regional.example.test/codex",
      fetchImpl,
    })).resolves.toBe("reachable");

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["https://regional.example.test/codex/responses", "HEAD"],
      ["https://regional.example.test/codex/models", "GET"],
    ]);
  });

  it("reports a reachable API route with an unexpected models response", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    await expect(checkOpenAiConnectivity({
      proxy: {},
      route: "api",
      fetchImpl,
    })).resolves.toBe("route-warning");
  });

  it("retries transport failures so a late proxy listener can recover", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("proxy is starting"))
      .mockRejectedValueOnce(new Error("proxy is starting"))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(checkOpenAiConnectivity({
      proxy: {},
      route: "chatgpt",
      fetchImpl,
      retryDelaysMs: [1, 1],
      deadlineMs: 100,
    })).resolves.toBe("reachable");

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("aborts a probe after its bounded timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })
    );

    await expect(checkOpenAiConnectivity({
      proxy: {},
      route: "chatgpt",
      baseUrl: "https://unreachable.example.test",
      fetchImpl,
      timeoutMs: 5,
      retryDelaysMs: [],
    })).resolves.toBe("unreachable");
  });
});
