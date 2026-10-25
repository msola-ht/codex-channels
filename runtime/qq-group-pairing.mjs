import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { PrivateIpcServer, requestPrivateIpcJson } from "./private-ipc.mjs";

const maximumBytes = 8_192;
const timeoutMs = 3_000;
const sessionLifetimeMs = 300_000;
const secret = z.string().length(64).regex(/^[a-f0-9]{64}$/u);
const identity = z.string().min(1).refine(value => Buffer.byteLength(value, "utf8") <= 512
  && !/[\s\p{Cc}\uD800-\uDFFF]/u.test(value));
const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({ version: z.literal(1), action: z.literal("begin") }),
  z.strictObject({ version: z.literal(1), action: z.literal("status"), token: secret }),
  z.strictObject({ version: z.literal(1), action: z.literal("cancel"), token: secret }),
]);
const errorSchema = z.strictObject({ version: z.literal(1), status: z.literal("error"),
  reason: z.enum(["busy", "expired", "closed", "invalid_request", "unauthorized", "unavailable"]) });
const beginSchema = z.union([errorSchema, z.strictObject({ version: z.literal(1),
  status: z.literal("waiting"), token: secret, code: secret })]);
const statusSchema = z.union([errorSchema,
  z.strictObject({ version: z.literal(1), status: z.literal("waiting") }),
  z.strictObject({ version: z.literal(1), status: z.literal("matched"), groupOpenId: identity, memberOpenId: identity }),
]);
const cancelledSchema = z.union([errorSchema,
  z.strictObject({ version: z.literal(1), status: z.literal("cancelled") }),
]);

/** The application and canonical configuration directory isolate each live broker. */
export function qqGroupPairingPath(configDirectory, appId) {
  if (typeof appId !== "string" || !/^[0-9]+$/u.test(appId) || appId.trim() !== appId) throw failure("invalid_request");
  try {
    const canonical = realpathSync(configDirectory);
    const digest = createHash("sha256").update(JSON.stringify([canonical, appId])).digest("hex");
    if (process.platform === "win32") return join(canonical, `qq-group-pairing-${digest}.ipc`);
    return join(realpathSync("/tmp"), `cqp-${process.getuid()}`, digest);
  } catch { throw failure("unavailable"); }
}

function validateParent(path) {
  if (process.platform === "win32") return;
  try {
    const stat = lstatSync(dirname(path));
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o077) !== 0) throw failure("unavailable");
  } catch { throw failure("unavailable"); }
}

function failure(reason) { return Object.assign(new Error(`QQ_GROUP_PAIRING_${reason.toUpperCase()}`), { code: reason }); }
function errorResponse(reason) { return { version: 1, status: "error", reason }; }
function equalSecret(actual, expected) {
  return secret.safeParse(actual).success
    && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

/** One frame per connection. Invalid/oversize frames never reach session mutation. */
function readFrame(socket) {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    let finished = false;
    const finish = (value, failed = false) => {
      if (finished) return;
      finished = true;
      socket.removeListener("data", data);
      socket.removeListener("error", failedConnection);
      socket.removeListener("end", failedConnection);
      socket.removeListener("close", failedConnection);
      if (failed) reject(failure("invalid_request")); else resolve(value);
    };
    const failedConnection = () => finish(undefined, true);
    const data = chunk => {
      if (received.length + chunk.length > maximumBytes) { failedConnection(); return; }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(10);
      if (newline < 0) return;
      try {
        if (received.subarray(newline + 1).length !== 0) { failedConnection(); return; }
        finish(JSON.parse(received.subarray(0, newline).toString("utf8")));
      } catch { failedConnection(); }
    };
    socket.on("data", data);
    socket.once("error", failedConnection);
    socket.once("end", failedConnection);
    socket.once("close", failedConnection);
  });
}

export class QqGroupPairingServer {
  #server;
  #path;
  #session;
  #expiredToken;
  #expiryTimer;
  #closed = false;
  #starting;
  #closing;

