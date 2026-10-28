import type { ChatMessage, ChatToolIdentity } from "./responses-to-chat.js";
import { isChatUsageTrailer } from "./chat-response.js";
import { array, customToolInput, ModelConversionError, object, string, toolArguments, toolSearchArguments } from "./validation.js";
import type { JsonObject } from "./validation.js";

type OutputItem = JsonObject & { id: string; type: string };
interface ToolState { name: string; arguments: string; callId: string }
interface ActiveContent { item: OutputItem; index: number; text: string; kind: "message" | "reasoning" | "reasoning_content" }
export interface HostedSearchCall { id: string; query: string }
export interface HostedSearchResult extends HostedSearchCall { sources: Array<{ url: string; title: string }>; text: string }

/** One instance per downstream response, including hosted-search Chat rounds; no cross-request history. */
export class ChatToResponses {
  private sequence = 0;
  private readonly items: OutputItem[] = [];
  private readonly tools = new Map<number, ToolState>();
  private activeContent: ActiveContent | undefined;
  private usage: JsonObject | undefined;
  private readonly previousUsage: Array<JsonObject | undefined> = [];
  private awaitingNextRound = false;
  private readonly hostedItems = new Map<string, { item: OutputItem; index: number }>();
  private roundText = "";
  private roundReasoning = "";
  private roundReasoningContent = "";
  private finishReason: string | undefined;
  private ended = false;
  private bytes = 0;
  constructor(private readonly id: string, private readonly model: string, private readonly toolNames?: ReadonlyMap<string, ChatToolIdentity>, private toolChoice: unknown = "auto") {}

  start(): JsonObject[] { return [this.event("response.created", { response: this.response("in_progress", this.aggregateUsage()) })]; }

  /** Called immediately before submitting a model round, not while preparing it. */
  beginModelRound(toolChoice: unknown = this.toolChoice): void { this.toolChoice = toolChoice; this.awaitingNextRound = false; }

  fail(error: JsonObject): JsonObject[] {
    let usage: JsonObject | undefined;
    try { usage = this.aggregateUsage(); }
    catch (failure) { if (!(failure instanceof ModelConversionError)) throw failure; }
    if (this.ended) return [this.event("response.failed", { response: { ...this.response("failed", usage), error } })];
    this.ended = true;
    return [...this.closeContent("incomplete"), this.event("response.failed", { response: { ...this.response("failed", usage), error } })];
  }

