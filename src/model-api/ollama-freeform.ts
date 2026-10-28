import { ModelConversionError, toolSearchArguments } from "./validation.js";
import { stripEncryptedMarker } from "./codex-private-items.js";
import { createHash } from "node:crypto";

type Json = Record<string, unknown>;
type Identity = { name: string; namespace?: string; kind: "custom" | "function" | "tool_search" };
const argumentLimit = 1024 * 1024;
const bufferLimit = 2 * 1024 * 1024;
const callLimit = 64;
const eventLimit = 65536;
const jsonString = '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
const jsonSpace = "[ \\t\\r\\n]*";
const inputEnvelope = new RegExp(`^${jsonSpace}\\{${jsonSpace}(${jsonString})${jsonSpace}:${jsonSpace}(${jsonString})${jsonSpace}\\}${jsonSpace}$`, "u");
const searchValue = `(?:${jsonString}|null|[0-9]+)`;
const searchEnvelope = new RegExp(`^${jsonSpace}\\{${jsonSpace}(${jsonString})${jsonSpace}:${jsonSpace}${searchValue}(?:${jsonSpace},${jsonSpace}(${jsonString})${jsonSpace}:${jsonSpace}${searchValue})?${jsonSpace}\\}${jsonSpace}$`, "u");

function fail(): never { throw new ModelConversionError("Invalid or unsupported Ollama Cloud freeform tool representation"); }
function record(value: unknown): value is Json { return value !== null && typeof value === "object" && !Array.isArray(value); }
function wellFormed(value: string): boolean { return !/[\uD800-\uDFFF]/u.test(value); }
function text(value: unknown): string { if (typeof value !== "string" || !value.length || value.length > 200 || /\p{Cc}/u.test(value) || !wellFormed(value)) fail(); return value; }
function bytes(value: string): number { return Buffer.byteLength(value); }
function rawInput(value: unknown): string {
  if (typeof value !== "string" || !wellFormed(value) || bytes(value) > argumentLimit) fail();
  return value;
}
function key(name: string, namespace?: string): string { return JSON.stringify([namespace ?? null, name]); }
function identity(item: Json): { name: string; namespace?: string } {
  return { name: text(item.name), ...(item.namespace == null ? {} : { namespace: text(item.namespace) }) };
}
function unpack(argumentsValue: unknown): string {
  if (typeof argumentsValue !== "string" || bytes(argumentsValue) > argumentLimit) fail();
  const match = inputEnvelope.exec(argumentsValue);
  if (!match) fail();
  try { if (JSON.parse(match[1]!) !== "input") fail(); const input = JSON.parse(match[2]!) as string; if (!wellFormed(input)) fail(); return input; }
  catch { return fail(); }
}
function searchArguments(value: unknown): Json {
  const args = toolSearchArguments(value);
  if (typeof args.query !== "string" || !wellFormed(args.query) || bytes(JSON.stringify(args)) > argumentLimit) fail();
  return args;
}
function unpackSearch(value: unknown): string {
  const raw = rawInput(value);
  // A search has only query and optional limit. Check the envelope before JSON.parse
  // so duplicate members cannot silently select a different query or limit.
  const match = searchEnvelope.exec(raw);
  if (!match) fail();
  let parsed: unknown;
  try {
    if (match[2] !== undefined && JSON.parse(match[1]!) === JSON.parse(match[2])) fail();
    parsed = JSON.parse(raw);
  } catch { fail(); }
  return JSON.stringify(searchArguments(parsed));
}
function plain(item: Json): void {
  if (item.encrypted_content != null || item.encrypted_function_args != null) fail();
}
function outputPart(part: unknown): boolean {
  if (!record(part)) return false;
  if (part.type === "input_text") return typeof part.text === "string" && wellFormed(part.text);
  if (part.type === "input_audio") return typeof part.audio_url === "string" && wellFormed(part.audio_url);
  if (part.type === "input_image") return (typeof part.image_url === "string") !== (typeof part.file_id === "string");
  return false;
}

