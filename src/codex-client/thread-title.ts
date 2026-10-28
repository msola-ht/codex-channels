import {
  threadTitleInputDigest,
  type CompletedThreadTitleInput,
  type GenerateThreadTitleRequest,
  type GenerateThreadTitleResult,
  type SetGeneratedThreadNameRequest,
  type SetGeneratedThreadNameResult,
} from "../application/index.js";
import type {
  ConfigReadResponse,
  JsonValue,
  ModelListResponse,
  ThreadReadResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadUnsubscribeResponse,
  TurnStartResponse,
} from "../codex-protocol/index.js";
import { JsonRpcClient, JsonRpcError, type RpcNotification, type RpcRequestOptions, type RpcServerRequest } from "./json-rpc.js";
import { asRecord, nonEmptyString } from "./notification-parse-helpers.js";

const MAX_BODY_BYTES = 8 * 1024;
const TITLE_SCHEMA: JsonValue = {
  type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 36 } },
  required: ["title"], additionalProperties: false,
};
const TITLE_INSTRUCTIONS = "Generate a concise, single-line task title of at most 36 characters and under five words where possible. "
  + "Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. "
  + "Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.";

export function parseThreadTitle(body: string): string | undefined {
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES || !body.trimStart().startsWith("{")) return undefined;
  let decoded: unknown;
  try { decoded = JSON.parse(body); } catch { return undefined; }
  const record = asRecord(decoded);
  if (!record || Object.keys(record).length !== 1 || typeof record.title !== "string"
    || /[\uD800-\uDFFF]/u.test(record.title)) return undefined;
  // JSON.parse overwrites duplicate keys; the upstream strict object rejects them.
  let quoted = false;
  let escaped = false;
  let fields = 0;
  for (const character of body) {
    if (escaped) { escaped = false; continue; }
    if (quoted && character === "\\") { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === ":") fields += 1;
  }
  if (fields !== 1) return undefined;
  const title = record.title.trim().replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, "").trim()
    .split(/\s+/u).join(" ").replace(/[.?!]+$/u, "").trimEnd();
  return title ? Array.from(title).slice(0, 36).join("") : undefined;
}

function titlePrompt(candidate: string): string {
  const prefix = `${TITLE_INSTRUCTIONS}\n\nUser prompt:\n`;
  let bytes = Buffer.byteLength(prefix, "utf8");
  let text = "";
  for (const character of candidate.trim()) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > 960) break;
    bytes += size;
    text += character;
  }
  return prefix + text;
}

/** Only actual completed user Items establish acceptance; started is deliberately ignored. */
export function toCompletedThreadTitleInput(notification: RpcNotification): CompletedThreadTitleInput | undefined {
  if (notification.method !== "item/completed" || notification.isCurrentConnection?.() !== true) return undefined;
  const params = asRecord(notification.params);
  const item = asRecord(params?.item);
  const threadId = nonEmptyString(params?.threadId);
  const turnId = nonEmptyString(params?.turnId);
  const itemId = nonEmptyString(item?.id);
  const clientUserMessageId = nonEmptyString(item?.clientId);
  if (!threadId || !turnId || !itemId || !clientUserMessageId || item?.type !== "userMessage"
    || !Array.isArray(item.content)) return undefined;
  const texts: Array<{ type: "text"; text: string }> = [];
  for (const value of item.content) {
    const content = asRecord(value);
    if (!content || typeof content.type !== "string") return undefined;
    if (content.type === "text") {
      if (typeof content.text !== "string") return undefined;
      texts.push({ type: "text", text: content.text });
    }
  }
  return { threadId, turnId, itemId, clientUserMessageId, digest: threadTitleInputDigest(texts) };
}

interface TurnObservation { body?: string; status?: string }
interface TemporaryThread {
  threadId: string;
  turnId?: string | undefined;
  turnAttempted: boolean;
  ended: boolean;
  released: boolean;
  failed: boolean;
  observations: Map<string, TurnObservation>;
  wake: Set<() => void>;
  cancel?: (() => void) | undefined;
  unconfirmedReason?: string | undefined;
  phase: "created" | "generating" | "interrupting" | "unsubscribing" | "cleanupUnconfirmed";
}