  push(value: unknown): JsonObject[] {
    if (this.ended) throw new ModelConversionError("Chat stream continued after completion");
    const chunk = object(value);
    this.addBytes(JSON.stringify(chunk));
    if (chunk.error != null) throw new ModelConversionError("Chat upstream returned an error");
    if (chunk.usage != null) {
      // Usage is independent evidence, including on an otherwise invalid frame.
      // An invalid replacement must not leave an older snapshot looking final.
      this.usage = undefined;
      this.usage = convertUsage(chunk.usage);
    }
    const choices = array(chunk.choices);
    if (choices.length === 0) return [];
    if (choices.length !== 1) throw new ModelConversionError("Multiple Chat choices are unsupported");
    const choice = object(choices[0]);
    if (choice.index !== 0 || choice.error != null) throw new ModelConversionError("Invalid Chat choice");
    const delta = object(choice.delta);
    if (this.finishReason && isChatUsageTrailer(delta, choice.finish_reason, this.finishReason, chunk.usage)) return [];
    if (this.finishReason && Object.keys(delta).length) throw new ModelConversionError("Chat delta after finish reason");
    if (delta.refusal != null) throw new ModelConversionError("Unsupported Chat content");
    const thought = reasoningText(delta);
    const content = delta.content == null ? "" : string(delta.content);
    const tools = delta.tool_calls == null ? undefined : new Map(this.tools);
    if (tools) for (const raw of array(delta.tool_calls)) {
      const call = object(raw);
      const index = call.index;
      if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= 128) throw new ModelConversionError("Invalid Chat tool index");
      const previous = tools.get(Number(index));
      let state: ToolState;
      if (!previous) {
        if (call.type !== "function") throw new ModelConversionError("Unsupported Chat tool type");
        const callId = string(call.id);
        if (!callId || [...tools.values()].some(entry => entry.callId === callId)) throw new ModelConversionError("Invalid Chat tool identity");
        state = { callId, name: "", arguments: "" };
      } else {
        if ((call.id != null && call.id !== previous.callId) || (call.type != null && call.type !== "function")) throw new ModelConversionError("Chat tool identity changed");
        state = { ...previous };
      }
      const fn = object(call.function);
      if (fn.name != null) state.name += string(fn.name);
      if (fn.arguments != null) {
        state.arguments += string(fn.arguments);
      }
      tools.set(Number(index), state);
    }
    let finishReason = this.finishReason;
    if (choice.finish_reason != null) {
      if (this.finishReason || !["stop", "tool_calls", "length", "content_filter"].includes(string(choice.finish_reason))) throw new ModelConversionError("Chat upstream failed to finish normally");
      finishReason = string(choice.finish_reason);
    }
    // No content lifecycle or tool mutation is committed until the whole frame
    // is valid; otherwise generated close events could be lost on an exception.
    if (tools) { this.tools.clear(); for (const [index, state] of tools) this.tools.set(index, state); }
    this.finishReason = finishReason;
    const events: JsonObject[] = [];
    if (thought.kind === "reasoning_content") this.roundReasoningContent += thought.text;
    else this.roundReasoning += thought.text;
    events.push(...this.appendContent(thought.kind, thought.text));
    this.roundText += content;
    events.push(...this.appendContent("message", content));
    return events;
  }

  /** 所有并行调用先一起校验，保证无效客户端调用不能伴随已执行的搜索。 */
  hostedSearchCalls(name: string): HostedSearchCall[] {
    if (this.ended || !this.finishReason) throw new ModelConversionError("Chat stream ended without a finish reason");
    if (this.finishReason === "length" || this.finishReason === "content_filter") return [];
    this.validateCalls();
    return [...this.tools.values()].filter(state => state.name === name).map(state => {
      if (this.toolNames?.get(name)?.kind !== "web_search") throw new ModelConversionError("Unknown hosted web search tool");
      return { id: state.callId, query: hostedSearchQuery(state.arguments) };
    });
  }

  lastRoundOutputTokens(): number | undefined { return this.usage ? Number(this.usage.output_tokens) : undefined; }

  beginHostedSearch(call: HostedSearchCall): JsonObject[] {
    const state = [...this.tools.values()].find(state => state.callId === call.id);
    if (!state || this.hostedItems.has(call.id) || this.toolNames?.get(state.name)?.kind !== "web_search"
      || !this.hostedSearchCalls(state.name).some(entry => entry.id === call.id && entry.query === call.query)) throw new ModelConversionError("Invalid hosted web search call");
    const events = this.closeContent();
    const item: OutputItem = { id: `${this.id}_search_${this.items.length}`, type: "web_search_call", status: "in_progress" };
    const index = this.items.length;
    this.hostedItems.set(call.id, { item, index });
    events.push(...this.addItem(item));
    events.push(this.event("response.web_search_call.in_progress", { item_id: item.id, output_index: index }));
    events.push(this.event("response.web_search_call.searching", { item_id: item.id, output_index: index }));
    return events;
  }

  completeHostedSearches(name: string, results: HostedSearchResult[]): {
    events: JsonObject[]; message: ChatMessage; toolMessages: ChatMessage[]; deferredClientCalls: number;
  } {
    const calls = this.hostedSearchCalls(name);
    if (!calls.length || results.length !== calls.length || new Set(results.map(result => result.id)).size !== calls.length) throw new ModelConversionError("Missing hosted web search results");
    const completed = calls.map(call => {
      const result = results.find(result => result.id === call.id);
      const active = this.hostedItems.get(call.id);
      if (!result || !active || result.query !== call.query || typeof result.text !== "string") throw new ModelConversionError("Invalid hosted web search result");
      const sources = result.sources.map(source => {
        let url: URL;
        try { url = new URL(source.url); } catch { throw new ModelConversionError("Invalid hosted web search source"); }
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || typeof source.title !== "string") throw new ModelConversionError("Invalid hosted web search source");
        return { type: "url", url: source.url, title: source.title };
      });
      return { active, item: { ...active.item, status: "completed", action: { type: "search", query: call.query, queries: [call.query], sources } } };
    });
    this.addBytes(JSON.stringify(results));
    // These calls stay inside this response. Give each model round distinct
    // Chat IDs even if the upstream reuses a call ID on its next HTTP request.
    const roundCalls = [...this.tools].map(([index, state]) => ({
      state, id: `${this.id}_round_${this.previousUsage.length}_call_${index}`,
    }));
    const message: ChatMessage = { role: "assistant", content: this.roundText || null,
      ...(this.roundReasoning ? { reasoning: this.roundReasoning } : {}),
      ...(this.roundReasoningContent ? { reasoning_content: this.roundReasoningContent } : {}),
      tool_calls: roundCalls.map(({ state, id }) => ({ id, type: "function", function: { name: state.name, arguments: state.arguments } })),
    };
    const deferred = JSON.stringify({
      status: "not_executed",
      reason: "This client tool was not dispatched because this response also requested hosted web search. Review the search results and issue the client tool again in a separate model response without hosted search. No client action or approval has occurred.",
    });
    const toolMessages: ChatMessage[] = roundCalls.map(({ state, id }) => ({
      role: "tool", tool_call_id: id,
      content: state.name === name ? results.find(result => result.id === state.callId)!.text : deferred,
    }));
    const deferredClientCalls = roundCalls.filter(({ state }) => state.name !== name).length;
    this.addBytes(deferred.repeat(deferredClientCalls));
    const events: JsonObject[] = [];
    for (const { active, item } of completed) {
      this.items[active.index] = item;
      events.push(this.event("response.web_search_call.completed", { item_id: item.id, output_index: active.index }));
      events.push(this.event("response.output_item.done", { item, output_index: active.index }));
    }
    // No client call from the mixed round was published or executed. Its
    // explicit non-execution result lets the model reconsider after searching.
    this.tools.clear();
    this.hostedItems.clear();
    this.previousUsage.push(this.usage);
    this.usage = undefined;
    this.awaitingNextRound = true;
    this.finishReason = undefined;
    this.roundText = ""; this.roundReasoning = ""; this.roundReasoningContent = "";
    return { events, message, toolMessages, deferredClientCalls };
  }

  finish(): JsonObject[] {
    if (this.ended || !this.finishReason) throw new ModelConversionError("Chat stream ended without a finish reason");
    if (this.finishReason === "length" || this.finishReason === "content_filter") {
      const usage = this.aggregateUsage();
      this.ended = true;
      const events = this.closeContent("incomplete");
      return [...events, this.event("response.incomplete", { response: { ...this.response("incomplete", usage), incomplete_details: { reason: this.finishReason === "length" ? "max_output_tokens" : "content_filter" } } })];
    }
    const calls = this.validateCalls().map(([index, state, identity]) => {
      if (identity?.kind === "web_search") throw new ModelConversionError("Unexecuted hosted web search call");
      const id = `${this.id}_call_${index}`;
      // A hosted-search continuation is another upstream request and can reuse
      // an earlier raw call ID. Publish a response-scoped ID so the next full
      // Responses history can pair its actual client result without collisions.
      return toolCallItem(id, this.previousUsage.length > 0 ? { ...state, callId: id } : state, identity);
    });
    if (!this.roundText && !this.roundReasoning && !this.roundReasoningContent && !calls.length) throw new ModelConversionError("Empty Chat response");
    const usage = this.aggregateUsage();
    this.ended = true;
    const events = this.closeContent();
    // Keep partial or invalid tool calls away from the client. Publish validated
    // calls after content, each with a complete identity and paired lifecycle.
    for (const item of calls) {
      const output_index = this.items.length;
      events.push(...this.addItem(item.type === "function_call"
        ? { ...item, arguments: "", status: "in_progress" }
        : item.type === "custom_tool_call"
          ? { ...item, input: "", status: "in_progress" }
          : { ...item, status: "in_progress" }));
      this.items[output_index] = item;
      if (item.type === "function_call") {
        events.push(this.event("response.function_call_arguments.done", { item_id: item.id, output_index, arguments: item.arguments }));
      } else if (item.type === "custom_tool_call") {
        events.push(this.event("response.custom_tool_call_input.done", { item_id: item.id, output_index, input: item.input }));
      }
      events.push(this.event("response.output_item.done", { item, output_index }));
    }
    events.push(this.event("response.completed", { response: this.response("completed", usage) }));
    return events;
  }

  private appendContent(kind: ActiveContent["kind"], text: string): JsonObject[] {
    if (!text) return [];
    const events: JsonObject[] = [];
    if (this.activeContent?.kind !== kind) {
      events.push(...this.closeContent());
      const index = this.items.length;
      const item: OutputItem = kind === "message"
        ? { id: `${this.id}_message_${index}`, type: "message", role: "assistant", status: "in_progress", content: [] }
        : { id: `${this.id}_reasoning_${index}`, type: "reasoning", summary: [], ...(kind === "reasoning_content" ? { content: [] } : {}) };
      this.activeContent = { kind, item, index, text: "" };
      events.push(...this.addItem(item));
      events.push(kind === "reasoning"
        ? this.event("response.reasoning_summary_part.added", { item_id: item.id, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } })
        : this.event("response.content_part.added", { item_id: item.id, output_index: index, content_index: 0, part: kind === "message" ? { type: "output_text", text: "", annotations: [] } : { type: "reasoning_text", text: "" } }));
    }
    const active = this.activeContent;
    if (!active) throw new ModelConversionError("Missing active response item");
    active.text += text;
    events.push(kind === "message"
      ? this.event("response.output_text.delta", { item_id: active.item.id, output_index: active.index, content_index: 0, delta: text })
      : kind === "reasoning"
        ? this.event("response.reasoning_summary_text.delta", { item_id: active.item.id, output_index: active.index, summary_index: 0, delta: text })
        : this.event("response.reasoning_text.delta", { item_id: active.item.id, output_index: active.index, content_index: 0, delta: text }));
    return events;
  }

  private closeContent(status = "completed"): JsonObject[] {
    const active = this.activeContent;
    if (!active) return [];
    this.activeContent = undefined;
    const { item, index: output_index, text, kind } = active;
    const fields = { item_id: item.id, output_index };
    const part = kind === "message"
      ? { type: "output_text", text, annotations: [] }
      : { type: kind === "reasoning" ? "summary_text" : "reasoning_text", text };
    const completed = kind === "message"
      ? { ...item, status, content: [part] }
      : kind === "reasoning" ? { ...item, summary: [part] } : { ...item, content: [part] };
    this.items[output_index] = completed;
    return [
      kind === "message"
        ? this.event("response.output_text.done", { ...fields, content_index: 0, text })
        : kind === "reasoning"
          ? this.event("response.reasoning_summary_text.done", { ...fields, summary_index: 0, text })
          : this.event("response.reasoning_text.done", { ...fields, content_index: 0, text }),
      kind === "reasoning"
        ? this.event("response.reasoning_summary_part.done", { ...fields, summary_index: 0, part })
        : this.event("response.content_part.done", { ...fields, content_index: 0, part }),
      this.event("response.output_item.done", { item: completed, output_index }),
    ];
  }

  private addItem(item: OutputItem): JsonObject[] {
    const output_index = this.items.length;
    this.items.push(item);
    return [this.event("response.output_item.added", { item: { ...item }, output_index })];
  }
  private aggregateUsage(): JsonObject | undefined {
    return aggregateUsage(this.awaitingNextRound ? this.previousUsage : [...this.previousUsage, this.usage]);
  }
  private response(status: string, usage?: JsonObject): JsonObject {
    return { id: this.id, object: "response", model: this.model, status, output: [...this.items], ...(usage ? { usage } : {}) };
  }
  private addBytes(text: string): void {
    this.bytes += Buffer.byteLength(text, "utf8");
    if (this.bytes > 16 * 1024 * 1024) throw new ModelConversionError("Chat response exceeds size limit");
  }
  private validateCalls(): Array<[number, ToolState, ChatToolIdentity | undefined]> {
    if ((this.tools.size > 0) !== (this.finishReason === "tool_calls")) throw new ModelConversionError("Chat tool finish reason mismatch");
    const choice = this.toolChoice;
    let allowed: ReadonlySet<string> | undefined;
    let required = choice === "required";
    if (choice !== undefined && choice !== "auto" && choice !== "required") {
      allowed = new Set<string>();
      if (choice !== "none") {
        const selected = object(choice);
        if (selected.type === "function") {
          allowed = new Set([string(object(selected.function).name)]); required = true;
        } else if (selected.type === "allowed_tools") {
          const subset = object(selected.allowed_tools);
          if (subset.mode !== "auto" && subset.mode !== "required") throw new ModelConversionError("Invalid Chat tool choice");
          allowed = new Set(array(subset.tools).map(raw => string(object(object(raw).function).name)));
          required = subset.mode === "required";
        }
        // Unmapped upstream-owned choices grant no local client tool identity.
      }
    }
    if (required && !this.tools.size) throw new ModelConversionError("Required Chat tool call is missing", { toolChoiceViolation: true });
    return [...this.tools].map(([index, state]) => {
      if (!state.name) throw new ModelConversionError("Missing Chat tool name");
      if (allowed && !allowed.has(state.name)) throw new ModelConversionError("Chat tool call violates tool choice", { toolChoiceViolation: true });
      const identity = this.toolNames?.get(state.name);
      if (this.toolNames && !identity) throw new ModelConversionError("Unknown Chat tool name");
      if (identity?.kind === "web_search") hostedSearchQuery(state.arguments);
      else toolCallItem(`${this.id}_validate_${index}`, state, identity);
      return [index, state, identity];
    });
  }
  private event(type: string, fields: JsonObject): JsonObject { return { type, sequence_number: this.sequence++, ...fields }; }
}

