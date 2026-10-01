import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { ConfigReadResponse, GetAccountResponse, GetAuthStatusResponse, ThreadReadResponse, UserInput } from "../codex-protocol/index.js";
import { UserFacingError } from "../conversation-core/index.js";
import { JsonRpcError, type JsonRpcClient } from "./json-rpc.js";

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
    pending?.controller.abort(failure("图片发送已取消。", "cancelled"));
    return pending !== undefined;
  }

  cancelAll(): void {
    for (const pending of this.pending.values()) pending.controller.abort(failure("图片发送已因连接关闭而取消。", "disconnected"));
  }

  async submit<T>(threadId: string, input: UserInput[], submit: (input: UserInput[]) => Promise<T>): Promise<T> {
    if (this.pending.has(threadId) || this.pending.size >= 4) {
      throw failure("图片上传繁忙，请稍后重试。");
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    const pending: PendingUpload = { controller, signal, dirty: false,
      stage: "thread-read", startedAt: performance.now(), stageStartedAt: performance.now(), diagnosticId: randomUUID() };
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
      const modelRoute = await this.modelRoute(thread.thread.cwd, pending);
      if (modelRoute === null) return await dispatch(input);
      stage(pending, "account-check");
      const account = await this.account(signal);
      if (account.account?.type === "apiKey" || !account.requiresOpenaiAuth) {
        return await dispatch(input);
      }
      const route = routing(account);
      if (route.backendOrigin !== modelRoute.origin) throw failure("图片上传后端与当前模型后端不一致，已停止上传。");
      if (route.accountRoutingOverride !== "NO_CONSTRAINT") {
        throw failure("当前账户要求区域路由约束，模型代理尚未验证相同约束，已停止图片上传。");
      }
      stage(pending, "auth-read");
      const token = await this.token(signal);
      pending.identity = { route, token };
      stage(pending, "account-check");
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
        stage(pending, "input-validation");
        const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.url);
        if (!match) throw failure("图片输入格式不受支持。");
        if (match[2]!.length > 14_000_000) throw failure("图片超过上传大小限制。");
        const bytes = Buffer.from(match[2]!, "base64");
        total += bytes.length;
        if (++count > 4 || bytes.length > 10 * 1024 * 1024 || total > 20 * 1024 * 1024) {
          throw failure("图片超过上传数量或大小限制。");
        }
        const fileId = await this.upload(route.backendOrigin, headers, bytes, match[1]!, pending);
        converted.push({ type: "image", fileId, ...(item.detail ? { detail: item.detail } : {}) });
      }
      stage(pending, "account-recheck");
      await this.assertAccount(route, token, signal);
      const currentModelRoute = await this.modelRoute(thread.thread.cwd, pending);
      if (currentModelRoute?.endpoint !== modelRoute.endpoint || currentModelRoute.origin !== route.backendOrigin) {
        throw failure("模型后端已变化，请重新发送图片。");
      }
      await pending.validation;
      signal.throwIfAborted();
      return await dispatch(converted);
    } catch (error) {
      if (dispatched) throw error;
      const reason: unknown = signal.aborted ? signal.reason : error;
      const classified = classifyFailure(reason, pending.stage);
      throw new UserFacingError("image.reference.failed", classified.message, {
        ...classified.details,
        stage: classified.details.stage ?? pending.stage,
        elapsedMs: String(Math.max(0, Math.round(performance.now() - pending.startedAt))),
        stageElapsedMs: classified.details.stageElapsedMs ?? String(Math.max(0, Math.round(performance.now() - pending.stageStartedAt))),
        diagnosticId: pending.diagnosticId,
      });
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
      const startedAt = performance.now();
      try {
        while (pending.dirty && !pending.signal.aborted) {
          pending.dirty = false;
          await this.assertAccount(pending.identity!.route, pending.identity!.token, pending.signal);
        }
      } catch (error) {
        const classified = classifyFailure(error, "account-recheck");
        pending.controller.abort(new UserFacingError("image.reference.failed", classified.message,
          { ...classified.details, stage: "account-recheck",
            stageElapsedMs: String(Math.max(0, Math.round(performance.now() - startedAt))) }));
      } finally {
        delete pending.validation;
      }
    })();
  }

  private async modelRoute(cwd: string, pending: PendingUpload): Promise<{ endpoint: string; origin: string } | null> {
    const { signal } = pending;
    stage(pending, "model-config");
    const response = await this.rpc.request<ConfigReadResponse>({ method: "config/read", params: { cwd, includeLayers: false } },
      { retryOverload: true, signal });
    const base = response.config.openai_base_url;
    if (typeof base !== "string") throw failure("无法确认当前 App Server 的模型代理地址。");
    const endpoint = new URL(base);
    // Only the service's private loopback proxy can attest its running route.
    // Independent model endpoints retain inline input; never probe them with credentials.
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
      || endpoint.pathname !== "/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
    stage(pending, "model-route");
    const result = await this.localFetch(new URL("/_codexc/image-upload-route", endpoint), {
      method: "GET", redirect: "error", signal,
    });
    const inspected = await this.readJson(result);
    if (inspected.supported === false && inspected.backendOrigin === null) return null;
    if (inspected.supported !== true || inspected.backendOrigin !== "https://chatgpt.com") {
      throw failure("当前模型代理无法确认图片引用后端。", "invalid-response");
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

  private async upload(origin: string, headers: Record<string, string>, bytes: Buffer, extension: string, pending: PendingUpload): Promise<string> {
    const { signal } = pending;
    stage(pending, "file-create");
    const base = `${origin}/backend-api/files`;
    const created = await this.json(base, headers, {
      file_name: `image.${extension}`, file_size: bytes.length, use_case: "codex",
    }, signal);
    if (typeof created.file_id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(created.file_id)
      || typeof created.upload_url !== "string") throw failure("图片上传服务返回无效编号或地址。", "invalid-response");
    let uploadUrl: URL;
    try {
      uploadUrl = new URL(created.upload_url);
    } catch {
      throw failure("图片上传服务返回无效上传地址。", "invalid-response");
    }
    if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password || uploadUrl.hash) {
      throw failure("图片上传服务返回不安全地址。", "invalid-response");
    }
    stage(pending, "file-transfer");
    const put = await this.fetchImpl(uploadUrl, {
      method: "PUT", redirect: "error", signal,
      headers: { "x-ms-blob-type": "BlockBlob", "x-ms-client-request-id": randomUUID(),
        "content-length": String(bytes.length) },
      body: new Uint8Array(bytes),
    });
    await put.body?.cancel().catch(() => undefined);
    if (!put.ok) throw httpFailure(put.status);
    stage(pending, "file-finalize");
    const deadline = Date.now() + 30_000;
    for (;;) {
      const finalized = await this.json(`${base}/${created.file_id}/uploaded`, headers, {}, signal);
      if (finalized.status === "success" && typeof finalized.download_url === "string") return created.file_id;
      if (finalized.status !== "retry") throw failure("图片上传完成确认响应无效。", "invalid-response");
      if (Date.now() >= deadline) throw failure("图片上传尚未完成，请稍后重新发送。");
      await delay(250, undefined, { signal });
    }
  }

  private async json(url: string, headers: Record<string, string>, body: object, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal });
    return this.readJson(response);
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw httpFailure(response.status);
      throw failure("图片上传服务响应为空。", "invalid-response");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 64 * 1024) throw failure("图片上传服务响应过大。", "invalid-response");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw failure("图片上传服务响应无效。", "invalid-response");
    return parsed as Record<string, unknown>;
  }
}