/** Request-local identities; client search uses ordinary Responses functions. */
export function prepareOllamaFreeform(source: Json): { body: Json; adapter: OllamaFreeformResponse } {
  if (!record(source)) fail();
  if (source.stream !== undefined && typeof source.stream !== "boolean") fail();
  if (source.previous_response_id != null || source.conversation != null) fail();
  const identities = new Map<string, Identity>();
  let hostedSearch = false;
  let clientSearch = false;
  const tools: Json[] = [];
  let changed = false;
  const add = (raw: unknown, namespace?: string, loaded = false): Json | undefined => {
    if (!record(raw) || !["custom", "function"].includes(String(raw.type)) || raw.defer_loading === true) fail();
    if (raw.namespace != null) fail();
    if (raw.type === "custom" && (!record(raw.format) || raw.format.type !== "text" && (raw.format.type !== "grammar"
      || raw.format.syntax !== "lark" || typeof raw.format.definition !== "string"))) fail();
    const name = text(raw.name), id = key(name, namespace);
    // Retrieved history stays readable when search is absent/disabled, but
    // cannot introduce executable declarations into a compaction request.
    if (loaded && (!clientSearch || source.tool_choice === "none")) return;
    const previous = identities.get(id);
    if (previous) { if (!loaded || previous.kind !== raw.type) fail(); return; }
    if (identities.size >= 512) fail();
    identities.set(id, { name, ...(namespace === undefined ? {} : { namespace }), kind: raw.type as Identity["kind"] });
    return raw;
  };
  if (source.tools != null) {
    if (!Array.isArray(source.tools)) fail();
    for (const tool of source.tools) {
      if (!record(tool)) fail();
      if (tool.type === "namespace") {
        const namespace = text(tool.name);
        if (tool.defer_loading === true || !Array.isArray(tool.tools)) fail();
        for (const child of tool.tools) add(child, namespace);
        tools.push({ ...tool, tools: [...tool.tools as unknown[]] });
      } else if (tool.type === "web_search") { if (tool.defer_loading === true) fail(); hostedSearch = true; tools.push(tool); }
      else if (tool.type === "tool_search") {
        if (tool.execution !== "client") throw new ModelConversionError("Ollama Cloud 仅支持客户端工具搜索（execution=client），不支持上游服务端工具搜索。");
        if (tool.defer_loading === true || typeof tool.description !== "string" || !record(tool.parameters)
          || Object.keys(tool).some(field => !["type", "execution", "description", "parameters"].includes(field))
          || identities.has(key("tool_search")) || identities.size >= 512) fail();
        identities.set(key("tool_search"), { name: "tool_search", kind: "tool_search" });
        clientSearch = true;
        tools.push({ type: "function", name: "tool_search", description: tool.description, parameters: tool.parameters }); changed = true;
      } else { add(tool); tools.push(tool); }
    }
  }
  // Codex returns retrieved declarations only in tool_search_output. Ollama's
  // ordinary function API needs them explicitly loaded only while this request
  // still declares client search and permits tool calls. Validate passive
  // history as well, without inserting it into current identities or tools.
  if (Array.isArray(source.input)) for (const item of source.input) {
    if (!record(item) || item.type !== "tool_search_output") continue;
    if (item.execution !== "client" || item.status !== "completed" || !Array.isArray(item.tools)) fail();
    for (const entry of item.tools) {
      if (!record(entry)) fail();
      const load = (raw: unknown, namespace?: string): Json | undefined => {
        if (!record(raw)) fail();
        const { defer_loading: deferred, ...eager } = raw;
        if (deferred !== undefined && typeof deferred !== "boolean") fail();
        // These declarations were inside history while the common request
        // normalizer visited top-level tools. They now cross the same boundary.
        if (Object.hasOwn(eager, "parameters")) eager.parameters = stripEncryptedMarker(eager.parameters).value;
        return add(eager, namespace, true);
      };
      if (entry.type === "namespace") {
        const namespace = text(entry.name);
        if (!Array.isArray(entry.tools)) fail();
        const children = entry.tools.flatMap(raw => { const loaded = load(raw, namespace); return loaded ? [loaded] : []; });
        if (children.length) {
          const existing = tools.find(tool => tool.type === "namespace" && tool.name === namespace);
          if (existing) existing.tools = [...existing.tools as unknown[], ...children];
          else { const { defer_loading: unused, ...eager } = entry; void unused; tools.push({ ...eager, tools: children }); }
        }
      } else { const loaded = load(entry); if (loaded) tools.push(loaded); }
    }
    changed = true;
  }
  const checkChoice = (raw: unknown): void => {
    // The locked CLI sends string choices; the public named-choice schema has no namespace field.
    // Do not invent qualified-name aliases or silently choose one namespaced candidate.
    if (!record(raw) || raw.namespace !== undefined) fail();
    if (Object.keys(raw).some(field => !["type", "name"].includes(field))) fail();
    if (raw.type === "web_search" && hostedSearch && raw.name === undefined) return;
    if (raw.type === "tool_search" && identities.get(key("tool_search"))?.kind === "tool_search" && raw.name === undefined) return;
    if (!record(raw) || !["custom", "function"].includes(String(raw.type))) fail();
    const id = identity(raw), found = identities.get(key(id.name, id.namespace));
    if (!found || found.kind !== raw.type) fail();
  };
  if (source.tool_choice != null && (typeof source.tool_choice !== "string" || !["auto", "none", "required"].includes(source.tool_choice))) {
    const choice = source.tool_choice;
    if (record(choice) && choice.type === "allowed_tools") {
      if (Object.keys(choice).some(field => !["type", "mode", "tools"].includes(field))) fail();
      if (!["auto", "required"].includes(String(choice.mode)) || !Array.isArray(choice.tools) || !choice.tools.length) fail();
      const seen = new Set<string>();
      for (const tool of choice.tools) {
        checkChoice(tool);
        const selected = tool as Json;
        const value = selected.type === "web_search" ? "web_search" : key(selected.type === "tool_search" ? "tool_search" : text(selected.name));
        if (seen.has(value)) fail(); seen.add(value);
      }
    } else checkChoice(choice);
  }
  if (source.allowed_tools !== undefined) fail();
  let allowed = new Set(identities.keys());
  if (source.tool_choice === "none") allowed.clear();
  else if (record(source.tool_choice)) {
    const choice = source.tool_choice;
    const selected = choice.type === "allowed_tools" ? choice.tools as Json[] : [choice];
    allowed = new Set(selected.filter(tool => tool.type !== "web_search").map(tool => tool.type === "tool_search" ? key("tool_search") : key(identity(tool).name)));
  }
  const mapChoice = (choice: unknown): unknown => record(choice) && choice.type === "tool_search" ? { type: "function", name: "tool_search" }
    : record(choice) && choice.type === "allowed_tools" ? { ...choice, tools: (choice.tools as unknown[]).map(mapChoice) } : choice;
  const calls = new Map<string, Identity["kind"]>(), outputs = new Set<string>();
  const input = Array.isArray(source.input) ? source.input.map(raw => {
    if (!record(raw)) fail();
    if (raw.type === "item_reference") fail();
    if (raw.type === "tool_search_call") {
      const call = text(raw.call_id);
      if (raw.execution !== "client" || raw.namespace != null || raw.name != null
        || calls.has(call) || outputs.has(call) || raw.status != null && raw.status !== "completed") fail();
      plain(raw); calls.set(call, "tool_search"); changed = true;
      const { execution: unused, arguments: args, ...rest } = raw; void unused;
      return { ...rest, type: "function_call", name: "tool_search", arguments: JSON.stringify(searchArguments(args)) };
    }
    if (raw.type === "tool_search_output") {
      const call = text(raw.call_id);
      if (calls.get(call) !== "tool_search" || outputs.has(call)) fail();
      outputs.add(call); plain(raw); changed = true;
      const { tools: found, execution: unused, ...rest } = raw; void unused;
      return { ...rest, type: "function_call_output", output: JSON.stringify(found) };
    }
    if (raw.type === "function_call" || raw.type === "function_call_output") {
      // Native function history remains upstream-owned, including tools no longer offered.
      // Reserve its explicit IDs only to prevent a custom call borrowing that identity.
      if (typeof raw.call_id === "string" && raw.call_id.length) {
        if (calls.has(raw.call_id) && calls.get(raw.call_id) !== "function") fail(); calls.set(raw.call_id, "function");
      }
      return raw;
    }
    if (raw.type === "custom_tool_call") {
      const call = text(raw.call_id);
      if (calls.has(call) || outputs.has(call)) fail();
      calls.set(call, "custom");
      plain(raw);
      const id = identity(raw), found = identities.get(key(id.name, id.namespace));
      // Compaction sends history without tool declarations. A historical call
      // describes past execution; it must not grant a tool to the next response.
      // Keep current declarations authoritative only for newly returned calls.
      if (found && found.kind !== "custom") fail();
      if (typeof raw.input !== "string" || !wellFormed(raw.input) || bytes(raw.input) > argumentLimit) fail();
      const { input: value, ...rest } = raw; changed = true;
      return { ...rest, type: "function_call", arguments: JSON.stringify({ input: value }) };
    } else if (raw.type === "custom_tool_call_output") {
      const call = text(raw.call_id);
      if (calls.get(call) !== "custom" || outputs.has(call)) fail();
      outputs.add(call);
      plain(raw);
      if (typeof raw.output !== "string" && !Array.isArray(raw.output)) fail();
      if (typeof raw.output === "string" ? !wellFormed(raw.output) : !(raw.output as unknown[]).every(outputPart)) fail();
      changed = true; return { ...raw, type: "function_call_output" };
    }
    return raw;
  }) : source.input;
  for (const [call, kind] of calls) if (kind !== "function" && !outputs.has(call)) fail();
  return { body: changed ? { ...source, tools, ...(source.tool_choice === undefined ? {} : { tool_choice: mapChoice(source.tool_choice) }), input } : source,
    adapter: new OllamaFreeformResponse(identities, allowed, calls) };
}

