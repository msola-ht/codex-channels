import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { consumeDirectResponses, DirectResponsesObserver } from "../dist/provider-proxy/index.js";
import { readCodexProxySettings } from "../runtime/codex-proxy-env.mjs";
import { createRefreshableHttpProxySelector } from "../runtime/network-proxy.mjs";

const endpoint = "https://ollama.com/v1/responses";
const maximumBytes = 128 * 1024;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const marker = () => `OLC_${randomBytes(16).toString("hex")}`;
const message = text => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const bad = () => { throw new Error("invalid-response"); };

/** One owned proxy selector/dispatcher, shared by public discovery and paid verification. */
export async function withOllamaCloudFetch(environment, signal, operation, fetchImpl) {
  const selector = createRefreshableHttpProxySelector(readCodexProxySettings(environment), environment);
  let dispatcher;
  const abort = () => { void selector.close().catch(() => undefined); void dispatcher?.destroy().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const proxy = await selector.select(new URL(endpoint));
    signal.throwIfAborted();
    if (proxy) dispatcher = new ProxyAgent(proxy);
    return await operation((url, init) => (fetchImpl ?? undiciFetch)(url, {
      ...init, ...(dispatcher ? { dispatcher } : {}),
    }));
  } finally {
    signal.removeEventListener("abort", abort);
    await dispatcher?.destroy().catch(() => undefined);
    await selector.close().catch(() => undefined);
  }
}

/** Two SSE requests per selected level, plus two JSON requests at the source default. */
export async function verifyOllamaCloudResponses({ model, reasoningEfforts, defaultReasoningEffort, apiKey, signal, fetchImpl, assertCurrent }) {
  let requests = 0;
  const inconclusive = reason => ({ status: "inconclusive", reason, requests });
  const request = async (effort, source, stream) => {
    await assertCurrent();
    signal.throwIfAborted();
    if (requests >= reasoningEfforts.length * 2 + 2 || requests >= 16) throw new Error("budget");
    const payload = { model, store: false, stream, max_output_tokens: 768,
      reasoning: { effort }, parallel_tool_calls: false, ...source };
    requests += 1;
    const response = await fetchImpl(endpoint, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", "accept-encoding": "identity", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    if (response.url && response.url !== endpoint || !response.body) { await response.body?.cancel(); bad(); }
    // Adapt transport representation only; the shared reader owns framing,
    // UTF-8, byte/media/encoding limits, cancellation and terminal identity.
    const incoming = Readable.fromWeb(response.body);
    incoming.statusCode = response.status;
    incoming.headers = Object.fromEntries(response.headers);
    const observer = new DirectResponsesObserver();
    const evidence = streamEvidence();
    let terminal;
    try {
      await consumeDirectResponses(incoming, { request: payload, signal, maximumResponseBytes: maximumBytes, observer,
        headers() {}, content() {}, async emit(value, isTerminal) {
          if (stream) evidence.observe(value);
          if (isTerminal) terminal = stream ? value.response : value;
        },
      });
      signal.throwIfAborted();
      const output = validateOutput(terminal, model);
      if (observer.status !== "completed") bad();
      if (stream) evidence.finish(output);
      return output;
    } finally {
      incoming.destroy();
      await finished(incoming).catch(() => undefined);
    }
  };
  const roundtrip = async (effort, stream) => {
      const argument = marker();
      const tool = { type: "function", name: "olc_verify_marker", description: "Simulated marker lookup; no external operation.", strict: true,
        parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false } };
      const input = [message(`Call olc_verify_marker exactly once with key ${argument}. After its simulated result, reply with precisely the returned marker and no other text.`)];
      const output = await request(effort, { input, tools: [tool], tool_choice: { type: "function", name: tool.name } }, stream);
      const calls = output.filter(item => item.type === "function_call");
      const call = calls[0];
      if (calls.length !== 1 || call.name !== tool.name || call.namespace != null
        || typeof call.call_id !== "string" || !call.call_id || call.call_id.length > 256
        || typeof call.arguments !== "string" || call.encrypted_content != null || call.encrypted_function_args != null) throw new Error("tool-history");
      let args;
      try { args = JSON.parse(call.arguments); } catch { throw new Error("tool-arguments"); }
      if (!record(args) || Object.keys(args).length !== 1 || args.key !== argument) throw new Error("tool-arguments");
      const result = marker();
      const final = await request(effort, { input: [...input, ...output, { type: "function_call_output", call_id: call.call_id, output: result }],
        tools: [tool], tool_choice: "none" }, stream);
      if (final.some(item => item.type === "function_call")
        || final.filter(item => item.type === "message").flatMap(item => item.content).map(part => part.text).join("").trim() !== result) throw new Error("tool-result");
  };
  try {
    for (const effort of reasoningEfforts) await roundtrip(effort, true);
    await roundtrip(defaultReasoningEffort, false);
    signal.throwIfAborted();
    return { status: "verified", requests, verifiedAt: new Date().toISOString(), reasoningEfforts: [...reasoningEfforts], jsonReasoningEffort: defaultReasoningEffort };
  } catch (error) {
    if (error?.code === "stale-preview") throw error;
    return inconclusive(signal.aborted ? "cancelled-or-timeout"
      : ["tool-history", "tool-arguments", "tool-result"].includes(error?.message) ? error.message
        : error?.upstreamStatus === 429 ? "http:429" : "invalid-response-or-network");
  }
}

