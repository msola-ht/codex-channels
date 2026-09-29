import { array, ModelConversionError, object, string } from "./validation.js";

export interface DirectChatRequest {
  model: string;
  messages: Record<string, unknown>[];
  stream: boolean;
  temperature?: number;
  tools?: Record<string, unknown>[];
}

const namePattern = /^[A-Za-z0-9_-]{1,64}$/u;
const callPattern = /^[A-Za-z0-9_-]{1,128}$/u;

/** Deliberately narrower than the upstream API. Never silently forward extra fields. */
export function validateDirectChatRequest(value: unknown): DirectChatRequest {
  const input = fields(value, ["model", "messages", "stream", "temperature", "tools"]);
  const model = boundedText(input.model, 200, false);
  if (input.stream !== undefined && typeof input.stream !== "boolean") fail();
  const result: DirectChatRequest = { model, stream: input.stream === true, messages: [] };
  if (input.temperature !== undefined) {
    if (typeof input.temperature !== "number" || !Number.isFinite(input.temperature)
      || input.temperature < 0 || input.temperature > 2) fail();
    result.temperature = input.temperature;
  }
  if (input.tools !== undefined) {
    const names = new Set<string>();
    result.tools = boundedArray(input.tools, 64).map((entry) => {
      const tool = fields(entry, ["type", "function"]);
      if (tool.type !== "function") fail();
      const fn = fields(tool.function, ["name", "description", "parameters"]);
      const name = identifier(fn.name, namePattern);
      if (names.has(name)) fail();
      names.add(name);
      const definition: Record<string, unknown> = { name, parameters: structuredClone(object(fn.parameters)) };
      if (fn.description !== undefined) definition.description = boundedText(fn.description, 4096);
      return { type: "function", function: definition };
    });
  }
  const seenCalls = new Set<string>();
  const pendingCalls = new Set<string>();
  result.messages = boundedArray(input.messages, 256).map((entry, index) => {
    const message = object(entry);
    if (message.role !== "tool" && pendingCalls.size > 0) fail();
    switch (message.role) {
      case "system":
      case "user": {
        fields(message, ["role", "content"]);
        if (message.role === "system" && index !== 0) fail();
        return { role: message.role, content: string(message.content) };
      }
      case "assistant": {
        fields(message, ["role", "content", "tool_calls"]);
        const output: Record<string, unknown> = { role: "assistant" };
        if (message.content !== undefined) output.content = message.content === null ? null : string(message.content);
        if (message.tool_calls !== undefined) {
          output.tool_calls = boundedArray(message.tool_calls, 64).map((entry) => {
            const call = fields(entry, ["id", "type", "function"]);
            if (call.type !== "function") fail();
            const id = identifier(call.id, callPattern);
            if (seenCalls.has(id)) fail();
            seenCalls.add(id); pendingCalls.add(id);
            const fn = fields(call.function, ["name", "arguments"]);
            const name = identifier(fn.name, namePattern);
            const args = string(fn.arguments);
            try { object(JSON.parse(args) as unknown); } catch { fail(); }
            return { id, type: "function", function: { name, arguments: args } };
          });
        } else if (typeof message.content !== "string") fail();
        return output;
      }
      case "tool": {
        fields(message, ["role", "content", "tool_call_id"]);
        const id = identifier(message.tool_call_id, callPattern);
        if (!pendingCalls.delete(id)) fail();
        return { role: "tool", content: string(message.content), tool_call_id: id };
      }
      default: return fail();
    }
  });
  if (pendingCalls.size > 0) fail();
  return result;
}

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = object(value);
  if (Object.keys(record).some(key => !keys.includes(key))) fail();
  return record;
}
function boundedArray(value: unknown, maximum: number): unknown[] {
  const values = array(value);
  if (values.length === 0 || values.length > maximum) fail();
  return values;
}
function boundedText(value: unknown, maximum: number, empty = true): string {
  const text = string(value);
  if (text.length > maximum || (!empty && text.length === 0)) fail();
  return text;
}
function identifier(value: unknown, pattern: RegExp): string {
  const text = string(value);
  if (!pattern.test(text)) fail();
  return text;
}
function fail(): never { throw new ModelConversionError("Unsupported or invalid Chat request"); }
