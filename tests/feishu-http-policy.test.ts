import { describe, expect, it, vi } from "vitest";
import type { HttpInstance } from "@larksuiteoapi/node-sdk";

import { applyFeishuHttpPolicy } from "../src/surfaces/feishu/client.js";

describe("Feishu HTTP policy", () => {
  it("applies timeout, cancellation, and the selected proxy agent", async () => {
    const request = vi.fn<(options: unknown) => Promise<unknown>>(async () => ({}));
    const agent = {};
    const signal = new AbortController().signal;
    const http = applyFeishuHttpPolicy(
      { request } as unknown as HttpInstance,
      15_000,
      agent,
    );

    await http.request({
      url: "https://open.feishu.cn/open-apis/test",
      method: "GET",
      signal,
    } as never);

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      timeout: 15_000,
      signal,
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
    }));
  });

  it("disables Axios environment proxy discovery for an explicit direct route", async () => {
    const request = vi.fn<(options: unknown) => Promise<unknown>>(async () => ({}));
    const http = applyFeishuHttpPolicy(
      { request } as unknown as HttpInstance,
      15_000,
      undefined,
      true,
    );

    await http.request({
      url: "https://open.feishu.cn/open-apis/test",
      method: "GET",
    } as never);

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      timeout: 15_000,
      proxy: false,
    }));
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty("httpAgent");
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty("httpsAgent");
  });
});
