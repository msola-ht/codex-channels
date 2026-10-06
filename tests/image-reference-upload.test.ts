import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { surfaceErrorMetadata } from "../src/surfaces/error-metadata.js";
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
  rejectRequest(id: number): void {
    this.emitMessage(JSON.stringify({ id, error: { code: -32600, message: "fixture submission rejection" } }));
  }
  accountChanged(): void { this.emitMessage(JSON.stringify({ method: "account/updated", params: {} })); }
  respondAccount(id: number): void { this.emitMessage(JSON.stringify({ id, result: this.accountResult })); }
}
const clients: CodexAppServerClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); vi.restoreAllMocks(); });
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
  it.each([502, 503, 504, "UND_ERR_CONNECT_TIMEOUT"])("replays only identical blob bytes after %s", async failure => {
    const { client, transport, fetchImpl, requests } = await fixture();
    const original = fetchImpl.getMockImplementation()!;
    const puts: RequestInit[] = [];
    fetchImpl.mockImplementation(async (url, init) => {
      if (init?.method === "PUT") {
        puts.push(init);
        if (puts.length === 1) {
          if (typeof failure === "string") throw new TypeError("secret", { cause: { code: failure } });
          return new Response(null, { status: failure, headers: { "x-ms-retry-after-ms": "0", "retry-after": "301" } });
        }
      }
      return original(url, init);
    });
    await client.startTurn("thread-1", input, "message", "/tmp");
    expect(puts).toHaveLength(2);
    expect(puts[0]!.body).toEqual(puts[1]!.body);
    expect(puts[0]!.signal).toBe(puts[1]!.signal);
    expect(new Headers(puts[0]!.headers).get("x-ms-client-request-id"))
      .not.toBe(new Headers(puts[1]!.headers).get("x-ms-client-request-id"));
    expect(puts.every(put => !new Headers(put.headers).has("authorization"))).toBe(true);
    expect(requests.filter(request => request.init.method === "POST")).toHaveLength(2);
    expect(transport.sent.filter(request => request.method === "turn/start")).toHaveLength(1);
  });

  it.each([403, 409, 429, 500, "CERT_HAS_EXPIRED"])("does not retry permanent blob failure %s", async failure => {
    const { client, fetchImpl } = await fixture();
    fetchImpl.mockResolvedValueOnce(Response.json({ file_id: "file_fixture", upload_url: "https://blob.example.test/image?signature=secret" }));
    if (typeof failure === "number") fetchImpl.mockResolvedValueOnce(new Response(null, { status: failure }));
    else fetchImpl.mockRejectedValueOnce(new TypeError("secret", { cause: { code: failure } }));
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({ code: "image.reference.failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["x-ms-retry-after-ms", "retry-after", "http-date"])("does not shorten server %s beyond the upload budget", async header => {
    const { client, fetchImpl } = await fixture();
    fetchImpl.mockResolvedValueOnce(Response.json({ file_id: "file_fixture", upload_url: "https://blob.example.test/image" }))
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: {
        [header === "http-date" ? "retry-after" : header]: header === "http-date" ? new Date(Date.now() + 310_000).toUTCString()
          : header === "retry-after" ? "301" : "301000",
      } }));
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({ details: { httpStatus: "503", attempt: "1" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses a shared five-minute blob budget and stops without finalize when it expires", async () => {
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 300_000 ? deadline.signal : timeout(ms));
    const { client, fetchImpl, transport } = await fixture();
    fetchImpl.mockResolvedValueOnce(Response.json({ file_id: "file_fixture", upload_url: "https://blob.example.test/image" }))
      .mockImplementationOnce(async () => { deadline.abort(new DOMException("secret", "TimeoutError")); throw new Error("secret"); });
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({
      message: "传输图片已超时，请稍后重新发送。", details: { reason: "timeout", attempt: "1" },
    });
    expect(spy).toHaveBeenCalledWith(300_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(transport.sent.some(request => request.method === "turn/start")).toBe(false);
  });

  it.each(["stop", "close", "account-change"])("cancels during blob retry backoff on %s without replay or finalize", async kind => {
    const { client, fetchImpl, transport } = await fixture();
    fetchImpl.mockResolvedValueOnce(Response.json({ file_id: "file_fixture", upload_url: "https://blob.example.test/image" }))
      .mockImplementationOnce(async () => {
        setTimeout(() => {
          if (kind === "stop") client.cancelPendingInput("thread-1");
          else if (kind === "close") void client.close();
          else { transport.token = "changed-token"; transport.accountChanged(); }
        }, 10);
        return new Response(null, { status: 503, headers: { "retry-after": "10" } });
      });
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({
      details: { reason: kind === "stop" ? "cancelled" : kind === "close" ? "disconnected" : "validation", attempt: "1" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not let the completed preparation deadline cancel blob transfer", async () => {
    const preparationDeadlines: AbortController[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      if (ms !== 60_000) return timeout(ms);
      const controller = new AbortController(); preparationDeadlines.push(controller); return controller.signal;
    });
    const { client, fetchImpl } = await fixture();
    const original = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, init) => {
      if (init?.method === "PUT") {
        preparationDeadlines.forEach(controller => controller.abort(new DOMException("expired", "TimeoutError")));
        expect(init.signal!.aborted).toBe(false);
      }
      return original(url, init);
    });
    await client.startTurn("thread-1", input, "message", "/tmp");
  });

  it("exhausts five transient HTTP attempts without creating another file or finalizing", async () => {
    const { client, fetchImpl, transport } = await fixture();
    fetchImpl.mockResolvedValueOnce(Response.json({ file_id: "file_fixture", upload_url: "https://blob.example.test/image" }))
      .mockResolvedValue(new Response(null, { status: 502, headers: { "retry-after": "0" } }));
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({ details: { attempt: "5", httpStatus: "502" } });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(transport.sent.some(request => request.method === "turn/start")).toBe(false);
  });

  it("does not cancel an account recheck when an already completed transfer deadline expires", async () => {
    const transferDeadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 300_000 ? transferDeadline.signal : timeout(ms));
    const { client, fetchImpl, transport } = await fixture();
    const send = transport.send.bind(transport);
    let holdAccount = false;
    let heldId: number | undefined;
    vi.spyOn(transport, "send").mockImplementation(async message => {
      const request = JSON.parse(message) as { id: number; method: string };
      if (holdAccount && request.method === "account/read") {
        holdAccount = false; heldId = request.id; return;
      }
      await send(message);
    });
    const original = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, init) => {
      if (init?.method === "PUT") {
        holdAccount = true; transport.accountChanged();
        await vi.waitFor(() => expect(heldId).toBeDefined());
      }
      if (String(url).endsWith("/uploaded")) {
        transferDeadline.abort(new DOMException("expired", "TimeoutError"));
        transport.respondAccount(heldId!);
      }
      return original(url, init);
    });
    await client.startTurn("thread-1", input, "message", "/tmp");
    expect(transport.sent.filter(request => request.method === "turn/start")).toHaveLength(1);
  });

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
    const rejected = expect(result).rejects.toMatchObject({ code: "image.reference.failed",
      details: { reason: kind === "stop" ? "cancelled" : kind === "close" ? "disconnected" : "validation",
        stage: kind.startsWith("account-") ? "account-recheck" : "file-create" },
    });
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