export interface ThreadTitleDiagnostics {
  quarantined: boolean;
  active: number;
  cleanupUnconfirmed: number;
  reason?: string;
  resources: readonly { threadId: string; turnId?: string; ended: boolean; released: boolean; phase: string }[];
}

/** Owns only temporary title resources, independently of business bindings and reconnects. */
export class ThreadTitleRequests {
  private readonly threads = new Map<string, TemporaryThread>();
  private readonly hiddenThreads = new Set<string>();
  private readonly tasks = new Map<Promise<GenerateThreadTitleResult>, AbortController>();
  private unknownIdentityReason: string | undefined;
  private recoveryTask: Promise<void> | undefined;

  private get quarantineReason(): string | undefined {
    return this.unknownIdentityReason ?? [...this.threads.values()].find(thread => thread.unconfirmedReason)?.unconfirmedReason;
  }

  constructor(private readonly rpc: JsonRpcClient) {}

  diagnostics(): ThreadTitleDiagnostics {
    return { quarantined: this.quarantineReason !== undefined, active: this.tasks.size,
      cleanupUnconfirmed: [...this.threads.values()].filter(value => value.unconfirmedReason !== undefined).length,
      resources: [...this.threads.values()].map(thread => ({ threadId: thread.threadId,
        ...(thread.turnId ? { turnId: thread.turnId } : {}), ended: thread.ended, released: thread.released, phase: thread.phase })),
      ...(this.quarantineReason ? { reason: this.quarantineReason } : {}) };
  }

  cancel(): void {
    for (const controller of this.tasks.values()) controller.abort();
  }

  async wait(deadlineMs: number): Promise<void> {
    if (deadlineMs <= Date.now()) return;
    await boundedWait(Promise.allSettled([...this.tasks.keys(), ...(this.recoveryTask ? [this.recoveryTask] : [])]), deadlineMs);
  }

  /** Recover only owned resources with an already proven terminal state. An
   * ephemeral metadata read cannot prove a missing exact Turn terminal. */
  recover(deadlineMs: number): Promise<void> {
    if (this.recoveryTask) return this.recoveryTask;
    const task = this.recoverEndedThreads(deadlineMs).finally(() => {
      if (this.recoveryTask === task) this.recoveryTask = undefined;
    });
    this.recoveryTask = task;
    return task;
  }

  private async recoverEndedThreads(deadlineMs: number): Promise<void> {
    await boundedWait(Promise.allSettled(this.tasks.keys()), deadlineMs);
    if (this.tasks.size || !this.rpc.isConnected()) return;
    for (const thread of this.threads.values()) {
      if (Date.now() >= deadlineMs || !this.rpc.isConnected()) return;
      if (!thread.ended || thread.released) continue;
      thread.phase = "unsubscribing";
      try {
        const result = await this.rpc.request<ThreadUnsubscribeResponse>({ method: "thread/unsubscribe",
          params: { threadId: thread.threadId } }, { retryOverload: false, timeoutMs: remaining(deadlineMs) });
        thread.released = ["unsubscribed", "notSubscribed", "notLoaded"].includes(result.status);
      } catch { /* A failed compensation keeps the exact resource quarantined. */ }
      if (!thread.released) {
        thread.phase = "cleanupUnconfirmed";
        this.quarantine("unsubscribe-unconfirmed", thread);
      }
      this.reconcile(thread);
    }
  }

  disconnected(): void {
    this.cancel();
    for (const thread of this.threads.values()) {
      if (!thread.ended || !thread.released) this.quarantine("connection-lost", thread);
      thread.failed = true;
      this.wake(thread);
    }
  }

