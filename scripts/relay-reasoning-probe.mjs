import { HttpsProxyAgent } from "https-proxy-agent";
import { applyChatReasoningPolicy, applyResponsesReasoningPolicy, DirectChatResponse, validateDirectChatRequest, validateDirectResponsesRequest } from "../dist/model-api/index.js";
import { DirectResponsesObserver, applyClinePassProviderOptions, pinClinePassRouting, sendDirectChat, sendDirectResponses, waitForChatOperation } from "../dist/provider-proxy/index.js";
import { readCodexProxySettings } from "../runtime/codex-proxy-env.mjs";
import { parseRelayModelId, relayModelId } from "../runtime/model-relay-model-id.mjs";
import { loadConfiguredRelayProviderMaterial } from "../runtime/model-provider-runtime.mjs";
import { createRefreshableHttpProxySelector } from "../runtime/network-proxy.mjs";
import { readRelayManagement } from "./model-relay-management.mjs";
import { ApiError } from "./webui-http.mjs";

const modes = ["passthrough", "off-reasoning-effort", "off-reasoning-enabled", "off-reasoning-effort-field", "off-thinking", "off-enable-thinking", "off-chat-template-thinking", "off-google-thinking-budget", "off-reasoning-enabled-thinking"];
const maximumResponseBytes = 128 * 1024;
const prompt = "Reply with exactly OK.";
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = value => typeof value === "string" && value.length > 0;
const invalid = () => new ApiError(400, "relay_probe_invalid", "Relay 思考探测参数或模型不可用");
const stale = () => new ApiError(409, "stale-revision", "Relay 配置或模型目录已变化，请刷新后重新探测");
const failed = () => new ApiError(502, "relay_probe_failed", "Relay 思考探测暂不可用");
const emptyRow = mode => ({ mode, status: "not_run", httpStatus: null, reasoningText: null, reasoningTokens: null, outputTokens: null, responseModel: null });

