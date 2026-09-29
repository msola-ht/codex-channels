import { ModelConversionError, object, string, toolArguments } from "./validation.js";

export interface DirectChatUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}
type FinishReason = "stop" | "tool_calls" | "length" | "content_filter";
interface ToolCall { id: string; name: string; arguments: string }

/** Single owner of Chat terminal state and usage. Contains no HTTP or metrics submission. */
export class DirectChatResponse {
  readonly usage: DirectChatUsage = {};
  private readonly calls = new Map<number, ToolCall>();
  private reason: FinishReason | undefined;
  private done = false;
  private contentBytes = 0;
  private id: string | undefined;
  private model: string | undefined;
  private created: number | undefined;
  private contentObserved = false;

  get responseModel(): string | undefined { return this.model; }
  get hasContent(): boolean { return this.contentObserved; }
  get status(): "completed" | "incomplete" | "unknown" {
    if (!this.done) return "unknown";
    return this.reason === "stop" || this.reason === "tool_calls" ? "completed" : "incomplete";
  }

  push(value: unknown, stream: boolean): Record<string, unknown> | undefined {
    if (this.done) fail();
    const chunk = object(value);
    if (chunk.error != null) fail();
    if (chunk.created !== undefined) {
      if (!Number.isSafeInteger(chunk.created) || Number(chunk.created) < 0
        || this.created !== undefined && this.created !== chunk.created) fail();
      this.created = Number(chunk.created);
    }
    if (chunk.id !== undefined) {
      const id = boundedString(chunk.id, 200);
      if (this.id !== undefined && this.id !== id) fail();
      this.id = id;
    }
    if (chunk.model !== undefined) {
      const model = boundedString(chunk.model, 200);
      if (this.model !== undefined && this.model !== model) fail();
      this.model = model;
    }
    if (chunk.usage != null) this.readUsage(chunk.usage);
    if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) fail();
    if (chunk.choices.length === 0) {
      if (!stream || chunk.usage == null) fail();
      return undefined;
    }
    const choice = object(chunk.choices[0]);
    if ((choice.index !== undefined && choice.index !== 0) || choice.error != null) fail();
    const message = object(stream ? choice.delta ?? {} : choice.message);
    if (message.role !== undefined && message.role !== "assistant") fail();
    if (this.reason !== undefined && (choice.finish_reason != null || Object.keys(message).length > 0)) fail();
    const output: Record<string, unknown> = {};
    if (message.role !== undefined) output.role = "assistant";
    for (const key of ["content", "reasoning"] as const) {
      if (message[key] != null) {
        const text = string(message[key]);
        this.contentBytes += Buffer.byteLength(text);
        if (this.contentBytes > 32 * 1024 * 1024) fail();
        output[key] = text;
        if (text.length) this.contentObserved = true;
      }
    }
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 64) fail();
      for (const [position, entry] of message.tool_calls.entries()) this.readCall(entry, stream ? undefined : position);
      if (message.tool_calls.length) this.contentObserved = true;
    }
    if (choice.finish_reason != null) {
      if (typeof choice.finish_reason !== "string" || !["stop", "tool_calls", "length", "content_filter"].includes(choice.finish_reason)) fail();
      this.reason = choice.finish_reason as FinishReason;
    }
    if (!stream && !this.reason) fail();
    if (!Object.keys(output).length) return undefined;
    return this.envelope([{ index: 0, [stream ? "delta" : "message"]: output, finish_reason: null }], stream);
  }

  /** Called only after DONE (SSE) or complete validated JSON. */
  finish(stream: boolean): Record<string, unknown> {
    if (this.done || !this.reason) fail();
    const tools = this.reason === "tool_calls" ? this.completeCalls() : undefined;
    if (this.reason === "stop" && this.calls.size > 0) fail();
    this.done = true;
    const body = tools ? { tool_calls: tools } : {};
    return { ...this.envelope([{ index: 0, [stream ? "delta" : "message"]: body, finish_reason: this.reason }], stream),
      ...(Object.keys(this.usage).length ? { usage: usageJson(this.usage) } : {}) };
  }

  private envelope(choices: unknown[], stream: boolean): Record<string, unknown> {
    return { ...(this.id === undefined ? {} : { id: this.id }), object: stream ? "chat.completion.chunk" : "chat.completion",
      ...(this.created === undefined ? {} : { created: this.created }),
      ...(this.model === undefined ? {} : { model: this.model }), choices };
  }
  private readCall(value: unknown, position: number | undefined): void {
    const call = object(value);
    const index = position ?? call.index;
    if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= 64) fail();
    if (call.type !== undefined && call.type !== "function") fail();
    const previous = this.calls.get(Number(index)) ?? { id: "", name: "", arguments: "" };
    if (call.id !== undefined) {
      const id = boundedString(call.id, 128);
      if (!/^[A-Za-z0-9_-]+$/u.test(id) || (previous.id && previous.id !== id)) fail();
      previous.id = id;
    }
    if (call.function !== undefined) {
      const fn = object(call.function);
      if (fn.name !== undefined) previous.name += string(fn.name);
      if (fn.arguments !== undefined) previous.arguments += string(fn.arguments);
    }
    if (previous.name.length > 64 || Buffer.byteLength(previous.arguments) > 1024 * 1024) fail();
    this.calls.set(Number(index), previous);
    if ([...this.calls.values()].reduce((sum, item) => sum + Buffer.byteLength(item.arguments), 0) > 1024 * 1024) fail();
  }
  private completeCalls(): unknown[] {
    if (this.calls.size === 0) fail();
    const ids = new Set<string>();
    return [...this.calls.entries()].sort(([a], [b]) => a - b).map(([index, call], expected) => {
      if (index !== expected || !call.id || !/^[A-Za-z0-9_-]{1,64}$/u.test(call.name) || ids.has(call.id)) fail();
      ids.add(call.id); toolArguments(call.arguments, "Invalid Chat tool result");
      return { index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } };
    });
  }
  private readUsage(value: unknown): void {
    const usage = object(value);
    const prompt = usage.prompt_tokens_details == null ? {} : object(usage.prompt_tokens_details);
    const completion = usage.completion_tokens_details == null ? {} : object(usage.completion_tokens_details);
    const fields: Array<[keyof DirectChatUsage, unknown]> = [["inputTokens", usage.prompt_tokens],
      ["cachedInputTokens", prompt.cached_tokens], ["outputTokens", usage.completion_tokens],
      ["reasoningOutputTokens", completion.reasoning_tokens], ["totalTokens", usage.total_tokens]];
    for (const [key, count] of fields) {
      if (count == null) continue;
      if (!Number.isSafeInteger(count) || Number(count) < 0) fail();
      if (this.usage[key] !== undefined && this.usage[key] !== count) fail();
      this.usage[key] = Number(count);
    }
  }
}

export function directChatJson(value: unknown, observer: DirectChatResponse): Record<string, unknown> {
  const content = observer.push(value, false);
  const terminal = observer.finish(false);
  const finalChoice = (terminal.choices as Array<Record<string, unknown>>)[0]!;
  const initialChoice = (content?.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const message: Record<string, unknown> = { role: "assistant", ...object(initialChoice?.message ?? {}), ...object(finalChoice.message) };
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls = message.tool_calls.map(value => {
      const call = object(value);
      return { id: call.id, type: call.type, function: call.function };
    });
  }
  return { ...terminal, choices: [{ ...finalChoice, message }] };
}
function usageJson(usage: DirectChatUsage): Record<string, unknown> {
  return { ...(usage.inputTokens === undefined ? {} : { prompt_tokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { completion_tokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
    ...(usage.cachedInputTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } }),
    ...(usage.reasoningOutputTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens } }) };
}
function boundedString(value: unknown, max: number): string {
  const text = string(value);
  if (!text || text.length > max || [...text].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) fail();
  return text;
}
function fail(): never { throw new ModelConversionError("Invalid Chat upstream response"); }