  /** Called before all ordinary notification consumers. Suppression survives reconnect. */
  observe(notification: RpcNotification): boolean {
    const params = asRecord(notification.params);
    const started = notification.method === "thread/started" ? asRecord(params?.thread) : undefined;
    const threadId = nonEmptyString(params?.threadId) ?? nonEmptyString(started?.id);
    if (started?.ephemeral === true && started.threadSource === "thread_title" && threadId
      && this.tasks.size > 0 && this.hiddenThreads.size < 1_999) {
      this.hiddenThreads.add(threadId);
    }
    if (!threadId || !this.hiddenThreads.has(threadId)) return false;
    if (notification.isCurrentConnection?.() !== true) return true;
    const thread = this.threads.get(threadId);
    if (!thread) return true;
    if (notification.method === "thread/closed") {
      // Locked App Server emits this only after exact runtime removal/shutdown.
      thread.ended = true;
      thread.released = true;
      this.reconcile(thread);
      this.wake(thread);
      return true;
    }
    const item = asRecord(params?.item);
    const turn = asRecord(params?.turn);
    const turnId = nonEmptyString(params?.turnId) ?? nonEmptyString(turn?.id);
    if (!turnId) return true;
    if (!thread.observations.has(turnId) && thread.observations.size >= 16) {
      thread.failed = true;
      thread.cancel?.();
      this.wake(thread);
      return true;
    }
    const observation = thread.observations.get(turnId) ?? {};
    if (notification.method === "item/completed" && item?.type === "agentMessage"
      && (item.phase === "final_answer" || item.phase === null)) {
      if (typeof item.text !== "string" || Buffer.byteLength(item.text, "utf8") > MAX_BODY_BYTES) {
        thread.failed = true;
        thread.cancel?.();
      } else observation.body = item.text;
    }
    if (notification.method === "turn/completed" && typeof turn?.status === "string") {
      observation.status = turn.status;
      if (turnId === thread.turnId && terminal(turn.status)) thread.ended = true;
    }
    thread.observations.set(turnId, observation);
    this.reconcile(thread);
    this.wake(thread);
    return true;
  }

  handlesThread(threadId: string): boolean { return this.hiddenThreads.has(threadId); }

