import { describe, expect, it } from "vitest";
import { ModelConversionError, validateDirectChatRequest } from "../src/model-api/index.js";

const textRequest = { model: "fixture/model", messages: [{ role: "user", content: "hello" }] };
describe("direct Chat request boundary", () => {
  it("sets explicit JSON mode and copies only supported request fields", () => {
    const result = validateDirectChatRequest(textRequest);
    expect(result).toEqual({ ...textRequest, stream: false });
    result.messages[0]!.content = "changed";
    expect(textRequest.messages[0]!.content).toBe("hello");
  });
  it("accepts text and complete client-side function history without transforming it", () => {
    const value = { ...textRequest, stream: true, temperature: 0, tools: [{ type: "function", function: {
      name: "weather", parameters: { type: "object", properties: { location: { type: "string" } } },
    } }], messages: [
      { role: "system", content: "instructions" }, ...textRequest.messages,
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "result" },
    ] };
    expect(validateDirectChatRequest(value)).toEqual(value);
  });
  it.each(["metadata", "user", "provider", "threadId", "url", "n", "reasoning", "stream_options", "max_tokens"])("rejects unsupported %s instead of forwarding it", key => {
    expect(() => validateDirectChatRequest({ ...textRequest, [key]: "secret" })).toThrow(ModelConversionError);
  });
  it.each([
    { model: "", messages: textRequest.messages },
    { ...textRequest, temperature: NaN },
    { ...textRequest, temperature: 2.1 },
    { ...textRequest, stream: "false" },
    { ...textRequest, messages: [] },
    { ...textRequest, messages: Array.from({ length: 257 }, () => textRequest.messages[0]) },
    { ...textRequest, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "file:///private" } }] }] },
    { ...textRequest, messages: [{ role: "tool", tool_call_id: "missing", content: "result" }] },
    { ...textRequest, messages: [{ role: "assistant", tool_calls: [{ id: "a", type: "function", function: { name: "f", arguments: "{" } }] }] },
    { ...textRequest, messages: [{ role: "assistant", tool_calls: [{ id: "a", type: "function", function: { name: "f", arguments: "{}" } }] }] },
  ])("rejects invalid shapes, incomplete history and unsafe semantics", value => {
    expect(() => validateDirectChatRequest(value)).toThrow(ModelConversionError);
  });
});
