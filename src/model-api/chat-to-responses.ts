import type { ChatToolIdentity } from "./responses-to-chat.js";
import { array, ModelConversionError, object, string } from "./validation.js";
import type { JsonObject } from "./validation.js";

type OutputItem = JsonObject & { id: string; type: string };
interface ToolState { name: string; arguments: string; callId: string }
interface ActiveContent { item: OutputItem; index: number; text: string; kind: "message" | "reasoning" }

/** One instance per upstream response; no cross-request history or provider configuration. */
export class ChatToResponses {
  private sequence = 0;
  private readonly items: OutputItem[] = [];
  private readonly tools = new Map<number, ToolState>();
  private activeContent: ActiveContent | undefined;
  private usage: JsonObject | undefined;
  private finishReason: string | undefined;
  private ended = false;
  private bytes = 0;
  constructor(private readonly id: string, private readonly model: string, private readonly toolNames?: ReadonlyMap<string, ChatToolIdentity>) {}

  start(): JsonObject[] { return [this.event("response.created", { response: this.response("in_progress") })]; }

  push(value: unknown): JsonObject[] {
    if (this.ended) throw new ModelConversionError("Chat stream continued after completion");
    const chunk = object(value);
    this.bytes += JSON.stringify(chunk).length;
    if (this.bytes > 16 * 1024 * 1024) throw new ModelConversionError("Chat response exceeds size limit");
    if (chunk.error != null) throw new ModelConversionError("Chat upstream returned an error");
    if (chunk.usage != null) this.usage = convertUsage(chunk.usage);
    const choices = array(chunk.choices);
    if (choices.length === 0) return [];
    if (choices.length !== 1) throw new ModelConversionError("Multiple Chat choices are unsupported");
    const choice = object(choices[0]);
    if (choice.index !== 0 || choice.error != null) throw new ModelConversionError("Invalid Chat choice");
    const delta = object(choice.delta);
    if (this.finishReason && Object.keys(delta).length) throw new ModelConversionError("Chat delta after finish reason");
    if (delta.refusal != null || delta.reasoning_details != null) throw new ModelConversionError("Unsupported Chat content");
    const events: JsonObject[] = [];
    if (delta.reasoning != null) events.push(...this.appendContent("reasoning", string(delta.reasoning)));
    if (delta.content != null) events.push(...this.appendContent("message", string(delta.content)));
    if (delta.tool_calls != null) for (const raw of array(delta.tool_calls)) {
      const call = object(raw);
      const index = call.index;
      if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= 128) throw new ModelConversionError("Invalid Chat tool index");
      let state = this.tools.get(Number(index));
      if (!state) {
        if (call.type !== "function") throw new ModelConversionError("Unsupported Chat tool type");
        const callId = string(call.id);
        if (!callId || [...this.tools.values()].some(entry => entry.callId === callId)) throw new ModelConversionError("Invalid Chat tool identity");
        state = { callId, name: "", arguments: "" };
        this.tools.set(Number(index), state);
      } else if ((call.id != null && call.id !== state.callId) || (call.type != null && call.type !== "function")) throw new ModelConversionError("Chat tool identity changed");
      const fn = object(call.function);
      if (fn.name != null) state.name += string(fn.name);
      if (fn.arguments != null) {
        state.arguments += string(fn.arguments);
      }
    }
    if (choice.finish_reason != null) {
      if (this.finishReason || !["stop", "tool_calls", "length", "content_filter"].includes(string(choice.finish_reason))) throw new ModelConversionError("Chat upstream failed to finish normally");
      this.finishReason = string(choice.finish_reason);
    }
    return events;
  }

  finish(): JsonObject[] {
    if (this.ended || !this.finishReason) throw new ModelConversionError("Chat stream ended without a finish reason");
    this.ended = true;
    if (this.finishReason === "length" || this.finishReason === "content_filter") return [this.event("response.incomplete", { response: { ...this.response("incomplete"), incomplete_details: { reason: this.finishReason === "length" ? "max_output_tokens" : "content_filter" } } })];
    if ((this.tools.size > 0) !== (this.finishReason === "tool_calls")) throw new ModelConversionError("Chat tool finish reason mismatch");
    const calls: OutputItem[] = [];
    for (const [index, state] of this.tools) {
      if (!state.name) throw new ModelConversionError("Missing Chat tool name");
      try { object(JSON.parse(state.arguments)); } catch { throw new ModelConversionError("Invalid Chat tool arguments"); }
      const identity = this.toolNames?.get(state.name);
      if (this.toolNames && !identity) throw new ModelConversionError("Unknown Chat tool name");
      calls.push({ id: `${this.id}_call_${index}`, type: "function_call", call_id: state.callId,
        ...(identity ?? { name: state.name }), arguments: state.arguments, status: "completed" });
    }
    const events = this.closeContent();
    // Keep partial or invalid tool calls away from the client. Publish validated
    // calls after content, each with a complete identity and paired lifecycle.
    for (const item of calls) {
      const output_index = this.items.length;
      events.push(...this.addItem({ ...item, arguments: "", status: "in_progress" }));
      this.items[output_index] = item;
      events.push(this.event("response.function_call_arguments.done", { item_id: item.id, output_index, arguments: item.arguments }));
      events.push(this.event("response.output_item.done", { item, output_index }));
    }
    if (!this.items.length) throw new ModelConversionError("Empty Chat response");
    events.push(this.event("response.completed", { response: this.response("completed") }));
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
        : { id: `${this.id}_reasoning_${index}`, type: "reasoning", summary: [] };
      this.activeContent = { kind, item, index, text: "" };
      events.push(...this.addItem(item));
      events.push(kind === "message"
        ? this.event("response.content_part.added", { item_id: item.id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
        : this.event("response.reasoning_summary_part.added", { item_id: item.id, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } }));
    }
    const active = this.activeContent;
    if (!active) throw new ModelConversionError("Missing active response item");
    active.text += text;
    events.push(kind === "message"
      ? this.event("response.output_text.delta", { item_id: active.item.id, output_index: active.index, content_index: 0, delta: text })
      : this.event("response.reasoning_summary_text.delta", { item_id: active.item.id, output_index: active.index, summary_index: 0, delta: text }));
    return events;
  }

  private closeContent(): JsonObject[] {
    const active = this.activeContent;
    if (!active) return [];
    this.activeContent = undefined;
    const { item, index: output_index, text, kind } = active;
    const fields = { item_id: item.id, output_index };
    const part = kind === "message"
      ? { type: "output_text", text, annotations: [] }
      : { type: "summary_text", text };
    const completed = kind === "message"
      ? { ...item, status: "completed", content: [part] }
      : { ...item, summary: [part] };
    this.items[output_index] = completed;
    return [
      kind === "message"
        ? this.event("response.output_text.done", { ...fields, content_index: 0, text })
        : this.event("response.reasoning_summary_text.done", { ...fields, summary_index: 0, text }),
      kind === "message"
        ? this.event("response.content_part.done", { ...fields, content_index: 0, part })
        : this.event("response.reasoning_summary_part.done", { ...fields, summary_index: 0, part }),
      this.event("response.output_item.done", { item: completed, output_index }),
    ];
  }

  private addItem(item: OutputItem): JsonObject[] {
    const output_index = this.items.length;
    this.items.push(item);
    return [this.event("response.output_item.added", { item: { ...item }, output_index })];
  }
  private response(status: string): JsonObject {
    return { id: this.id, object: "response", model: this.model, status, output: [...this.items], ...(this.usage ? { usage: this.usage } : {}) };
  }
  private event(type: string, fields: JsonObject): JsonObject { return { type, sequence_number: this.sequence++, ...fields }; }
}

function convertUsage(value: unknown): JsonObject {
  const source = object(value);
  const count = (value: unknown): number => {
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ModelConversionError("Invalid Chat usage");
    return Number(value);
  };
  const input = count(source.prompt_tokens), output = count(source.completion_tokens);
  const result: JsonObject = { input_tokens: input, output_tokens: output, total_tokens: input + output };
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
