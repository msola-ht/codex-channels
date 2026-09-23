import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { ConfigReadResponse, GetAccountResponse, GetAuthStatusResponse, ThreadReadResponse, UserInput } from "../codex-protocol/index.js";
import { UserFacingError } from "../conversation-core/index.js";
import type { JsonRpcClient } from "./json-rpc.js";

/** Uploads only caller-supplied images; subsequent history belongs to App Server. */
export class ImageReferenceUpload {
  private readonly pending = new Map<string, PendingUpload>();

  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly fetchImpl: typeof fetch,
    private readonly localFetch: typeof fetch,
    private readonly readAuth: (signal: AbortSignal) => Promise<GetAuthStatusResponse>,
  ) {
    rpc.onDisconnect(() => this.cancelAll());
    rpc.onNotification(notification => {
      if (notification.method === "account/updated") {
        for (const pending of this.pending.values()) this.recheck(pending);
      }
    });
  }

  cancel(threadId: string): boolean {
    const pending = this.pending.get(threadId);
    pending?.controller.abort();
    return pending !== undefined;
  }

  cancelAll(): void {
    for (const pending of this.pending.values()) pending.controller.abort();
  }

  async submit<T>(threadId: string, input: UserInput[], submit: (input: UserInput[]) => Promise<T>): Promise<T> {
    if (this.pending.has(threadId) || this.pending.size >= 4) {
      throw failure("图片上传繁忙，请稍后重试。");
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    const pending: PendingUpload = { controller, signal, dirty: false };
    this.pending.set(threadId, pending);
    let dispatched = false;
    const dispatch = (prepared: UserInput[]) => {
      signal.throwIfAborted();
      this.pending.delete(threadId);
      dispatched = true;
      // Once dispatched, a write must receive its result; aborting the local RPC
      // would not cancel the server Turn. turn/interrupt owns that phase.
      return submit(prepared);
    };
    try {
      const thread = await this.rpc.request<ThreadReadResponse>({ method: "thread/read", params: { threadId, includeTurns: false } },
        { retryOverload: true, signal });
      if (thread.thread.modelProvider !== "openai") return await dispatch(input);
      const modelRoute = await this.modelRoute(thread.thread.cwd, signal);
      if (modelRoute === null) return await dispatch(input);
      const account = await this.account(signal);
      if (account.account?.type === "apiKey" || !account.requiresOpenaiAuth) {
        return await dispatch(input);
      }
      const route = routing(account);
      if (route.backendOrigin !== modelRoute.origin) throw failure("图片上传后端与当前模型后端不一致，已停止上传。");
      if (route.accountRoutingOverride !== "NO_CONSTRAINT") {
        throw failure("当前账户要求区域路由约束，模型代理尚未验证相同约束，已停止图片上传。");
      }
      const token = await this.token(signal);
      pending.identity = { route, token };
      await this.assertAccount(route, token, signal);
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "chatgpt-account-id": route.chatgptAccountId,
        "content-type": "application/json",
      };
      const converted: UserInput[] = [];
      let count = 0;
      let total = 0;
      for (const item of input) {
        if (item.type !== "image" || !("url" in item)) {
          converted.push(item);
          continue;
        }
        const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.url);
        if (!match) throw failure("图片输入格式不受支持。");
        if (match[2]!.length > 14_000_000) throw failure("图片超过上传大小限制。");
        const bytes = Buffer.from(match[2]!, "base64");
        total += bytes.length;
        if (++count > 4 || bytes.length > 10 * 1024 * 1024 || total > 20 * 1024 * 1024) {
          throw failure("图片超过上传数量或大小限制。");
        }
        const fileId = await this.upload(route.backendOrigin, headers, bytes, match[1]!, signal);
        converted.push({ type: "image", fileId, ...(item.detail ? { detail: item.detail } : {}) });
      }
      await this.assertAccount(route, token, signal);
      const currentModelRoute = await this.modelRoute(thread.thread.cwd, signal);
      if (currentModelRoute?.endpoint !== modelRoute.endpoint || currentModelRoute.origin !== route.backendOrigin) {
        throw failure("模型后端已变化，请重新发送图片。");
      }
      await pending.validation;
      signal.throwIfAborted();
      return await dispatch(converted);
    } catch (error) {
      if (dispatched) throw error;
      if (error instanceof UserFacingError) throw error;
      throw failure(signal.aborted
        ? "图片发送已取消或超时；请重新发送。"
        : "图片引用发送失败；请检查 Codex 登录状态和网络后重试。");
    } finally {
      if (this.pending.get(threadId) === pending) this.pending.delete(threadId);
    }
  }

  private recheck(pending: PendingUpload): void {
    // Before the initial snapshot exists, the preparation's own account reads
    // establish identity. An initialization notification is not a change.
    if (!pending.identity || pending.signal.aborted) return;
    pending.dirty = true;
    if (pending.validation) return;
    pending.validation = (async () => {
      try {
        while (pending.dirty && !pending.signal.aborted) {
          pending.dirty = false;
          await this.assertAccount(pending.identity!.route, pending.identity!.token, pending.signal);
        }
      } catch {
        pending.controller.abort();
      } finally {
        delete pending.validation;
      }
    })();
  }

  private async modelRoute(cwd: string, signal: AbortSignal): Promise<{ endpoint: string; origin: string } | null> {
    const response = await this.rpc.request<ConfigReadResponse>({ method: "config/read", params: { cwd, includeLayers: false } },
      { retryOverload: true, signal });
    const base = response.config.openai_base_url;
    if (typeof base !== "string") throw failure("无法确认当前 App Server 的模型代理地址。");
    const endpoint = new URL(base);
    // Only the service's private loopback proxy can attest its running route.
    // Independent model endpoints retain inline input; never probe them with credentials.
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
      || endpoint.pathname !== "/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
    const result = await this.localFetch(new URL("/_codexc/image-upload-route", endpoint), {
      method: "GET", redirect: "error", signal,
    });
    const inspected = await this.readJson(result);
    if (inspected.supported === false && inspected.backendOrigin === null) return null;
    if (inspected.supported !== true || inspected.backendOrigin !== "https://chatgpt.com") {
      throw failure("当前模型代理无法确认图片引用后端。");
    }
    return { endpoint: endpoint.origin, origin: inspected.backendOrigin };
  }

  private account(signal: AbortSignal): Promise<GetAccountResponse> {
    return this.rpc.request<GetAccountResponse>({ method: "account/read", params: { refreshToken: false } },
      { retryOverload: false, signal });
  }

  private async token(signal: AbortSignal): Promise<string> {
    const auth = await this.readAuth(signal);
    if ((auth.authMethod !== "chatgpt" && auth.authMethod !== "chatgptAuthTokens")
      || !auth.authToken || /[\r\n]/.test(auth.authToken)) {
      throw failure("当前 Codex 认证方式无法提供图片上传凭据。");
    }
    return auth.authToken;
  }

  private async assertAccount(route: Routing, token: string, signal: AbortSignal): Promise<void> {
    const current = routing(await this.account(signal));
    if (current.chatgptAccountId !== route.chatgptAccountId || current.backendOrigin !== route.backendOrigin
      || current.accountRoutingOverride !== route.accountRoutingOverride || await this.token(signal) !== token) {
      throw failure("Codex 账户或路由已变化，请重新发送图片。");
    }
  }

  private async upload(origin: string, headers: Record<string, string>, bytes: Buffer, extension: string, signal: AbortSignal): Promise<string> {
    const base = `${origin}/backend-api/files`;
    const created = await this.json(base, headers, {
      file_name: `image.${extension}`, file_size: bytes.length, use_case: "codex",
    }, signal);
    if (typeof created.file_id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(created.file_id)
      || typeof created.upload_url !== "string") throw failure("图片上传服务返回无效编号或地址。");
    const uploadUrl = new URL(created.upload_url);
    if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password || uploadUrl.hash) {
      throw failure("图片上传服务返回不安全地址。");
    }
    const put = await this.fetchImpl(uploadUrl, {
      method: "PUT", redirect: "error", signal,
      headers: { "x-ms-blob-type": "BlockBlob", "x-ms-client-request-id": randomUUID(),
        "content-length": String(bytes.length) },
      body: new Uint8Array(bytes),
    });
    await put.body?.cancel();
    if (!put.ok) throw failure("图片文件传输失败，请重新发送。");
    const deadline = Date.now() + 30_000;
    for (;;) {
      const finalized = await this.json(`${base}/${created.file_id}/uploaded`, headers, {}, signal);
      if (finalized.status === "success" && typeof finalized.download_url === "string") return created.file_id;
      if (finalized.status !== "retry" || Date.now() >= deadline) throw failure("图片上传尚未完成，请稍后重新发送。");
      await delay(250, undefined, { signal });
    }
  }

  private async json(url: string, headers: Record<string, string>, body: object, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal });
    return this.readJson(response);
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw failure("图片上传服务拒绝请求，请检查登录状态和网络。");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 64 * 1024) throw failure("图片上传服务响应过大。");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw failure("图片上传服务响应无效。");
    return parsed as Record<string, unknown>;
  }
}

interface PendingUpload {
  controller: AbortController;
  signal: AbortSignal;
  identity?: { route: Routing; token: string };
  dirty: boolean;
  validation?: Promise<void>;
}

type Routing = NonNullable<GetAccountResponse["workspaceRouting"]>;
function routing(account: GetAccountResponse): Routing {
  const route = account.workspaceRouting;
  if (account.account?.type !== "chatgpt" || !route || !route.chatgptAccountId
    || /[\r\n]/.test(route.chatgptAccountId)
    || !["NO_CONSTRAINT", "us", "us_cr"].includes(route.accountRoutingOverride)) {
    throw failure("无法确认 Codex 图片上传账户和路由。");
  }
  const origin = new URL(route.backendOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/"
    || origin.search || origin.hash) throw failure("Codex 图片上传后端地址无效。");
  return { ...route, backendOrigin: origin.origin };
}
function failure(message: string): UserFacingError {
  return new UserFacingError("image.reference.failed", message);
}
