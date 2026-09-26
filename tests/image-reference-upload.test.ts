import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { FakeTransport } from "./support/json-rpc-fixtures.js";

const route = { chatgptAccountId: "fixture-account", backendOrigin: "https://chatgpt.com", accountRoutingOverride: "NO_CONSTRAINT" };
const input = [{ type: "image" as const, url: "data:image/png;base64,AQID" }];
class ImageTransport extends FakeTransport {
  token = "fixture-access-token";
  baseUrl = "http://127.0.0.1:54321";
  override async send(message: string): Promise<void> {
    const request = JSON.parse(message) as { id?: number; method?: string };
    if (request.method === "config/read") {
      this.sent.push(JSON.parse(message) as Record<string, unknown>);
      this.emitMessage(JSON.stringify({ id: request.id, result: { config: { openai_base_url: this.baseUrl }, origins: {}, layers: null } }));
      return;
    }
    if (request.method !== "getAuthStatus") return super.send(message);
    this.sent.push(JSON.parse(message) as Record<string, unknown>);
    this.emitMessage(JSON.stringify({ id: request.id, result: {
      authMethod: "chatgpt", authToken: this.token, requiresOpenaiAuth: true,
    } }));
  }
  accountChanged(): void { this.emitMessage(JSON.stringify({ method: "account/updated", params: {} })); }
}
const clients: CodexAppServerClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });
async function fixture() {
  const transport = new ImageTransport();
  transport.accountResult = { account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true, workspaceRouting: { ...route } };
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    requests.push({ url: String(url), init: init! });
    if (String(url).endsWith("/uploaded")) return Response.json({ status: "success", download_url: "https://blob.example.test/download" });
    if (init?.method === "PUT") return new Response(null, { status: 201 });
    return Response.json({ file_id: "file_fixture", upload_url: "https://blob.example.test/image?signature=secret" });
  });
  const localFetch = vi.fn<typeof fetch>(async () => Response.json({ supported: true, backendOrigin: "https://chatgpt.com" }));
  const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" }, { upload: fetchImpl, local: localFetch });
  clients.push(client);
  await client.connect();
  return { client, transport, fetchImpl, localFetch, requests };
}