function validateOutput(parsed, model) {
  if (!record(parsed) || parsed.object !== "response" || parsed.status !== "completed"
    || parsed.model !== model || parsed.error != null || parsed.incomplete_details != null
    || !Array.isArray(parsed.output) || parsed.output.length > 32) bad();
  // Native Codex parses these fields before accepting response.completed.
  if (parsed.end_turn != null && typeof parsed.end_turn !== "boolean") bad();
  if (parsed.usage_metadata != null && (!record(parsed.usage_metadata)
    || parsed.usage_metadata.amount != null && typeof parsed.usage_metadata.amount !== "string")) bad();
  if (parsed.usage != null) {
    const usage = parsed.usage;
    if (!record(usage) || ["input_tokens", "output_tokens", "total_tokens"].some(key => !tokenCount(usage[key]))
      || usage.codex_rollout_budget_units != null && !Number.isFinite(usage.codex_rollout_budget_units)
      || usage.input_tokens_details != null && (!record(usage.input_tokens_details)
        || !tokenCount(usage.input_tokens_details.cached_tokens)
        || Object.hasOwn(usage.input_tokens_details, "cache_write_tokens") && !tokenCount(usage.input_tokens_details.cache_write_tokens))
      || usage.output_tokens_details != null && (!record(usage.output_tokens_details)
        || !tokenCount(usage.output_tokens_details.reasoning_tokens))) bad();
  }
  const ids = new Set();
  for (const item of parsed.output) {
    validateItem(item, true);
    if (item.id != null && ids.has(item.id)) bad();
    if (item.id != null) ids.add(item.id);
  }
  return parsed.output;
}

const tokenCount = value => Number.isSafeInteger(value) && value >= 0;

/** Check the fields consumed by locked Codex ResponseItem, not just marker text. */
function validateItem(item, completed) {
  if (!record(item) || !["message", "reasoning", "function_call"].includes(item.type)
    || item.status != null && !(completed ? ["completed"] : ["in_progress", "completed"]).includes(item.status)
    || item.id != null && (typeof item.id !== "string" || !item.id)
    || item.encrypted_content != null && typeof item.encrypted_content !== "string") bad();
  const metadata = item.internal_chat_message_metadata_passthrough;
  if (metadata != null && (!record(metadata)
    || metadata.turn_id != null && typeof metadata.turn_id !== "string"
    || metadata.create_time != null && !Number.isFinite(metadata.create_time))) bad();
  if (item.type === "function_call" && (typeof item.name !== "string" || !item.name
    || typeof item.call_id !== "string" || !item.call_id || typeof item.arguments !== "string"
    || item.namespace != null && typeof item.namespace !== "string"
    || item.encrypted_function_args != null && (!Array.isArray(item.encrypted_function_args)
      || item.encrypted_function_args.some(value => typeof value !== "string")))) bad();
  if (item.type === "message" && (item.role !== "assistant"
    || item.phase != null && !["commentary", "partial_answer", "final_answer"].includes(item.phase)
    || !Array.isArray(item.content) || item.content.some(part => !record(part)
      || part.type !== "output_text" || typeof part.text !== "string"
      || ["annotations", "logprobs"].some(key => part[key] != null && !Array.isArray(part[key]))))) bad();
  if (item.type === "reasoning" && (!Array.isArray(item.summary)
    || item.summary.some(part => !record(part) || part.type !== "summary_text" || typeof part.text !== "string")
    || item.content != null && (!Array.isArray(item.content)
      || item.content.some(part => !record(part) || !["reasoning_text", "text"].includes(part.type) || typeof part.text !== "string")))) bad();
}

