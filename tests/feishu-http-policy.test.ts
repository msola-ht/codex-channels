import { createServer } from "node:http";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppType, Client, defaultHttpInstance, type HttpInstance, type HttpRequestOptions } from "@larksuiteoapi/node-sdk";

import { applyFeishuHttpPolicy, createFeishuOAuthApi, FeishuMessageClient } from "../src/surfaces/feishu/client.js";
import { runFeishuSdkRequest } from "../src/surfaces/feishu/sdk-request-context.js";

afterEach(() => vi.restoreAllMocks());

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

  it("isolates concurrent generated SDK calls and blocks business HTTP after cancelled token acquisition", async () => {
    const tokens: Array<{ signal: AbortSignal; resolve(value: unknown): void }> = [];
    const request = vi.fn<(options: SignalOptions) => Promise<{ code: number; data: { message_id: string } }>>(
      async () => ({ code: 0, data: { message_id: "om_b" } }),
    );
    const sdk = sdkClient({
      post: (_url: string, _data: unknown, options: SignalOptions) => new Promise((resolve) => {
        tokens.push({ signal: options.signal, resolve });
      }),
      request,
    } as unknown as HttpInstance);
    const client = messageClient(sdk);
    const a = new AbortController();
    const b = new AbortController();
    const results = Promise.allSettled([
      client.sendText("oc_a", "a", a.signal),
      client.sendText("oc_b", "b", b.signal),
    ]);
    await tick();
    expect(tokens).toHaveLength(2);
    a.abort(new Error("PRIVATE cancellation"));
    expect(tokens[0]!.signal.aborted).toBe(true);
    expect(tokens[1]!.signal.aborted).toBe(false);
    tokens.forEach(({ resolve }) => resolve({ tenant_access_token: "fixture", expire: 3600 }));
    const settled = await results;
    expect(settled[0]).toMatchObject({ status: "rejected", reason: { name: "AbortError", message: "飞书输出操作已取消" } });
    expect(settled[1]).toMatchObject({ status: "fulfilled" });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toMatchObject({ data: { receive_id: "oc_b" }, signal: tokens[1]!.signal });
  });

  it.each(["token", "business"] as const)("cancels OAuth scope reads during SDK %s HTTP", async (stage) => {
    let signal!: AbortSignal;
    let complete!: (value: unknown) => void;
    const pending = new Promise((resolve) => { complete = resolve; });
    const post = vi.spyOn(defaultHttpInstance, "post").mockImplementation(async (_url, _data, options) => {
      if (stage === "token") { signal = (options as SignalOptions).signal; return pending as never; }
      return { tenant_access_token: "fixture", expire: 3600 } as never;
    });
    const request = vi.spyOn(defaultHttpInstance, "request").mockImplementation(async (options) => {
      signal = (options as SignalOptions).signal;
      return pending as never;
    });
    const api = createFeishuOAuthApi({ appId: stage === "token" ? "cli_1123456789abcdef" : "cli_2123456789abcdef", appSecret: "fixture" });
    const abort = new AbortController();
    const result = api.listGrantedUserScopes(abort.signal);
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError", message: "飞书输出操作已取消" });
    await tick();
    abort.abort(new Error("PRIVATE"));
    expect(signal.aborted).toBe(true);
    complete(stage === "token" ? { tenant_access_token: "fixture", expire: 3600 } : { code: 0, data: { app: { scopes: [] } } });
    await rejection;
    await tick();
    expect(post).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(stage === "business" ? 1 : 0);
  });

  it.each([
    ["token", "abort"], ["business", "abort"],
    ["token", "timeout"], ["business", "timeout"],
  ] as const)("interrupts a real Axios socket during %s on %s", async (stage, cause) => {
    let started!: () => void;
    let closed!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url!);
      const token = request.url!.includes("tenant_access_token");
      if (token && stage === "business") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ tenant_access_token: "fixture", expire: 3600 }));
        return;
      }
      request.socket.once("close", closed);
      started();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing loopback address");
    const localUrl = (url: string) => `http://127.0.0.1:${address.port}${new URL(url).pathname}`;
    const base = {
      post: (url: string, data: unknown, options: HttpRequestOptions<unknown>) => defaultHttpInstance.post(localUrl(url), data, options),
      request: (options: HttpRequestOptions<unknown>) => defaultHttpInstance.request({ ...options, url: localUrl(options.url!) }),
    } as unknown as HttpInstance;
    try {
      const client = messageClient(sdkClient(base), cause === "timeout" ? 500 : 2_000);
      const abort = new AbortController();
      const sending = client.sendText("oc_chat", "fixture", abort.signal);
      const rejection = expect(sending).rejects.toMatchObject(cause === "timeout"
        ? { code: "send-timeout" } : { name: "AbortError", message: "飞书输出操作已取消" });
      await requestStarted;
      if (cause === "abort") abort.abort(new Error("PRIVATE"));
      await rejection;
      await socketClosed;
      expect(paths).toHaveLength(stage === "token" ? 1 : 2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("merges explicit HTTP cancellation with invocation cancellation for every adapter method", async () => {
    const methods = ["request", "get", "delete", "head", "options", "post", "put", "patch"] as const;
    const explicit = new AbortController();
    const external = new AbortController();
    const signals: AbortSignal[] = [];
    const base = Object.fromEntries(methods.map((method) => [method, vi.fn(async (...args: unknown[]) => {
      signals.push((args.at(-1) as SignalOptions).signal);
      return {};
    })])) as unknown as HttpInstance;
    const http = applyFeishuHttpPolicy(base, 15_000);
    await runFeishuSdkRequest(async () => {
      for (const method of methods) {
        if (method === "request") await http.request({ signal: explicit.signal } as never);
        else if (method === "post" || method === "put" || method === "patch") await http[method]("fixture", {}, { signal: explicit.signal } as never);
        else await http[method]("fixture", { signal: explicit.signal } as never);
      }
    }, 1_000, new Error("deadline"), external.signal);
    expect(signals).toHaveLength(8);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    explicit.abort();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("keeps a successful Axios download stream readable after its request deadline has been cleared", async () => {
    let finish!: () => void;
    let signal!: AbortSignal;
    const server = createServer((_request, response) => {
      response.write("first");
      finish = () => response.end("second");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing loopback address");
    const http = applyFeishuHttpPolicy({ request: (options: SignalOptions) => {
      signal = options.signal;
      return defaultHttpInstance.request(options);
    } } as unknown as HttpInstance, 15_000, undefined, true);
    try {
      const stream = await runFeishuSdkRequest(() => http.request<Readable>({
        url: `http://127.0.0.1:${address.port}/download`, responseType: "stream",
      }), 200, new Error("download deadline"));
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(signal.aborted).toBe(false);
      finish();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("firstsecond");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

type SignalOptions = HttpRequestOptions<unknown> & { signal: AbortSignal };

function sdkClient(base: HttpInstance): Client {
  return new Client({
    appId: "cli_0123456789abcdef", appSecret: "fixture", appType: AppType.SelfBuild,
    logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} },
    cache: { async get() { return undefined; }, async set() { return true; } },
    httpInstance: applyFeishuHttpPolicy(base, 15_000, undefined, true),
  });
}

function messageClient(sdk: Client, sendTimeoutMs = 1_000): FeishuMessageClient {
  return new FeishuMessageClient({ appId: "cli_0123456789abcdef", appSecret: "fixture" }, {
    sendTimeoutMs,
    createSdkClient: () => ({
      createMessage: (payload) => sdk.im.v1.message.create(payload),
      patchMessage: (payload) => sdk.im.v1.message.patch(payload),
      downloadResource: (payload) => sdk.im.v1.messageResource.get(payload),
    }),
  });
}

async function tick(): Promise<void> { await new Promise((resolve) => setImmediate(resolve)); }