  constructor(configDirectory, appId) {
    this.#path = qqGroupPairingPath(configDirectory, appId);
    this.#server = new PrivateIpcServer(this.#path, socket => {
      socket.on("error", () => {});
      void readFrame(socket).then(value => {
        if (socket.destroyed || socket.readableEnded) return errorResponse("closed");
        return this.#request(value);
      })
        .catch(() => errorResponse("invalid_request"))
        .then(response => {
          if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
        });
    }, { maximumConnections: 8, connectionTimeoutMs: timeoutMs });
  }

  start() {
    if (this.#closed) return Promise.reject(failure("closed"));
    this.#starting ??= this.#server.start("QQ_GROUP_PAIRING_BUSY").catch(() => {
      this.#starting = undefined;
      throw failure("unavailable");
    });
    return this.#starting;
  }

  #expire() {
    if (this.#session && performance.now() >= this.#session.expiresAt) {
      this.#expiredToken = this.#session.token;
      this.#session = undefined;
      clearTimeout(this.#expiryTimer);
    }
  }

  #request(value) {
    if (this.#closed) return errorResponse("closed");
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) return errorResponse("invalid_request");
    const request = parsed.data;
    this.#expire();
    if (request.action === "begin") {
      if (this.#session) return errorResponse("busy");
      const token = randomBytes(32).toString("hex");
      const code = randomBytes(32).toString("hex");
      this.#expiredToken = undefined;
      // QQ event timestamps may have second precision. The unpredictable code
      // did not exist before begin, so accepting that second cannot replay it.
      this.#session = { token, code, startedAtMs: Math.floor(Date.now() / 1_000) * 1_000,
        expiresAt: performance.now() + sessionLifetimeMs };
      this.#scheduleExpiry();
      return { version: 1, status: "waiting", token, code };
    }
    if (!this.#session || !equalSecret(request.token, this.#session.token)) {
      return errorResponse(this.#expiredToken && equalSecret(request.token, this.#expiredToken) ? "expired" : "unauthorized");
    }
    if (request.action === "cancel") {
      this.#session = undefined;
      clearTimeout(this.#expiryTimer);
      return { version: 1, status: "cancelled" };
    }
    return this.#session.match
      ? { version: 1, status: "matched", ...this.#session.match }
      : { version: 1, status: "waiting" };
  }

  #scheduleExpiry() {
    this.#expiryTimer = setTimeout(() => {
      this.#expire();
      if (this.#session) this.#scheduleExpiry();
    }, Math.max(1, Math.ceil(this.#session.expiresAt - performance.now())));
    this.#expiryTimer.unref();
  }

  /** Called only for authenticated QQ group @ events; reserved commands never enter Codex. */
  accept(input) {
    if (typeof input?.content !== "string" || !/^\/qq-pair(?:\s|$)/u.test(input.content)) return false;
    this.#expire();
    const session = this.#session;
    const code = /^\/qq-pair ([a-f0-9]{64})$/u.exec(input.content)?.[1];
    const now = Date.now();
    if (this.#closed || !session || session.match || !code || input.content !== `/qq-pair ${code}` || !equalSecret(code, session.code)
      || !identity.safeParse(input.groupOpenId).success || !identity.safeParse(input.memberOpenId).success
      || !Number.isSafeInteger(input.sentAtMs) || input.sentAtMs < session.startedAtMs
      || input.sentAtMs > now || now - input.sentAtMs > 60_000) return true;
    session.match = { groupOpenId: input.groupOpenId, memberOpenId: input.memberOpenId };
    // The code is consumed even though status remains readable until cancellation.
    session.code = undefined;
    return true;
  }

  close() {
    this.#closed = true;
    this.#session = undefined;
    this.#expiredToken = undefined;
    clearTimeout(this.#expiryTimer);
    this.#closing ??= this.#server.close().catch(() => {
      this.#closing = undefined;
      throw failure("unavailable");
    });
    return this.#closing;
  }
}

async function exchange(path, request, schema, signal) {
  signal?.throwIfAborted();
  validateParent(path);
  let value;
  try { value = await requestPrivateIpcJson(path, request, { timeoutMs, maximumBytes, signal }); }
  catch { throw failure(signal?.aborted ? "cancelled" : "unavailable"); }
  const result = schema.safeParse(value);
  if (!result.success) throw failure("invalid_response");
  if (result.data.status === "error") throw failure(result.data.reason);
  return result.data;
}

function abortableCodeCallback(onCode, code, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); return; }
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return onCode(code);
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** A single begin attempt; an unconfirmed begin is never repeated or taken over. */
export async function pairQqGroup({ configDirectory, appId, signal, onCode }) {
  if (typeof onCode !== "function") throw failure("invalid_request");
  if (signal?.aborted) throw failure("cancelled");
  const path = qqGroupPairingPath(configDirectory, appId);
  const lifetime = globalThis.AbortSignal.timeout(sessionLifetimeMs);
  const active = signal ? globalThis.AbortSignal.any([signal, lifetime]) : lifetime;
  let token;
  let match;
  let operationFailed = false;
  let operationError;
  let cleanupUnconfirmed = false;
  try {
    const begin = await exchange(path, { version: 1, action: "begin" }, beginSchema, active);
    token = begin.token;
    await abortableCodeCallback(onCode, begin.code, active);
    while (true) {
      const status = await exchange(path, { version: 1, action: "status", token }, statusSchema, active);
      if (status.status === "matched") {
        match = { groupOpenId: status.groupOpenId, memberOpenId: status.memberOpenId };
        break;
      }
      await delay(1_000, undefined, { signal: active });
    }
  } catch (error) {
    operationFailed = true;
    operationError = signal?.aborted ? failure("cancelled") : lifetime.aborted ? failure("expired") : error;
  } finally {
    if (token) {
      try { await exchange(path, { version: 1, action: "cancel", token }, cancelledSchema, globalThis.AbortSignal.timeout(timeoutMs)); }
      catch (error) {
        // Expired/absent ownership proves this token no longer holds the lease.
        // An unconfirmed cancel must remain visible even after a captured match.
        cleanupUnconfirmed = error?.code !== "expired" && error?.code !== "unauthorized";
      }
    }
  }
  if (cleanupUnconfirmed) throw failure("cleanup_unconfirmed");
  if (operationFailed) throw operationError;
  return match;
}
