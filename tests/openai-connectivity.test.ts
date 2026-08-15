import { describe, expect, it, vi } from "vitest";

import { checkOpenAiConnectivity } from "../src/bootstrap/openai-connectivity.js";

describe("OpenAI startup connectivity", () => {
  it("treats any HTTP response from both official targets as reachable", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));

    await expect(checkOpenAiConnectivity({
      proxy: {},
      fetchImpl,
    })).resolves.toBe("reachable");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({ method: "HEAD", redirect: "manual" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("reports partial and unreachable transport failures", async () => {
    const partialFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockRejectedValueOnce(new Error("network unavailable"));
    const unavailableFetch = vi.fn<typeof fetch>()
      .mockRejectedValue(new Error("network unavailable"));

    await expect(checkOpenAiConnectivity({
      proxy: {},
      fetchImpl: partialFetch,
    })).resolves.toBe("partial");
    await expect(checkOpenAiConnectivity({
      proxy: {},
      fetchImpl: unavailableFetch,
    })).resolves.toBe("unreachable");
  });

  it("only probes a configured OpenAI base URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401 }));

    await expect(checkOpenAiConnectivity({
      proxy: {},
      baseUrl: "https://regional.example.test/codex",
      fetchImpl,
    })).resolves.toBe("reachable");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://regional.example.test/codex",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("aborts a probe after its bounded timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })
    );

    await expect(checkOpenAiConnectivity({
      proxy: {},
      baseUrl: "https://unreachable.example.test",
      fetchImpl,
      timeoutMs: 5,
    })).resolves.toBe("unreachable");
  });
});