/** Nine bounded, sequential requests; no persistence, content return, retry or inferred adoption. */
export async function probeRelayReasoning(input, { environment = process.env, signal, onProgress } = {}) {
  if (!record(input) || Object.keys(input).length !== 3 || !Object.keys(input).every(key => ["revision", "model", "protocol"].includes(key))
    || !/^[a-f0-9]{64}$/u.test(input.revision) || !["chat", "responses"].includes(input.protocol)) throw invalid();
  const identity = parseRelayModelId(input.model);
  if (!identity) throw invalid();
  let initial;
  try { initial = readRelayManagement(environment); } catch { throw failed(); }
  if (initial.revision !== input.revision) throw stale();
  const listed = initial.providers.find(provider => provider.id === identity.provider);
  if (!listed?.available || !listed.protocols.includes(input.protocol) || listed.models.filter(model => model.relayId === input.model).length !== 1) throw invalid();
  let material;
  try { material = loadConfiguredRelayProviderMaterial(identity.provider, environment); } catch { throw failed(); }
  const models = material.models.filter(model => relayModelId(identity.provider, model) === input.model);
  if (models.length !== 1 || !material.protocols.includes(input.protocol)) throw invalid();
  const model = models[0];
  const capability = material.modelCapabilities?.find(entry => entry.id === model);
  const rows = modes.map(emptyRow);
  const result = { model: input.model, protocol: input.protocol, revision: input.revision, observedAtMs: Date.now(), rows, stoppedReason: null };
  const controller = new AbortController();
  const deadline = performance.now() + 135_000;
  let selector;
  let proxySettings;
  let agent;
  let changed = false;
  let timedOut = false;
  const abort = () => { controller.abort(); void selector?.close().catch(() => {}); agent?.destroy(); };
  const totalTimer = setTimeout(() => { timedOut = true; abort(); }, 135_000);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const recheck = () => {
    controller.signal.throwIfAborted();
    try {
      if (readRelayManagement(environment).revision !== input.revision
        || loadConfiguredRelayProviderMaterial(identity.provider, environment).revision !== material.revision
        || proxySettings !== undefined && JSON.stringify(readCodexProxySettings(environment)) !== JSON.stringify(proxySettings)) throw stale();
    } catch { changed = true; throw stale(); }
  };
  const progress = async currentMode => {
    controller.signal.throwIfAborted();
    if (onProgress) await waitForChatOperation(Promise.resolve(onProgress({ type: "progress", result: { ...result, rows: rows.map(row => ({ ...row })) }, currentMode }, controller.signal)), controller.signal);
  };
  try {
    recheck();
    proxySettings = readCodexProxySettings(environment);
    selector = createRefreshableHttpProxySelector(proxySettings, environment);
    const endpoint = new URL(material.baseUrl);
    for (const row of rows) {
      if (controller.signal.aborted || performance.now() >= deadline) break;
      recheck();
      await progress(row.mode);
      const requestController = new AbortController();
      const requestSignal = globalThis.AbortSignal.any([controller.signal, requestController.signal]);
      let requestTimedOut = false;
      const requestTimer = setTimeout(() => { requestTimedOut = true; requestController.abort(); }, Math.min(15_000, Math.max(1, deadline - performance.now())));
      const observer = input.protocol === "chat" ? new DirectChatResponse() : new DirectResponsesObserver();
      const reasoning = reasoningObservation(input.protocol);
      try {
        recheck();
        const proxyRevision = selector.revision;
        const proxy = await waitForChatOperation(selector.select(endpoint), requestSignal);
        requestSignal.throwIfAborted();
        recheck();
        if (selector.revision !== proxyRevision) { changed = true; throw stale(); }
        agent?.destroy();
        agent = proxy ? new HttpsProxyAgent(proxy, { maxSockets: 1, maxFreeSockets: 0 }) : undefined;
        const sampling = material.modelSampling && Object.hasOwn(material.modelSampling, model) ? material.modelSampling[model] : {};
        let request = input.protocol === "chat"
          ? applyChatReasoningPolicy(validateDirectChatRequest({ ...sampling, model, stream: true, stream_options: { include_usage: true }, max_tokens: 64, messages: [{ role: "user", content: prompt }] }), identity.provider, row.mode, capability)
          : applyResponsesReasoningPolicy(validateDirectResponsesRequest(identity.provider, { ...sampling, model, stream: true, store: false, max_output_tokens: 64, input: prompt }), identity.provider, row.mode);
        if (identity.provider.startsWith("clp-")) {
          request = applyClinePassProviderOptions(request, capability?.cline_provider_options);
          request = pinClinePassRouting(request, capability?.cline_request_profile);
        }
        const call = { request, observer, signal: requestSignal, maximumResponseBytes,
          target: { host: endpoint.hostname.replace(/^\[|\]$/gu, ""), port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === "http:" ? 80 : 443,
            protocol: endpoint.protocol === "http:" ? "http" : "https", basePath: endpoint.pathname, authorization: `Bearer ${material.apiKey}`, ...(agent ? { agent } : {}) },
          recheck: () => { requestSignal.throwIfAborted(); recheck(); if (selector.revision !== proxyRevision) { changed = true; throw stale(); } },
          submitted() {}, headers(status) { row.httpStatus = status; }, content() {}, async emit() {},
          capture: { submitted() {}, head() {}, done() {}, finish() {}, invalid() {},
            value(value) { reasoning.observe(value); },
          },
        };
        if (input.protocol === "chat") await sendDirectChat({ ...call, unwrapClpEnvelope: identity.provider.startsWith("clp-") });
        else await sendDirectResponses(call);
        requestSignal.throwIfAborted();
        row.status = observer.status === "completed" ? "completed" : observer.status === "incomplete" ? "incomplete" : "failed";
        row.reasoningText = reasoning.result(row.status === "completed");
        row.reasoningTokens = observer.usage.reasoningOutputTokens ?? null;
        row.outputTokens = observer.usage.outputTokens ?? null;
        row.responseModel = observer.responseModel ?? null;
      } catch {
        row.status = requestTimedOut || timedOut ? "timeout" : "failed";
        // Partial/error bodies do not establish the absence of reasoning or complete usage.
        row.reasoningText = reasoning.result(false);
      } finally {
        clearTimeout(requestTimer);
        requestController.abort();
        agent?.destroy(); agent = undefined;
      }
      if (!controller.signal.aborted) await progress(null);
      if (changed || controller.signal.aborted || [401, 403, 429].includes(row.httpStatus)) break;
    }
    // Bind even the final returned observations to the resource the user selected.
    if (!controller.signal.aborted && !changed) recheck();
  } catch {
    if (!changed && !controller.signal.aborted) throw failed();
  } finally {
    clearTimeout(totalTimer);
    signal?.removeEventListener("abort", abort);
    abort();
    await selector?.close().catch(() => {});
  }
  result.stoppedReason = changed ? "material_changed" : timedOut || performance.now() >= deadline ? "timeout" : null;
  return result;
}

