import type { Dispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";

import {
  createProxyFetch,
  type ProxyFetchDependencies,
} from "../src/bootstrap/proxy-fetch.js";

type FetchWithDispatcher = NonNullable<
  ProxyFetchDependencies["fetchWithDispatcher"]
>;

describe("proxy-aware Fetch", () => {
  it("uses the shared target route and reuses its dispatcher", async () => {
    const directFetch = vi.fn<typeof fetch>();
    const response = new Response("ok");
    const fetchWithDispatcher = vi.fn<FetchWithDispatcher>(
      async () => response,
    );
    const dispatcher = {} as Dispatcher;
    const createDispatcher = vi.fn(() => dispatcher);
    const proxyFetch = createProxyFetch(
      { https: "http://127.0.0.1:7890" },
      {
        directFetch,
        fetchWithDispatcher,
        createDispatcher,
      },
    );

    await proxyFetch("https://ilinkai.weixin.qq.com/ilink/bot/getupdates");
    await proxyFetch(new URL("https://novac2c.cdn.weixin.qq.com/c2c/download"));

    expect(directFetch).not.toHaveBeenCalled();
    expect(createDispatcher).toHaveBeenCalledOnce();
    expect(createDispatcher).toHaveBeenCalledWith("http://127.0.0.1:7890/");
    expect(fetchWithDispatcher).toHaveBeenCalledTimes(2);
    expect(fetchWithDispatcher.mock.calls[0]?.[1]?.dispatcher).toBe(dispatcher);
    expect(fetchWithDispatcher.mock.calls[1]?.[1]?.dispatcher).toBe(dispatcher);
  });

  it("uses direct Fetch when the target matches NO_PROXY", async () => {
    const response = new Response("direct");
    const directFetch = vi.fn<typeof fetch>(async () => response);
    const fetchWithDispatcher = vi.fn<FetchWithDispatcher>(
      async () => new Response("proxy"),
    );
    const proxyFetch = createProxyFetch(
      {
        https: "http://127.0.0.1:7890",
        no: ".weixin.qq.com",
      },
      {
        directFetch,
        fetchWithDispatcher,
        createDispatcher: () => ({} as Dispatcher),
      },
    );

    await expect(proxyFetch(
      "https://novac2c.cdn.weixin.qq.com/c2c/download",
    )).resolves.toBe(response);
    expect(fetchWithDispatcher).not.toHaveBeenCalled();
  });
});