  rejectInteraction(request: RpcServerRequest): unknown {
    const params = asRecord(request.params);
    const threadId = nonEmptyString(params?.threadId) ?? nonEmptyString(params?.conversationId);
    const thread = threadId ? this.threads.get(threadId) : undefined;
    if (thread) { thread.failed = true; thread.cancel?.(); this.wake(thread); }
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        return { decision: params?.kind === "writeStdin" ? "cancel" : "decline" };
      case "item/fileChange/requestApproval": return { decision: "decline" };
      case "item/permissions/requestApproval": return { permissions: {}, scope: "turn" };
      case "item/tool/requestUserInput": return { answers: {} };
      case "mcpServer/elicitation/request": return { action: "cancel", content: null, _meta: null };
      case "item/tool/call": return { contentItems: [], success: false };
      case "applyPatchApproval":
      case "execCommandApproval": return { decision: "abort" };
      default: throw new JsonRpcError(-32601, "Temporary title thread does not support interaction");
    }
  }

  generate(request: GenerateThreadTitleRequest): Promise<GenerateThreadTitleResult> {
    if (this.quarantineReason) return Promise.resolve({ type: "cleanupUnconfirmed", reason: this.quarantineReason });
    if (this.tasks.size || this.hiddenThreads.size >= 2_000) return Promise.resolve({ type: "skipped", reason: "client-busy" });
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const task = this.run(request, signal);
    this.tasks.set(task, controller);
    void task.finally(() => this.tasks.delete(task));
    return task;
  }

  private async run(request: GenerateThreadTitleRequest, signal: AbortSignal): Promise<GenerateThreadTitleResult> {
    let thread: TemporaryThread | undefined;
    let createAttempted = false;
    let createSettled = false;
    let stage = "preflight-failed";
    let result: GenerateThreadTitleResult;
    const guard = (): void => {
      signal.throwIfAborted();
      if (!this.rpc.isConnected()) throw new Error("title-connection-unavailable");
      request.beforeSubmit();
    };
    try {
      guard();
      if (!request.candidate.trim() || !request.model || !request.modelProvider || !request.cwd
        || (request.permissionProfile.type === "custom"
          && (!request.permissionProfile.id || request.permissionProfile.id.startsWith(":")))) {
        return { type: "skipped", reason: "missing-context" };
      }
      const preflightDeadline = Math.min(request.deadlineMs, Date.now() + 10_000);
      const original = await this.rpc.request<ThreadReadResponse>({ method: "thread/read",
        params: { threadId: request.threadId, includeTurns: false } },
      { retryOverload: false, signal, beforeSubmit: guard, timeoutMs: remaining(preflightDeadline) });
      if (original.thread.id !== request.threadId || original.thread.cwd !== request.cwd
        || original.thread.model !== request.model || original.thread.modelProvider !== request.modelProvider
        || original.thread.ephemeral !== false || original.thread.parentThreadId !== null
        || (original.thread.threadSource !== "user" && original.thread.threadSource !== null)
        || (original.thread.source !== "appServer" && original.thread.source !== "cli" && original.thread.source !== "vscode")) {
        return { type: "skipped", reason: "original-context-unconfirmed" };
      }
      if (original.thread.name !== null) return { type: "skipped", reason: "original-already-named" };
      const config = await this.rpc.request<ConfigReadResponse>({ method: "config/read",
        params: { cwd: request.cwd, includeLayers: false } },
      { retryOverload: false, signal, beforeSubmit: guard, timeoutMs: remaining(preflightDeadline) });
      const mcp = config.config.mcp_servers;
      if (mcp !== undefined && (mcp === null || typeof mcp !== "object" || Array.isArray(mcp))) {
        return { type: "skipped", reason: "invalid-mcp-config" };
      }
      let cursor: string | undefined;
      const cursors = new Set<string>();
      let selected: ModelListResponse["data"][number] | undefined;
      for (let page = 0; page < 20; page += 1) {
        const models = await this.rpc.request<ModelListResponse>({ method: "model/list",
          params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } },
        { retryOverload: false, signal, beforeSubmit: guard, timeoutMs: remaining(preflightDeadline) });
        selected = models.data.find(model => model.model === request.model);
        if (selected || !models.nextCursor) break;
        if (cursors.has(models.nextCursor)) throw new Error("invalid-model-cursor");
        cursor = models.nextCursor;
        cursors.add(cursor);
      }
      if (!selected) return { type: "skipped", reason: "model-unconfirmed" };
      const selectedEffort = selected.supportedReasoningEfforts.some(value => value.reasoningEffort === "low")
        ? "low" : selected.supportedReasoningEfforts.some(value => value.reasoningEffort === selected.defaultReasoningEffort)
          ? selected.defaultReasoningEffort : selected.supportedReasoningEfforts[0]?.reasoningEffort;
      if (typeof selectedEffort !== "string" || !selectedEffort.trim()) return { type: "skipped", reason: "effort-unconfirmed" };
      guard();
      remaining(preflightDeadline);
      stage = "thread-create-failed";
      const params = isolatedThreadParams(request, mcp ? Object.keys(mcp) : []);
      const started = await this.rpc.request<ThreadStartResponse>({ method: "thread/start", params }, {
        retryOverload: false, timeoutMs: 10_000,
        beforeSubmit: () => { guard(); createAttempted = true; },
      }).catch((error: unknown) => { if (error instanceof JsonRpcError) createSettled = true; throw error; });
      const threadId = nonEmptyString(started.thread?.id);
      if (!threadId || threadId === request.threadId || started.thread.ephemeral !== true
        || started.thread.threadSource !== "thread_title") throw new Error("temporary-identity-unconfirmed");
      createSettled = true;
      this.hiddenThreads.add(threadId);
      thread = { threadId, turnAttempted: false, ended: true, released: false, failed: false,
        observations: new Map(), wake: new Set(), cancel: () => this.cancel(), phase: "created" };
      this.threads.set(threadId, thread);
      if (started.model !== request.model || started.modelProvider !== request.modelProvider || started.cwd !== request.cwd
        || started.thread.ephemeral !== true || started.thread.threadSource !== "thread_title"
        || !Array.isArray(started.runtimeWorkspaceRoots) || started.runtimeWorkspaceRoots.length !== 0
        || (request.permissionProfile.type === "custom"
          ? started.activePermissionProfile?.id !== request.permissionProfile.id : started.sandbox?.type !== "readOnly")) {
        throw new Error("temporary-context-mismatch");
      }
      guard();
      stage = "turn-start-failed";
      thread.phase = "generating";
      const generationDeadline = Date.now() + 30_000;
      const turn = await this.rpc.request<TurnStartResponse>({ method: "turn/start", params: {
        threadId, input: [{ type: "text", text: titlePrompt(request.candidate), text_elements: [] }],
        outputSchema: TITLE_SCHEMA, effort: selectedEffort,
      } }, { retryOverload: false, timeoutMs: 10_000,
        beforeSubmit: () => { guard(); thread!.turnAttempted = true; thread!.ended = false; } })
        .catch((error: unknown) => { if (error instanceof JsonRpcError) thread!.ended = true; throw error; });
      thread.turnId = nonEmptyString(turn.turn?.id);
      if (!thread.turnId) throw new Error("missing-temporary-turn-id");
      const observation = thread.observations.get(thread.turnId);
      if (observation?.status && terminal(observation.status)) thread.ended = true;
      stage = "generation-failed";
      await this.until(thread, generationDeadline, () => {
        guard();
        if (thread!.failed) throw new Error("temporary-interaction");
        const observed = thread!.observations.get(thread!.turnId!);
        if (thread!.released && !observed?.status) throw new Error("temporary-runtime-closed");
        if (observed?.status && observed.status !== "completed") throw new Error("temporary-turn-failed");
        return observed?.status === "completed" && observed.body !== undefined;
      }, signal);
      const title = parseThreadTitle(thread.observations.get(thread.turnId)?.body ?? "");
      result = title ? { type: "generated", title } : { type: "failed", reason: "invalid-title" };
    } catch {
      result = { type: !createAttempted ? "skipped" : "failed",
        reason: signal.aborted ? "cancelled" : stage };
      if (createAttempted && !createSettled) this.quarantine("thread-identity-unknown");
    } finally {
      if (thread) {
        await this.cleanup(thread);
        thread.cancel = undefined;
        this.reconcile(thread);
      }
    }
    if (this.quarantineReason) return { type: "cleanupUnconfirmed", reason: this.quarantineReason };
    return signal.aborted && result.type === "generated" ? { type: "failed", reason: "cancelled" } : result;
  }

  private async cleanup(thread: TemporaryThread): Promise<void> {
    if (thread.ended && thread.released) return;
    if (!this.rpc.isConnected()) {
      thread.phase = "cleanupUnconfirmed";
      this.quarantine("connection-lost", thread);
      return;
    }
    if (!thread.ended) {
      thread.phase = "interrupting";
      const deadline = Date.now() + 5_000;
      if (thread.turnId) {
        try {
          await this.rpc.request({ method: "turn/interrupt", params: { threadId: thread.threadId, turnId: thread.turnId } },
            { retryOverload: false, timeoutMs: remaining(deadline) });
          await this.until(thread, deadline, () => thread.ended);
        } catch { /* Execution must still be proven terminal independently of interrupt success. */ }
      }
      if (!thread.ended) this.quarantine(thread.turnId ? "turn-terminal-unconfirmed" : "turn-identity-unknown", thread);
    }
    thread.phase = "unsubscribing";
    if (!this.rpc.isConnected()) {
      thread.phase = "cleanupUnconfirmed";
      this.quarantine("connection-lost", thread);
      return;
    }
    try {
      const result = await this.rpc.request<ThreadUnsubscribeResponse>({ method: "thread/unsubscribe",
        params: { threadId: thread.threadId } }, { retryOverload: false, timeoutMs: 5_000 });
      thread.released = ["unsubscribed", "notSubscribed", "notLoaded"].includes(result.status);
    } catch { /* Keep the precise resource and suppression after ordinary reconnect. */ }
    if (!thread.released) this.quarantine("unsubscribe-unconfirmed", thread);
    if (!thread.ended || !thread.released) thread.phase = "cleanupUnconfirmed";
    this.reconcile(thread);
  }

  private async until(thread: TemporaryThread, deadline: number, predicate: () => boolean, signal?: AbortSignal): Promise<void> {
    while (!predicate()) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error): void => {
          clearTimeout(timer); thread.wake.delete(wake); signal?.removeEventListener("abort", abort);
          if (error) reject(error); else resolve();
        };
        const wake = (): void => finish();
        const abort = (): void => finish(new Error("cancelled"));
        const timer = setTimeout(() => finish(new Error("title-deadline")), remaining(deadline));
        timer.unref();
        thread.wake.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }

  private wake(thread: TemporaryThread): void { for (const wake of thread.wake) wake(); }
  private quarantine(reason: string, thread?: TemporaryThread): void {
    if (thread) thread.unconfirmedReason ??= reason;
    else this.unknownIdentityReason ??= reason;
  }
  private reconcile(thread: TemporaryThread): void {
    if (!thread.ended || !thread.released) return;
    thread.unconfirmedReason = undefined;
    this.threads.delete(thread.threadId);
  }

  async setName(request: SetGeneratedThreadNameRequest): Promise<SetGeneratedThreadNameResult> {
    const read = (): Promise<ThreadReadResponse> => {
      if (!this.rpc.isConnected()) throw new Error("title-connection-unavailable");
      return this.rpc.request<ThreadReadResponse>({ method: "thread/read",
        params: { threadId: request.threadId, includeTurns: false } }, {
        retryOverload: false, timeoutMs: remaining(request.deadlineMs),
      });
    };
    let observedName: string | undefined;
    const remove = this.rpc.onNotification(notification => {
      if (notification.method !== "thread/name/updated" || notification.isCurrentConnection?.() !== true) return;
      const params = asRecord(notification.params);
      if (params?.threadId === request.threadId && typeof params.threadName === "string") observedName = params.threadName;
    });
    try {
      request.beforeSubmit();
      const previous = await read();
      if (previous.thread.id !== request.threadId || previous.thread.cwd !== request.cwd
        || previous.thread.name === undefined) return { type: "unconfirmed" };
      if (typeof previous.thread.name === "string") return { type: "alreadyNamed", name: previous.thread.name };
      if (previous.thread.name !== null) return { type: "unconfirmed" };
      let attempted = false;
      try {
        await setThreadNameRpc(this.rpc, request.threadId, request.title, {
          retryOverload: false, timeoutMs: Math.min(5_000, remaining(request.deadlineMs)), beforeSubmit: () => {
            request.beforeSubmit();
            attempted = true;
          },
        });
      } catch { /* A write is never replayed; settle only official facts. */ }
      if (!attempted) return { type: "unconfirmed" };
      if (observedName === request.title) return { type: "applied" };
      const current = await read();
      if (current.thread.id !== request.threadId || current.thread.cwd !== request.cwd) return { type: "unconfirmed" };
      if (current.thread.name === request.title) return { type: "applied" };
      if (typeof current.thread.name === "string") return { type: "alreadyNamed", name: current.thread.name };
    } catch { /* Unknown and exhausted results remain explicitly unconfirmed. */ }
    finally { remove(); }
    return { type: "unconfirmed" };
  }
}