interface Call {
  id: string; callId: string; index: number; identity: Identity;
  representation: "function_call" | "custom_tool_call";
  arguments: string; initial?: string; input?: string; emitted: boolean; done: boolean;
}

/** Bounded Responses event reducer; no HTTP, accounts, execution, or cross-request history. */
export class OllamaFreeformResponse {
  readonly active: boolean;
  private readonly calls = new Map<string, Call>();
  private readonly callIds = new Map<string, string>();
  private readonly indexes = new Map<number, string>();
  private sequence = 0;
  private eventCount = 0;
  private buffered = 0;
  private total = 0;
  private responseId: string | undefined;
  private terminal = false;
  private readonly items = new Map<string, { index: number; signature: string; added: boolean; done: boolean }>();
  private readonly itemIndexes = new Map<number, string>();
  private readonly toolCalls = new Map<string, string>();
  private readonly completedTools = new Map<string, string>();
  constructor(private readonly identities: ReadonlyMap<string, Identity>, private readonly allowed: ReadonlySet<string>, private readonly historyCalls: ReadonlyMap<string, Identity["kind"]>) {
    this.active = [...identities.values()].some(tool => tool.kind !== "function")
      || [...historyCalls.values()].some(kind => kind !== "function");
  }

  close(): void {
    this.calls.clear(); this.callIds.clear(); this.indexes.clear(); this.items.clear(); this.itemIndexes.clear(); this.toolCalls.clear(); this.completedTools.clear(); this.ordinaryItems.clear(); this.buffered = 0;
  }
  private track(item: Json, index: unknown, phase: "added" | "done" | "terminal"): boolean {
    const id = text(item.id);
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) > 65535) fail();
    const tool = item.type === "function_call" || item.type === "custom_tool_call";
    const callId = tool ? text(item.call_id) : undefined;
    if (callId !== undefined && this.historyCalls.has(callId)) fail();
    const signature = JSON.stringify([item.type, callId, tool ? identity(item) : null]);
    const previous = this.items.get(id);
    if (previous) {
      if (previous.index !== index || previous.signature !== signature || phase === "added" && previous.added) fail();
      if (phase === "terminal" && tool && !previous.done) fail();
      const duplicate = phase === "done" && previous.done;
      if (phase === "done") previous.done = true;
      return duplicate;
    }
    if (phase !== "added" || this.items.size >= 4096 || this.itemIndexes.has(index as number) || callId !== undefined && this.toolCalls.has(callId)) fail();
    if (callId !== undefined) { if (this.toolCalls.size >= callLimit) fail(); this.toolCalls.set(callId, id); }
    this.items.set(id, { index: index as number, signature, added: true, done: false }); this.itemIndexes.set(index as number, id);
    return false;
  }

  private resolve(item: Json): Identity {
    const id = identity(item), found = this.identities.get(key(id.name, id.namespace));
    if (!found || !this.allowed.has(key(id.name, id.namespace))) fail(); return found;
  }
  private call(item: Json, index: unknown, create: boolean): Call {
    const id = text(item.id), callId = text(item.call_id), found = this.resolve(item);
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) > 65535) fail();
    let call = this.calls.get(id);
    if (!call) {
      if (!create || this.calls.size >= callLimit || this.callIds.has(callId) || this.indexes.has(index as number)) fail();
      if (item.type !== "function_call" && item.type !== "custom_tool_call") fail();
      call = { id, callId, index: index as number, identity: found, representation: item.type, arguments: "", emitted: false, done: false };
      this.calls.set(id, call); this.callIds.set(callId, id); this.indexes.set(index as number, id);
    }
    if (call.callId !== callId || call.index !== index || call.representation !== item.type
      || key(call.identity.name, call.identity.namespace) !== key(found.name, found.namespace)) fail();
    return call;
  }
  private finish(call: Call, value: unknown): string {
    const decode = call.identity.kind === "tool_search" ? unpackSearch : call.representation === "function_call" ? unpack : rawInput;
    const input = decode(value);
    if (call.input !== undefined && call.input !== input || call.initial !== undefined && call.initial !== input || call.arguments && decode(call.arguments) !== input) fail();
    if (call.input === undefined) {
      this.buffered -= bytes(call.arguments); call.arguments = "";
      if (call.initial !== undefined) { this.buffered -= bytes(call.initial); delete call.initial; }
      this.buffered += bytes(input); if (this.buffered > bufferLimit) fail(); call.input = input;
    }
    return input;
  }
  private item(item: Json, index: unknown, added: boolean, stream: boolean): Json {
    if (item.type !== "function_call" && item.type !== "custom_tool_call") {
      // These are passive Responses output records. Client-executed tools must use
      // a declaration whose exact identity was validated for this request.
      if (!["message", "reasoning", "web_search_call"].includes(String(item.type))) fail();
      return item;
    }
    if (item.status != null && item.status !== "completed" && (!added || item.status !== "in_progress")) fail();
    const found = this.resolve(item); plain(item);
    if (item.type === "custom_tool_call" && found.kind !== "custom") fail();
    if (found.kind === "function") { rawInput(item.arguments); return item; }
    const value = item.type === "function_call" ? item.arguments : item.input;
    const decode = found.kind === "tool_search" ? unpackSearch : item.type === "function_call" ? unpack : rawInput;
    let input: string;
    if (stream) {
      const call = this.call(item, index, added);
      if (added) {
        if (value !== "") { call.initial = decode(value); this.buffered += bytes(call.initial); if (this.buffered > bufferLimit) fail(); }
        input = "";
      }
      else input = this.finish(call, value);
    } else input = decode(value);
    const { arguments: unused, ...rest } = item; void unused;
    if (found.kind === "tool_search") {
      const { name: unusedName, namespace: unusedNamespace, ...search } = rest; void unusedName; void unusedNamespace;
      return { ...search, type: "tool_search_call", execution: "client", arguments: added ? {} : JSON.parse(input) as Json };
    }
    return { ...rest, type: "custom_tool_call", input };
  }
  json(value: Json): Json {
    if (!Array.isArray(value.output)) fail();
    const seenIds = new Set<string>(), seenCalls = new Set<string>();
    const output = value.output.map((item, index) => {
      if (!record(item)) fail();
      const id = item.id == null ? undefined : text(item.id);
      if (id !== undefined) { if (seenIds.has(id)) fail(); seenIds.add(id); }
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        const call = text(item.call_id);
        if (value.status !== "completed" || seenCalls.has(call) || this.historyCalls.has(call) || seenCalls.size >= callLimit) fail();
        seenCalls.add(call);
      }
      const converted = this.item(item, index, false, false);
      if (converted.type === "custom_tool_call" || converted.type === "tool_search_call") {
        this.buffered += bytes(converted.type === "custom_tool_call" ? String(converted.input) : JSON.stringify(converted.arguments)); if (this.buffered > bufferLimit) fail();
      }
      return converted;
    });
    return { ...value, output };
  }
  event(value: Json): Json[] {
    if (this.terminal || ++this.eventCount > eventLimit) fail();
    this.total += bytes(JSON.stringify(value)); if (this.total > 32 * 1024 * 1024) fail();
    if (typeof value.type !== "string") fail();
    if (value.response_id !== undefined) {
      const id = text(value.response_id);
      if (this.responseId !== undefined && id !== this.responseId) fail(); this.responseId = id;
    }
    const events: Json[] = [];
    const inputEvents = (call: Call): void => {
      if (call.emitted) return;
      if (call.input === undefined) fail();
      if (call.identity.kind === "tool_search") { call.emitted = true; return; }
      const base = { item_id: call.id, output_index: call.index };
      events.push({ ...base, type: "response.custom_tool_call_input.delta", delta: call.input },
        { ...base, type: "response.custom_tool_call_input.done", input: call.input }); call.emitted = true;
    };
    if (["response.created", "response.in_progress", "response.completed", "response.incomplete", "response.failed"].includes(value.type)) {
      if (!record(value.response)) fail();
      const id = text(value.response.id);
      if (this.responseId !== undefined && this.responseId !== id) fail(); this.responseId = id;
    }
    if (value.type === "response.output_item.added" || value.type === "response.output_item.done") {
      if (!record(value.item)) fail();
      const added = value.type === "response.output_item.added";
      const duplicate = this.track(value.item, value.output_index, added ? "added" : "done");
      const converted = this.item(value.item, value.output_index, added, true);
      const tool = converted.type === "function_call" || converted.type === "custom_tool_call" || converted.type === "tool_search_call";
      if (converted.type === "custom_tool_call" || converted.type === "tool_search_call") {
        const call = this.call(value.item, value.output_index, false);
        if (added && call.done) fail();
        if (!added) call.done = true;
      }
      if (tool && !added) {
        const id = text(converted.id), signature = this.toolSignature(converted), previous = this.completedTools.get(id);
        if (previous !== undefined && previous !== signature) fail();
        this.completedTools.set(id, signature);
      } else if (!duplicate) events.push({ ...value, item: converted });
    } else if (["response.function_call_arguments.delta", "response.function_call_arguments.done",
      "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done"].includes(value.type)) {
      const custom = value.type.startsWith("response.custom_tool_call_input.");
      const call = this.calls.get(text(value.item_id));
      if (!call) {
        // No custom identity can be inferred from an arguments-only event.
        const itemId = String(value.item_id), tracked = this.items.get(itemId);
        if (custom || !this.ordinaryItems.has(itemId) || tracked?.done || tracked?.index !== value.output_index
          || value.call_id !== undefined && (typeof value.call_id !== "string" || this.toolCalls.get(value.call_id) !== itemId)) fail();
        events.push(value);
      } else {
        if (custom !== (call.representation === "custom_tool_call") || value.output_index !== call.index
          || value.call_id !== undefined && value.call_id !== call.callId) fail();
        if (value.type.endsWith(".delta")) {
          if (call.input !== undefined || typeof value.delta !== "string") fail();
          const combined = call.arguments + value.delta, size = bytes(combined);
          this.buffered += size - bytes(call.arguments);
          if (size > argumentLimit || this.buffered > bufferLimit) fail(); call.arguments = combined;
        } else this.finish(call, custom ? value.input : value.arguments);
      }
    } else if (["response.completed", "response.incomplete", "response.failed"].includes(value.type)) {
      const response = value.response as Json;
      if (!Array.isArray(response.output)) fail();
      const seen = new Set<string>();
      const output = response.output.map((item, index) => {
        if (!record(item)) fail();
        this.track(item, index, "terminal");
        const id = text(item.id);
        if (seen.has(id)) fail(); seen.add(id);
        const converted = this.item(item, index, false, true);
        if (converted.type === "function_call" || converted.type === "custom_tool_call" || converted.type === "tool_search_call") {
          // Native Codex executes output_item.done immediately, before it sees
          // the response terminal. Publish only after the entire tool set and
          // terminal arguments agree and the response actually completed.
          const completed = this.completedTools.get(id);
          if (value.type !== "response.completed" || response.status !== "completed"
            || completed === undefined || completed !== this.toolSignature(converted)) fail();
        }
        if (converted.type === "custom_tool_call" || converted.type === "tool_search_call") {
          const call = this.call(item, index, false);
          if (!call.done) fail();
        }
        return converted;
      });
      for (const id of this.items.keys()) if (!seen.has(id)) fail();
      for (const item of output) {
        const id = text(item.id);
        if (!this.completedTools.has(id)) continue;
        const call = this.calls.get(id);
        if (call) inputEvents(call);
        events.push({ type: "response.output_item.done", output_index: this.items.get(id)!.index, item });
      }
      events.push({ ...value, response: { ...response, output } }); this.terminal = true; this.buffered = 0;
    } else events.push(value);
    if (value.type === "response.output_item.added" && record(value.item) && value.item.type === "function_call" && this.resolve(value.item).kind === "function") {
      this.ordinaryItems.add(text(value.item.id)); if (this.ordinaryItems.size > callLimit) fail();
    }
    return events.map(event => ({ ...event, sequence_number: this.sequence++ }));
  }
  private toolSignature(item: Json): string {
    // Retain a fixed-size fingerprint, not a second copy of buffered arguments.
    return createHash("sha256").update(JSON.stringify([item.type, item.call_id, item.name, item.namespace, item.execution, item.arguments, item.input])).digest("hex");
  }
  private readonly ordinaryItems = new Set<string>();
}