/** Observe only documented reasoning content; unknown shapes cannot prove absence. */
function reasoningObservation(protocol) {
  let seen = false;
  let unknown = false;
  const text = value => {
    if (value == null) return;
    if (typeof value === "string") seen ||= value.length > 0;
    else unknown = true;
  };
  const item = value => {
    if (!record(value) || value.type !== "reasoning") return;
    for (const key of ["summary", "content"]) {
      if (value[key] == null) continue;
      if (!Array.isArray(value[key])) { unknown = true; continue; }
      for (const part of value[key]) {
        if (record(part) && ["summary_text", "reasoning_text"].includes(part.type) && typeof part.text === "string") text(part.text);
        else unknown = true;
      }
    }
    // A reasoning item with no visible text cannot establish the absence of reasoning.
    if (!seen) unknown = true;
  };
  return { result: complete => seen ? true : complete && !unknown ? false : null,
    observe(value) {
      if (!record(value)) { unknown = true; return; }
      if (protocol === "chat") {
        for (const choice of value.choices ?? []) {
          const message = choice?.delta ?? choice?.message;
          if (!record(message)) continue;
          text(message.reasoning); text(message.reasoning_content);
          if (message.reasoning_details != null) {
            if (!Array.isArray(message.reasoning_details)) { unknown = true; continue; }
            for (const detail of message.reasoning_details) {
              if (record(detail) && detail.type === "reasoning.text" && typeof detail.text === "string") text(detail.text);
              else if (record(detail) && detail.type === "reasoning.summary" && typeof detail.summary === "string") text(detail.summary);
              else unknown = true;
            }
          }
        }
        return;
      }
      if (typeof value.type === "string" && /^response\.reasoning(?:_summary)?_text\.(?:delta|done)$/u.test(value.type)) {
        if (typeof (value.delta ?? value.text) === "string") text(value.delta ?? value.text);
        else unknown = true;
      }
      if (record(value.part) && ["summary_text", "reasoning_text"].includes(value.part.type)) {
        if (typeof value.part.text === "string") text(value.part.text);
        else unknown = true;
      }
      if (typeof value.type === "string" && /^response\.reasoning(?:_summary)?_part\.(?:added|done)$/u.test(value.type)) {
        if (!record(value.part) || !["summary_text", "reasoning_text"].includes(value.part.type)) unknown = true;
      }
      item(value.item);
      const response = record(value.response) ? value.response : value;
      if (Array.isArray(response.output)) response.output.forEach(item);
      if (nonempty(value.type) && value.type.includes("reasoning")
        && !/^response\.reasoning(?:_summary)?_(?:text|part)\.(?:delta|done|added)$/u.test(value.type)) unknown = true;
    },
  };
}