interface PendingUpload {
  controller: AbortController;
  signal: AbortSignal;
  identity?: { route: Routing; token: string };
  stage: UploadStage;
  startedAt: number;
  stageStartedAt: number;
  diagnosticId: string;
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
function failure(message: string, reason = "validation"): UserFacingError {
  return new UserFacingError("image.reference.failed", message, { reason });
}

const stageLabels = {
  "thread-read": "读取会话", "model-config": "读取模型配置", "model-route": "检查本地模型代理",
  "account-check": "校验账户", "auth-read": "读取上传凭据", "input-validation": "校验图片",
  "file-create": "创建图片文件", "file-transfer": "传输图片", "file-finalize": "确认图片上传",
  "account-recheck": "复核账户",
} as const;
type UploadStage = keyof typeof stageLabels;

function stage(pending: PendingUpload, value: UploadStage): void {
  pending.stage = value;
  pending.stageStartedAt = performance.now();
}

function httpFailure(status: number): UserFacingError {
  return new UserFacingError("image.reference.failed", "图片请求被服务拒绝。", {
    reason: "http", httpStatus: String(status),
  });
}

// Never retain the original cause: it may contain credentials, signed URLs or response bodies.
function classifyFailure(error: unknown, currentStage: UploadStage): UserFacingError {
  const label = stageLabels[currentStage];
  if (error instanceof UserFacingError) {
    if (error.details.reason !== "http") return error;
    const status = typeof error.details.httpStatus === "string" ? error.details.httpStatus : "unknown";
    const hint = currentStage === "model-route" ? "请检查 App Server 的本地模型代理"
      : currentStage === "file-transfer" ? "请稍后重新发送图片"
      : status === "401" ? "请检查 Codex 登录状态"
      : status === "403" ? "请检查账户权限或网络访问限制"
      : status === "429" ? "请求过于频繁，请稍后重试" : "请稍后重试";
    return new UserFacingError("image.reference.failed", `${label}失败（HTTP ${status}）；${hint}。`, error.details);
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return failure("图片上传已超时，请稍后重新发送。", "timeout");
  }
  if (error instanceof JsonRpcError) {
    return new UserFacingError("image.reference.failed", `${label}失败：App Server 请求失败，请检查服务状态。`,
      { reason: "rpc", ...(Number.isSafeInteger(error.code) ? { rpcCode: String(error.code) } : {}) });
  }
  if (error instanceof SyntaxError) return failure(`${label}失败：服务响应格式异常。`, "invalid-response");
  const networkCode = safeNetworkCode(error);
  if (networkCode) {
    const timeout = ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"].includes(networkCode);
    return new UserFacingError("image.reference.failed",
      `${label}${timeout ? "连接或响应超时" : "网络连接失败"}；${currentStage === "model-route"
        ? "请检查 App Server 的本地模型代理" : "请检查网络或代理后重试"}。`,
      { reason: timeout ? "network-timeout" : "network", networkCode });
  }
  return failure(`${label}失败；请查看 Gateway 日志中的图片诊断信息。`, "unknown");
}

function safeNetworkCode(error: unknown): string | undefined {
  const allowed = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
    "ENETUNREACH", "EHOSTUNREACH", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string" && allowed.has(record.code)) return record.code;
    current = record.cause;
  }
  return undefined;
}
