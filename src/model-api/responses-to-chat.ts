import { array, ModelConversionError, object, string } from "./validation.js";
import type { JsonObject } from "./validation.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  reasoning?: string;
}
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: JsonObject[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_completion_tokens?: number;
}

/** Stateless conversion: the caller supplies complete Responses input on every request. */
export interface ChatToolIdentity { name: string; namespace?: string }
export function responsesToChat(value: unknown): { request: ChatRequest; toolNames: ReadonlyMap<string, ChatToolIdentity> } {
  const source = object(value);
  const allowed = new Set(["model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options", "store", "include", "reasoning", "text", "service_tier", "prompt_cache_key", "client_metadata", "max_output_tokens"]);
  if (Object.keys(source).some(key => !allowed.has(key))) throw new ModelConversionError("Unsupported Responses request field");
  if (source.stream !== true || source.store === true) throw new ModelConversionError("Only stateless streaming Responses requests are supported");
  if (source.service_tier != null && source.service_tier !== "default" && source.service_tier !== "auto") throw new ModelConversionError("Unsupported service tier");
  if (source.text != null && Object.keys(object(source.text)).length > 0) throw new ModelConversionError("Structured output and verbosity are unsupported");
  if (source.reasoning != null) {
    const reasoning = object(source.reasoning);
    if (Object.keys(reasoning).some(key => !["effort", "summary"].includes(key))
      || (reasoning.effort != null && reasoning.effort !== "none")
      || (reasoning.summary != null && reasoning.summary !== "none")) throw new ModelConversionError("Reasoning controls are unsupported by this Chat adapter");
  }
  if (source.include != null && array(source.include).some(entry => entry !== "reasoning.encrypted_content")) throw new ModelConversionError("Unsupported Responses include");
  const toolNames = new Map<string, ChatToolIdentity>();
  const messages: ChatMessage[] = [];
  if (source.instructions != null) messages.push({ role: "system", content: string(source.instructions) });
  const pendingCalls = new Set<string>();
  const seenCalls = new Set<string>();
  // A Chat assistant message owns its text, reasoning and all parallel calls.
  // Once tool results start, a new assistant group requires every result first.
  const assistant = (): ChatMessage => {
    const last = messages.at(-1);
    if (last?.role === "assistant") return last;
    if (pendingCalls.size) throw new ModelConversionError("Missing tool results");
    const message: ChatMessage = { role: "assistant", content: null };
    messages.push(message);
    return message;
  };
  const input = typeof source.input === "string" ? [{ role: "user", content: source.input }] : array(source.input);
  for (const raw of input) {
    const item = object(raw);
    if (item.type === "function_call") {
      if (item.encrypted_function_args != null) throw new ModelConversionError("Encrypted tool arguments are unsupported");
      const id = string(item.call_id);
      if (!id || seenCalls.has(id)) throw new ModelConversionError("Invalid tool call identity");
      const message = assistant();
      seenCalls.add(id); pendingCalls.add(id);
      const call = { id, type: "function" as const, function: { name: chatToolName(string(item.name), item.namespace == null ? undefined : string(item.namespace)), arguments: string(item.arguments) } };
      (message.tool_calls ??= []).push(call);
    } else if (item.type === "function_call_output") {
      const id = string(item.call_id);
      if (!pendingCalls.delete(id)) throw new ModelConversionError("Unmatched tool result");
      messages.push({ role: "tool", tool_call_id: id, content: textContent(item.output) });
    } else if (item.type === "reasoning") {
      if (item.encrypted_content != null) throw new ModelConversionError("Encrypted reasoning cannot be converted to Chat");
      const thought = array(item.summary).map(raw => {
        const part = object(raw);
        if (part.type !== "summary_text") throw new ModelConversionError("Unsupported reasoning summary");
        return string(part.text);
      }).join("");
      const message = assistant();
      message.reasoning = (message.reasoning ?? "") + thought;
    } else if (item.type === "message" || item.type === undefined) {
      const role = item.role === "developer" ? "system" : item.role;
      if (role !== "system" && role !== "user" && role !== "assistant") throw new ModelConversionError("Unsupported message role");
      if (role === "assistant") {
        const message = assistant();
        message.content = (message.content ?? "") + textContent(item.content);
      } else {
        if (pendingCalls.size) throw new ModelConversionError("Missing tool results");
        messages.push({ role, content: textContent(item.content) });
      }
    } else {
      throw new ModelConversionError("Unsupported Responses input item");
    }
  }
  if (pendingCalls.size) throw new ModelConversionError("Missing tool results");
  const result: ChatRequest = { model: string(source.model), messages, stream: true, stream_options: { include_usage: true } };
  const convertTool = (raw: unknown, namespace?: string): JsonObject => {
    const tool = object(raw);
    if (tool.type !== "function") throw new ModelConversionError("Only function tools are supported");
    if (tool.defer_loading === true) throw new ModelConversionError("Deferred tools are unsupported");
    const name = string(tool.name);
    const convertedName = chatToolName(name, namespace);
    if (toolNames.has(convertedName)) throw new ModelConversionError("Conflicting Chat tool names");
    toolNames.set(convertedName, { name, ...(namespace ? { namespace } : {}) });
    const fn: JsonObject = { name: convertedName, parameters: object(tool.parameters) };
    if (tool.description !== undefined) fn.description = string(tool.description);
    if (tool.strict !== undefined) {
      if (typeof tool.strict !== "boolean") throw new ModelConversionError();
      fn.strict = tool.strict;
    }
    return { type: "function", function: fn };
  };
  if (source.tools !== undefined) result.tools = array(source.tools).flatMap(raw => {
    const tool = object(raw);
    return tool.type === "namespace"
      ? array(tool.tools).map(nested => convertTool(nested, string(tool.name)))
      : [convertTool(tool)];
  });
  if (source.tool_choice !== undefined) {
    if (typeof source.tool_choice === "string" && ["auto", "none", "required"].includes(source.tool_choice)) result.tool_choice = source.tool_choice;
    else {
      const choice = object(source.tool_choice);
      if (choice.type !== "function") throw new ModelConversionError("Unsupported tool choice");
      result.tool_choice = { type: "function", function: { name: chatToolName(string(choice.name), choice.namespace == null ? undefined : string(choice.namespace)) } };
    }
  }
  if (source.parallel_tool_calls !== undefined) {
    if (typeof source.parallel_tool_calls !== "boolean") throw new ModelConversionError();
    result.parallel_tool_calls = source.parallel_tool_calls;
  }
  if (source.max_output_tokens !== undefined) {
    if (!Number.isSafeInteger(source.max_output_tokens) || Number(source.max_output_tokens) <= 0) throw new ModelConversionError();
    result.max_completion_tokens = Number(source.max_output_tokens);
  }
  return { request: result, toolNames };
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  return array(value).map(raw => {
    const part = object(raw);
    if (!["input_text", "output_text"].includes(String(part.type))) throw new ModelConversionError("Only text content is supported");
    return string(part.text);
  }).join("");
}

function chatToolName(name: string, namespace?: string): string {
  const result = namespace === undefined ? name : `${namespace}__${name}`;
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(result)) throw new ModelConversionError("Unsupported Chat tool name");
  return result;
}