/** Shared with manual naming; callers choose their own local guard and deadline. */
export async function setThreadNameRpc(rpc: JsonRpcClient, threadId: string, name: string, options: RpcRequestOptions): Promise<void> {
  await rpc.request({ method: "thread/name/set", params: { threadId, name } }, options);
}

function isolatedThreadParams(request: GenerateThreadTitleRequest, mcpNames: string[]): ThreadStartParams {
  const config: Record<string, JsonValue> = {};
  for (const name of ["apps", "code_mode", "code_mode_only", "context_management", "current_time_reminder",
    "deferred_executor", "enable_fanout", "goals", "hooks", "image_generation", "memories", "multi_agent",
    "multi_agent_v2", "plugins", "request_permissions_tool", "shell_snapshot", "shell_tool", "standalone_web_search",
    "token_budget", "tool_suggest", "unified_exec", "view_image"]) config[`features.${name}`] = false;
  for (const name of ["cloud.skills.enabled", "skills.include_instructions", "tools.experimental_request_user_input.enabled",
    "tools.update_plan.enabled"]) config[name] = false;
  config.web_search = "disabled";
  config.mcp_servers = Object.fromEntries(mcpNames.map(name => [name, { enabled: false }]));
  if (request.permissionProfile.type === "builtin") config.default_permissions = ":read-only";
  return { model: request.model, modelProvider: request.modelProvider, allowProviderModelFallback: false,
    cwd: request.cwd, ephemeral: true, threadSource: "thread_title", config,
    runtimeWorkspaceRoots: [], environments: [], dynamicTools: [], selectedCapabilityRoots: [],
    ...(request.permissionProfile.type === "custom" ? { permissions: request.permissionProfile.id } : { sandbox: "read-only" }),
  };
}

function terminal(status: string): boolean { return ["completed", "failed", "interrupted"].includes(status); }
function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error("title-deadline");
  return value;
}
async function boundedWait(task: Promise<unknown>, deadline: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([task, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); timer.unref(); })]); }
  finally { if (timer) clearTimeout(timer); }
}
