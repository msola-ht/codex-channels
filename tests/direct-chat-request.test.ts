import { describe, expect, it } from "vitest";
import { DirectChatRequestError, validateDirectChatRequest } from "../src/model-api/index.js";

const textRequest = { model: "fixture/model", messages: [{ role: "user", content: "hello" }] };
describe("direct Chat request boundary", () => {
  it("preserves parameters, nulls, message extensions and remote URLs as opaque upstream data", () => {
    const value = { ...textRequest, stream: true, n: 1, temperature: null, top_p: 0.9, max_tokens: 4096,
      max_completion_tokens: null, stop: ["stop"], seed: 7, stream_options: { include_usage: true },
      tools: [], tool_choice: "auto", parallel_tool_calls: true, response_format: { type: "json_object" },
      metadata: { trace: "a" }, user: "client", vendor_extension: { nested: [null, true] },
      messages: [{ role: "developer", content: "instructions", name: "app" },
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://images.example/p.png", detail: "auto" } }] },
        { role: "assistant", content: null, reasoning_content: "thought", tool_calls: [] }] };
    expect(validateDirectChatRequest(value)).toEqual(value);
  });
  it("leaves model parameter validity to the upstream without coercing or dropping values", () => {
    const value = { ...textRequest, temperature: 99, max_tokens: 0, reasoning: { vendor_mode: "custom" },
      messages: [{ role: "tool", tool_call_id: "upstream-validates-history", content: "result" }] };
    expect(validateDirectChatRequest(value)).toEqual({ ...value, stream: false });
  });
  it("sets explicit JSON mode without mutating input or sharing nested references", () => {
    const result = validateDirectChatRequest(textRequest);
    expect(result).toEqual({ ...textRequest, stream: false });
    result.messages[0]!.content = "changed";
    expect(textRequest.messages[0]!.content).toBe("hello");
  });
  it.each([
    [null, "body"], [[], "body"],
    [{ ...textRequest, model: "" }, "model"],
    [{ ...textRequest, model: "private\nmodel" }, "model"],
    [{ ...textRequest, stream: "PRIVATE" }, "stream"],
    [{ ...textRequest, n: 2 }, "n"],
    [{ ...textRequest, messages: [] }, "messages"],
    [{ ...textRequest, messages: [null] }, "messages[0]"],
    [{ ...textRequest, messages: Array.from({ length: 257 }, () => textRequest.messages[0]) }, "messages"],
  ])("rejects local routing/delivery boundary violations with safe paths", (value, param) => {
    try { validateDirectChatRequest(value); expect.fail("must reject"); }
    catch (error) { expect(error).toBeInstanceOf(DirectChatRequestError); expect(error).toMatchObject({ param }); expect(String(error)).not.toContain("PRIVATE"); }
  });
});