/** Native Codex dispatches output_item.done, so a terminal snapshot alone is insufficient. */
function streamEvidence() {
  const added = new Map(), done = new Map(), argumentsDelta = new Map(), argumentsDone = new Map(), textDelta = new Map(), textDone = new Map();
  let events = 0;
  const index = value => {
    if (!Number.isSafeInteger(value.output_index) || value.output_index < 0 || value.output_index >= 32) bad();
    return value.output_index;
  };
  const known = (value, type) => {
    const key = index(value), item = added.get(key);
    if (!item || item.type !== type || item.id !== value.item_id || done.has(key)) bad();
    return key;
  };
  const textKey = value => {
    const key = known(value, "message");
    if (!Number.isSafeInteger(value.content_index) || value.content_index < 0 || value.content_index >= 32) bad();
    return `${key}:${value.content_index}`;
  };
  return {
    observe(value) {
      if (++events > 512) bad();
      // Malformed optional envelope fields make native ResponsesStreamEvent
      // deserialization fail even when the event's item itself is valid.
      if (["item_id", "call_id", "delta", "text"].some(key => value[key] != null && typeof value[key] !== "string")
        || ["summary_index", "content_index"].some(key => value[key] != null && !Number.isSafeInteger(value[key]))) bad();
      if (value.type === "response.output_item.added") {
        const key = index(value);
        if (added.has(key) || !record(value.item) || typeof value.item.id !== "string" || !value.item.id) bad();
        validateItem(value.item, false);
        added.set(key, value.item);
      } else if (value.type === "response.output_item.done") {
        const key = index(value), item = added.get(key);
        if (!item || done.has(key) || !record(value.item) || value.item.id !== item.id || value.item.type !== item.type
          || value.item.status != null && value.item.status !== "completed") bad();
        validateItem(value.item, true);
        done.set(key, value.item);
      } else if (value.type === "response.function_call_arguments.delta") {
        const key = known(value, "function_call");
        if (argumentsDone.has(key) || typeof value.delta !== "string") bad();
        argumentsDelta.set(key, (argumentsDelta.get(key) ?? "") + value.delta);
      } else if (value.type === "response.function_call_arguments.done") {
        const key = known(value, "function_call");
        if (argumentsDone.has(key) || typeof value.arguments !== "string"
          || argumentsDelta.has(key) && argumentsDelta.get(key) !== value.arguments) bad();
        argumentsDone.set(key, value.arguments);
      } else if (value.type === "response.output_text.delta") {
        const key = textKey(value);
        if (textDone.has(key) || typeof value.delta !== "string") bad();
        textDelta.set(key, (textDelta.get(key) ?? "") + value.delta);
      } else if (value.type === "response.output_text.done") {
        const key = textKey(value);
        if (textDone.has(key) || typeof value.text !== "string" || (textDelta.get(key) ?? "") !== value.text) bad();
        textDone.set(key, value.text);
      }
    },
    finish(output) {
      for (const [key, item] of done) if (!isDeepStrictEqual(item, output[key])) bad();
      for (const [key, item] of output.entries()) {
        // The explicit history replay must contain only items native Codex
        // actually received, including reasoning items needed by the next call.
        if (!done.has(key)) bad();
        if (item.type === "function_call") {
          const initial = added.get(key);
          if (!initial || initial.name !== item.name || initial.call_id !== item.call_id
            || initial.arguments != null && initial.arguments !== "" && initial.arguments !== item.arguments) bad();
          if (argumentsDelta.has(key) && argumentsDelta.get(key) !== item.arguments
            || argumentsDone.has(key) && argumentsDone.get(key) !== item.arguments) bad();
        } else if (item.type === "message") {
          for (const [partIndex, part] of item.content.entries()) if ((textDelta.get(`${key}:${partIndex}`) ?? "") !== part.text) bad();
        }
      }
      for (const [key, text] of textDelta) {
        const [outputIndex, partIndex] = key.split(":").map(Number);
        if (output[outputIndex]?.type !== "message" || output[outputIndex]?.content[partIndex]?.text !== text) bad();
      }
      for (const key of added.keys()) if (!done.has(key) || output[key] === undefined) bad();
    },
  };
}