function hostedSearchQuery(text: string): string {
  const source = toolArguments(text, "Invalid hosted web search arguments");
  if (Object.keys(source).some(key => key !== "query")) throw new ModelConversionError("Unsupported hosted web search arguments");
  const query = string(source.query);
  if (!query.trim() || query.length > 2048) throw new ModelConversionError("Invalid hosted web search query");
  return query;
}

function aggregateUsage(rounds: Array<JsonObject | undefined>): JsonObject | undefined {
  if (rounds.some(usage => usage === undefined)) return undefined;
  const known = rounds as JsonObject[];
  const sum = (key: string): number => {
    const value = known.reduce((total, usage) => total + Number(usage[key]), 0);
    if (!Number.isSafeInteger(value)) throw new ModelConversionError("Invalid accumulated Chat usage");
    return value;
  };
  const result: JsonObject = { input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), total_tokens: sum("total_tokens") };
  for (const [key, field] of [["input_tokens_details", "cached_tokens"], ["output_tokens_details", "reasoning_tokens"]] as const) {
    if (known.every(usage => usage[key] != null && object(usage[key])[field] != null)) {
      const value = known.reduce((total, usage) => total + Number(object(usage[key])[field]), 0);
      if (!Number.isSafeInteger(value)) throw new ModelConversionError("Invalid accumulated Chat usage");
      result[key] = { [field]: value };
    }
  }
  return result;
}