describe("image failure diagnostics", () => {
  it.each([
    ["UND_ERR_CONNECT_TIMEOUT", "建立连接超时"],
    ["UND_ERR_HEADERS_TIMEOUT", "等待响应头超时"],
    ["UND_ERR_BODY_TIMEOUT", "读取响应内容超时"],
  ])("distinguishes %s in the user-facing message", async (code, text) => {
    const { client, fetchImpl } = await fixture();
    fetchImpl.mockRejectedValueOnce(new TypeError("secret", { cause: { code } }));
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({
      message: `创建图片文件${text}；请检查网络或代理后重试。`,
    });
  });
  it.each(["model-route", "file-create", "file-transfer", "file-finalize"])("retains %s network failures without secrets and retries only blob transfer", async stage => {
    const { client, transport, fetchImpl, localFetch } = await fixture();
    const failure = new TypeError("https://blob.example.test/?signature=secret", {
      cause: Object.assign(new Error("Bearer fixture-access-token"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    });
    const original = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, init) => {
      const current = init?.method === "PUT" ? "file-transfer" : String(url).endsWith("/uploaded") ? "file-finalize" : "file-create";
      if (current === stage) throw failure;
      return original(url, init);
    });
    if (stage === "model-route") localFetch.mockRejectedValueOnce(failure);
    const error = await client.startTurn("thread-1", input, "message", "/tmp").catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "image.reference.failed", details: {
      stage, reason: "network-timeout", networkCode: "UND_ERR_CONNECT_TIMEOUT",
      elapsedMs: expect.stringMatching(/^\d+$/), stageElapsedMs: expect.stringMatching(/^\d+$/),
      diagnosticId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    } });
    expect(surfaceErrorMetadata(error)).toMatchObject({ imageUploadStage: stage, imageUploadNetworkCode: "UND_ERR_CONNECT_TIMEOUT" });
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toMatch(/secret|fixture-access-token/);
    expect(fetchImpl).toHaveBeenCalledTimes(stage === "file-transfer" ? 6 : ["model-route", "file-create", "file-transfer", "file-finalize"].indexOf(stage));
    if (stage === "file-transfer") expect(surfaceErrorMetadata(error)).toMatchObject({
      imageUploadHost: "blob.example.test", imageUploadAttempt: "5",
      imageUploadClientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(transport.sent.some(request => request.method === "turn/start")).toBe(false);
  });

  it.each([401, 403, 429, 503])("retains HTTP %s without response bodies", async status => {
    const { client, fetchImpl } = await fixture();
    fetchImpl.mockResolvedValueOnce(new Response("Bearer secret", { status }));
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({
      message: expect.stringContaining(`HTTP ${status}`),
      details: { stage: "file-create", reason: "http", httpStatus: String(status) },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["model-route", "file-transfer"])("does not blame Codex credentials for %s HTTP 401", async stage => {
    const { client, localFetch, fetchImpl } = await fixture();
    if (stage === "model-route") localFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    else fetchImpl.mockResolvedValueOnce(Response.json({ file_id: "file_fixture", upload_url: "https://blob.example.test/image" }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const error = await client.startTurn("thread-1", input, "message", "/tmp").catch((value: unknown) => value);
    expect(error).toMatchObject({ details: { stage, httpStatus: "401" } });
    expect((error as Error).message).not.toContain("登录");
  });

  it("classifies invalid JSON and never preserves its contents", async () => {
    const { client, fetchImpl } = await fixture();
    fetchImpl.mockResolvedValueOnce(new Response("secret invalid JSON"));
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({
      details: { stage: "file-create", reason: "invalid-response" },
      message: "创建图片文件失败：服务响应格式异常。",
    });
  });

  it("distinguishes the overall deadline from explicit cancellation", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const { client, fetchImpl } = await fixture();
    fetchImpl.mockImplementationOnce(async () => {
      deadline.abort(new DOMException("secret", "TimeoutError"));
      throw new Error("secret");
    });
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({
      message: "创建图片文件已超时，请稍后重新发送。", details: { reason: "timeout" },
    });
  });

  it("does not replace submission errors or submit again after dispatch", async () => {
    const { client, transport } = await fixture();
    const send = transport.send.bind(transport);
    vi.spyOn(transport, "send").mockImplementation(async message => {
      const request = JSON.parse(message) as { id: number; method: string };
      if (request.method !== "turn/start") return send(message);
      transport.sent.push(JSON.parse(message) as Record<string, unknown>);
      transport.rejectRequest(request.id);
    });
    await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({ code: -32600 });
    expect(transport.sent.filter(request => request.method === "turn/start")).toHaveLength(1);
  });
});


it.each(["ECONNRESET", "ENOTFOUND", "UNTRUSTED_SECRET_CODE"])("bounds network diagnostics for %s", async code => {
  const { client, fetchImpl } = await fixture();
  const cause = Object.assign(new Error("secret"), { code });
  cause.cause = cause;
  fetchImpl.mockRejectedValueOnce(new TypeError("secret", { cause }));
  const error = await client.startTurn("thread-1", input, "message", "/tmp").catch((value: unknown) => value);
  const known = code !== "UNTRUSTED_SECRET_CODE";
  expect(error).toMatchObject({ details: { stage: "file-create", reason: known ? "network" : "unknown" } });
  expect(surfaceErrorMetadata(error).imageUploadNetworkCode).toBe(known ? code : undefined);
  expect(JSON.stringify(error)).not.toContain("SECRET");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("retains HTTP rejection when discarding the response stream also fails", async () => {
  const { client, fetchImpl } = await fixture();
  const body = new ReadableStream<Uint8Array>({ cancel() { throw new Error("secret cleanup failure"); } });
  fetchImpl.mockResolvedValueOnce(new Response(body, { status: 403 }));
  await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({
    details: { stage: "file-create", reason: "http", httpStatus: "403" },
  });
});


it.each([
  { label: "array", response: [] },
  { label: "null", response: null },
  { label: "primitive", response: "secret" },
  { label: "missing fields", response: {} },
  { label: "invalid file ID", response: { file_id: "secret invalid", upload_url: "https://blob.example.test/image" } },
  { label: "invalid URL", response: { file_id: "file_fixture", upload_url: "secret-invalid-url" } },
  { label: "unsafe scheme", response: { file_id: "file_fixture", upload_url: "http://blob.example.test/secret" } },
  { label: "URL credentials", response: { file_id: "file_fixture", upload_url: "https://secret@blob.example.test/image" } },
  { label: "URL fragment", response: { file_id: "file_fixture", upload_url: "https://blob.example.test/image#secret" } },
])("classifies malformed creation response: $label", async ({ response }) => {
  const { client, transport, fetchImpl } = await fixture();
  fetchImpl.mockResolvedValueOnce(Response.json(response));
  const error = await client.startTurn("thread-1", input, "message", "/tmp").catch((value: unknown) => value);
  expect(error).toMatchObject({ code: "image.reference.failed", details: { stage: "file-create", reason: "invalid-response" } });
  expect(surfaceErrorMetadata(error)).toMatchObject({ imageUploadStage: "file-create", imageUploadReason: "invalid-response" });
  expect((error as Error).cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain("secret");
  expect(JSON.stringify(surfaceErrorMetadata(error))).not.toContain("secret");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(transport.sent.some(request => request.method === "turn/start")).toBe(false);
});

it.each([{}, { status: "success" }, { status: "secret" }])("classifies malformed finalization response: %j", async response => {
  const { client, transport, fetchImpl } = await fixture();
  fetchImpl.mockResolvedValueOnce(Response.json({ file_id: "file_fixture", upload_url: "https://blob.example.test/image" }))
    .mockResolvedValueOnce(new Response(null, { status: 201 }))
    .mockResolvedValueOnce(Response.json(response));
  const error = await client.startTurn("thread-1", input, "message", "/tmp").catch((value: unknown) => value);
  expect(error).toMatchObject({ details: { stage: "file-finalize", reason: "invalid-response" } });
  expect(JSON.stringify(error)).not.toContain("secret");
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(transport.sent.some(request => request.method === "turn/start")).toBe(false);
});

it("classifies malformed local route attestations before uploading", async () => {
  const { client, transport, localFetch, fetchImpl } = await fixture();
  localFetch.mockResolvedValueOnce(Response.json({ supported: "secret" }));
  await expect(client.startTurn("thread-1", input, "message", "/tmp")).rejects.toMatchObject({
    details: { stage: "model-route", reason: "invalid-response" },
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(transport.sent.some(request => request.method === "turn/start")).toBe(false);
});