describe("official image reference upload", () => {
  it.each(["start", "steer"])("uploads using current routing and submits a fileId through %s", async mode => {
    const { client, transport, requests } = await fixture();
    if (mode === "start") await client.startTurn("thread-1", input, "message", "/tmp");
    else await client.steerTurn("thread-1", "turn-1", input, "message");
    expect(requests.map(request => request.url)).toEqual([
      "https://chatgpt.com/backend-api/files",
      "https://blob.example.test/image?signature=secret",
      "https://chatgpt.com/backend-api/files/file_fixture/uploaded",
    ]);
    expect(requests[0]!.init.headers).toMatchObject({ authorization: "Bearer fixture-access-token",
      "chatgpt-account-id": route.chatgptAccountId });
    expect(new Headers(requests[0]!.init.headers).has("x-openai-account-routing-override")).toBe(false);
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({ file_name: "image.png", file_size: 3, use_case: "codex" });
    expect(new Headers(requests[1]!.init.headers).has("authorization")).toBe(false);
    expect(new Headers(requests[1]!.init.headers).has("chatgpt-account-id")).toBe(false);
    expect([...requests[1]!.init.body as Uint8Array]).toEqual([1, 2, 3]);
    expect(requests.every(request => request.init.redirect === "error")).toBe(true);
    const sent = transport.sent.find(request => request.method === `turn/${mode}`)!;
    expect(sent.params).toMatchObject({ input: [{ type: "image", fileId: "file_fixture" }] });
    const count = requests.length;
    await client.startTurn("thread-1", [{ type: "text", text: "继续" }], "followup", "/tmp");
    expect(requests).toHaveLength(count);
  });

  it.each(["start", "steer"])("cancels %s during preparation without dispatching a write", async mode => {
    const { client, transport, fetchImpl } = await fixture();
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    fetchImpl.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("cancelled upload")), { once: true });
      started();
    }));
    const submitting = mode === "start"
      ? client.startTurn("thread-1", input, "message", "/tmp", undefined, controller.signal)
      : client.steerTurn("thread-1", "turn-1", input, "message", controller.signal);
    const rejected = expect(submitting).rejects.toBeDefined();
    await ready;
    controller.abort();
    await rejected;
    expect(transport.sent.some(request => request.method === `turn/${mode}`)).toBe(false);
  });

  it.each(["api", "third-party", "text"])("keeps %s on its existing path", async kind => {
    const { client, transport, fetchImpl } = await fixture();
    if (kind === "api") transport.accountResult = { account: { type: "apiKey" }, requiresOpenaiAuth: true, workspaceRouting: null };
    if (kind === "third-party") transport.threadReadData.modelProvider = "third-party";
    await client.startTurn("thread-1", kind === "text" ? [{ type: "text", text: "hello" }] : input, "message", "/tmp");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["missing-route", "changed-account", "changed-token", "upload-error", "unsafe-url"])("fails closed on %s without sending a Turn", async kind => {
    const { client, transport, fetchImpl } = await fixture();
    if (kind === "missing-route") transport.accountResult.workspaceRouting = null;
    if (kind === "unsafe-url") fetchImpl.mockResolvedValueOnce(Response.json({ file_id: "file_fixture", upload_url: "http://localhost/image" }));
    if (kind === "upload-error") fetchImpl.mockResolvedValueOnce(new Response("secret backend data", { status: 403 }));
    if (kind === "changed-account" || kind === "changed-token") {
      fetchImpl.mockImplementationOnce(async () => {
        if (kind === "changed-token") transport.token = "changed-token";
        else transport.accountResult.workspaceRouting = { ...route, chatgptAccountId: "another-account" };
        return Response.json({ file_id: "file_fixture", upload_url: "https://blob.example.test/image" });
      });
    }
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({ code: "image.reference.failed" });
    expect(transport.sent.some(request => request.method === "turn/start")).toBe(false);
    if (kind === "upload-error") expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "close", "account-change", "account-check-fails"])("cancels an upload on %s", async kind => {
    const { client, transport, fetchImpl } = await fixture();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    fetchImpl.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("sensitive transport error")), { once: true });
      ready();
    }));
    const result = client.startTurn("thread-1", input, "message", "/tmp");
    const rejected = expect(result).rejects.toMatchObject({ code: "image.reference.failed" });
    await started;
    if (kind === "stop") expect(client.cancelPendingInput("thread-1")).toBe(true);
    else if (kind === "close") await client.close();
    else {
      transport.accountResult.workspaceRouting = kind === "account-check-fails" ? null : { ...route, chatgptAccountId: "another-account" };
      transport.accountChanged();
    }
    await rejected;
    expect(transport.sent.some(request => request.method === "turn/start")).toBe(false);
    expect(client.cancelPendingInput("thread-1")).toBe(false);
  });

  it.each(["initialization", "same-account"])("preserves uploads on %s notifications", async kind => {
    const { client, transport, fetchImpl } = await fixture();
    if (kind === "initialization") {
      const send = transport.send.bind(transport);
      let first = true;
      vi.spyOn(transport, "send").mockImplementation(async message => {
        if (first && message.includes("account/read")) {
          first = false;
          transport.accountChanged();
        }
        await send(message);
      });
    } else {
      fetchImpl.mockImplementationOnce(async () => {
        transport.accountChanged();
        transport.accountChanged();
        return Response.json({ file_id: "file_fixture", upload_url: "https://blob.example.test/image" });
      });
    }
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).resolves.toEqual({ turnId: "turn-1" });
    expect(transport.sent.find(request => request.method === "turn/start")?.params).toMatchObject({
      input: [{ type: "image", fileId: "file_fixture" }],
    });
  });

  it.each(["independent-proxy", "direct-endpoint"])("keeps %s images inline without uploading", async kind => {
    const { client, transport, fetchImpl, localFetch } = await fixture();
    if (kind === "direct-endpoint") transport.baseUrl = "https://independent.example.test/v1";
    else localFetch.mockResolvedValue(Response.json({ supported: false, backendOrigin: null }));
    await client.startTurn("thread-1", input, "message", "/tmp");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(transport.sent.some(request => request.method === "getAuthStatus")).toBe(false);
    expect(transport.sent.find(request => request.method === "turn/start")?.params).toMatchObject({ input });
  });

  it.each(["us", "us_cr"])("rejects %s constraints before reading credentials or uploading", async accountRoutingOverride => {
    const { client, transport, fetchImpl } = await fixture();
    transport.accountResult.workspaceRouting = { ...route, accountRoutingOverride };
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({
      code: "image.reference.failed", message: expect.stringContaining("区域路由约束"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(transport.sent.some(request => request.method === "getAuthStatus" || request.method === "turn/start")).toBe(false);
  });

  it("rejects a routing constraint introduced during upload", async () => {
    const { client, transport, fetchImpl } = await fixture();
    fetchImpl.mockImplementationOnce(async () => {
      transport.accountResult.workspaceRouting = { ...route, accountRoutingOverride: "us" };
      return Response.json({ file_id: "file_fixture", upload_url: "https://blob.example.test/image" });
    });
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({ code: "image.reference.failed" });
    expect(transport.sent.some(request => request.method === "turn/start")).toBe(false);
  });

  it.each(["regional-mismatch", "unknown-proxy", "route-change"])("fails closed on %s", async kind => {
    const { client, transport, fetchImpl, localFetch } = await fixture();
    if (kind === "regional-mismatch") transport.accountResult.workspaceRouting = { ...route, backendOrigin: "https://gov.chatgpt.com" };
    if (kind === "unknown-proxy") localFetch.mockResolvedValue(new Response(null, { status: 404 }));
    if (kind === "route-change") localFetch.mockResolvedValueOnce(Response.json({ supported: true, backendOrigin: "https://chatgpt.com" }))
      .mockResolvedValueOnce(Response.json({ supported: false, backendOrigin: null }));
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({ code: "image.reference.failed" });
    expect(transport.sent.some(request => request.method === "turn/start")).toBe(false);
    if (kind !== "route-change") expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds concurrent uploads and cancels all of them on close", async () => {
    const { client, fetchImpl } = await fixture();
    let count = 0;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    fetchImpl.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      if (++count === 4) ready();
    }));
    const pending = [0, 1, 2, 3].map(id => client.startTurn(`thread-${id}`, input, "message", "/tmp"));
    const rejected = pending.map(result => expect(result).rejects.toMatchObject({ code: "image.reference.failed" }));
    await started;
    await expect(client.startTurn("thread-4", input, "message", "/tmp")).rejects.toMatchObject({ code: "image.reference.failed" });
    await expect(client.startTurn("thread-0", input, "duplicate", "/tmp")).rejects.toMatchObject({ code: "image.reference.failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await client.close();
    await Promise.all(rejected);
  });

  it("rejects oversized backend responses without leaking their contents", async () => {
    const { client, fetchImpl } = await fixture();
    fetchImpl.mockResolvedValueOnce(new Response("sensitive".repeat(10_000)));
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({
      code: "image.reference.failed", message: "图片上传服务响应过大。",
    });
  });

  it("polls only an explicit finalize retry and never retries file creation", async () => {
    const { client, fetchImpl } = await fixture();
    fetchImpl.mockResolvedValueOnce(Response.json({ file_id: "file_fixture", upload_url: "https://blob.example.test/image" }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ status: "retry" }));
    await client.startTurn("thread-1", input, "message", "/tmp");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