/**
 * Chat function 调用按声明时的原始形态还原：function 为函数调用，custom 取回自由格式文本，
 * 客户端 tool_search 还原为带 execution=client 的检索调用；三者都经过同一套参数校验。
 */
function toolCallItem(id: string, state: ToolState, identity: ChatToolIdentity | undefined): OutputItem {
  const kind = identity?.kind ?? "function";
  const fields = {
    id,
    call_id: state.callId,
    name: identity?.name ?? state.name,
    ...(identity?.namespace === undefined ? {} : { namespace: identity.namespace }),
  };
  if (kind === "web_search") throw new ModelConversionError("Hosted web search cannot become a client tool call");
  if (kind === "custom") {
    return { ...fields, type: "custom_tool_call", input: customToolInput(toolArguments(state.arguments, "Invalid custom tool arguments")), status: "completed" };
  }
  if (kind === "tool_search") {
    return { id, type: "tool_search_call", call_id: state.callId, status: "completed", execution: "client",
      arguments: toolSearchArguments(toolArguments(state.arguments, "Invalid tool search arguments")) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(state.arguments); }
  catch { throw new ModelConversionError("Invalid Chat tool arguments", toolArgumentFailure(state.arguments, "invalid_json")); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelConversionError("Invalid Chat tool arguments", toolArgumentFailure(state.arguments, "not_object"));
  }
  return { ...fields, type: "function_call", arguments: state.arguments, status: "completed" };
}

/** 工具参数诊断只保留长度与形态分类，不携带上游正文或用户内容。 */
function toolArgumentFailure(text: string, shape: "invalid_json" | "not_object"): Record<string, string | number> {
  return { "toolArguments.length": text.length, "toolArguments.shape": text === "" ? "empty" : shape };
}

function reasoningText(delta: JsonObject): { kind: "reasoning" | "reasoning_content"; text: string } {
  const text = delta.reasoning == null ? "" : string(delta.reasoning);
  const fullText = delta.reasoning_content == null ? "" : string(delta.reasoning_content);
  const details = delta.reasoning_details == null ? "" : array(delta.reasoning_details).map(raw => {
    const detail = object(raw);
    if (detail.type !== "reasoning.text" || detail.signature != null || detail.data != null) {
      throw new ModelConversionError("Unsupported Chat reasoning details");
    }
    return string(detail.text);
  }).join("");
  // Cline mirrors the same plaintext in both fields within each SSE delta.
  // Reject conflicting representations instead of silently losing either one.
  const representations = [text, fullText, details].filter(value => value !== "");
  if (new Set(representations).size > 1) throw new ModelConversionError("Conflicting Chat reasoning text");
  return { kind: fullText ? "reasoning_content" : "reasoning", text: representations[0] ?? "" };
}

function convertUsage(value: unknown): JsonObject {
  const source = object(value);
  const count = (value: unknown): number => {
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ModelConversionError("Invalid Chat usage");
    return Number(value);
  };
  const input = count(source.prompt_tokens), output = count(source.completion_tokens);
  const result: JsonObject = { input_tokens: input, output_tokens: output, total_tokens: count(input + output) };
  if (source.prompt_tokens_details != null) {
    const cached = object(source.prompt_tokens_details).cached_tokens;
    if (cached != null) {
      const tokens = count(cached);
      if (tokens > input) throw new ModelConversionError("Invalid Chat cached usage");
      result.input_tokens_details = { cached_tokens: tokens };
    }
  }
  if (source.completion_tokens_details != null) {
    const reasoning = object(source.completion_tokens_details).reasoning_tokens;
    if (reasoning != null) result.output_tokens_details = { reasoning_tokens: count(reasoning) };
  }
  return result;
}
