import { describe, expect, it } from "vitest";
import { DirectResponsesRequestError, validateDirectResponsesRequest, validateDirectChatRequest, applyChatReasoningPolicy, applyResponsesReasoningPolicy } from "../src/model-api/index.js";

describe("native Responses request boundary", () => {
  it("uses protocol-specific DS reasoning controls without rewriting history", () => {
    const input = validateDirectResponsesRequest("ds-main", { model: "deepseek-flash", input: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "prior" }] }], reasoning: { effort: "high", summary: "auto" } });
    expect(applyResponsesReasoningPolicy(input, "ds-main", "off")).toMatchObject({ input: input.input, reasoning: { effort: "none", summary: "auto" } });
    expect(input.reasoning).toEqual({ effort: "high", summary: "auto" });
    const chat = validateDirectChatRequest({ model: "deepseek-flash", messages: [{ role: "user", content: "hello" }], reasoning: { effort: "high" }, thinking: { type: "enabled" } });
    const outgoing = applyChatReasoningPolicy(chat, "ds-main", "off");
    expect(outgoing.reasoning_effort).toBe("none"); expect(outgoing).not.toHaveProperty("reasoning"); expect(outgoing).not.toHaveProperty("thinking");
    expect(() => applyResponsesReasoningPolicy(input, "rs-custom", "off")).toThrow("not supported");
  });
  it("preserves opaque input, tools and parameters without converting to Chat", () => {
    const request = { model: "fixture/model", input: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "prior reasoning" }] },
      { role: "user", content: [{ type: "input_image", image_url: "https://example.test/image.png" }] },
      { type: "function_call_output", call_id: "call_fixture", output: "result" },
    ], tools: [{ type: "custom", name: "fixture", format: { type: "text" } }],
    reasoning: { effort: "none" }, temperature: null, vendor_extension: { enabled: true } };
    const result = validateDirectResponsesRequest("rs-fixture", request);
    expect(result).toEqual({ ...request, stream: false, store: false });
    expect(result).not.toHaveProperty("messages");
    (result.vendor_extension as Record<string, unknown>).enabled = false;
    expect(request.vendor_extension.enabled).toBe(true);
    expect(request).not.toHaveProperty("store");
  });

  it.each(["text", "", []])("accepts stateless input %#", input => {
    expect(validateDirectResponsesRequest("rs-fixture", { model: "fixture", input, stream: true, store: false,
      background: false, conversation: null, previous_response_id: null })).toEqual({
      model: "fixture", input, stream: true, store: false, background: false, conversation: null, previous_response_id: null,
    });
  });

  it.each([undefined, false, true])("disables upstream storage without mutating the client request (store=%s)", store => {
    const request = { model: "fixture", input: "hello", stream: true, ...(store === undefined ? {} : { store }) };
    expect(validateDirectResponsesRequest("rs-fixture", request)).toEqual({ ...request, store: false });
    expect(request.store).toBe(store);
    if (store === undefined) expect(request).not.toHaveProperty("store");
  });

  it.each(["ds-fixture", "rs-fixture", "ocg-fixture"].flatMap(provider => [undefined, false, true].map(background => ({ provider, background }))))(
    "uses foreground delivery without changing input ($provider, background=$background)", ({ provider, background }) => {
      const request = { model: "fixture", input: "hello", ...(background === undefined ? {} : { background }) };
      const result = validateDirectResponsesRequest(provider, request);
      expect(result).toEqual({ ...request, stream: false, store: false, ...(background === undefined ? {} : { background: false }) });
      expect(request.background).toBe(background);
    });

  it.each(["previous_response_id", "conversation"])("rejects unowned upstream history references (%s)", field => {
    expect(() => validateDirectResponsesRequest("rs-fixture", { model: "fixture", input: "hello", [field]: "private_history" }))
      .toThrow("Server-side conversation references are not supported");
  });

  it("preserves long histories and DeepSeek ignored lifecycle fields", () => {
    const request = { model: "fixture", input: Array.from({ length: 300 }, () => ({ role: "user", content: "hello" })),
      background: true, previous_response_id: "resp_previous", conversation: { id: "conv_previous" } };
    expect(validateDirectResponsesRequest("ds-fixture", request)).toEqual({ ...request, stream: false, store: false, background: false });
    expect(validateDirectResponsesRequest("rs-fixture", { model: request.model, input: request.input }).input).toEqual(request.input);
  });

  it("accepts instructions without input and preserves explicit null input", () => {
    expect(validateDirectResponsesRequest("rs-fixture", { model: "fixture", instructions: "hello" })).toEqual({ model: "fixture", instructions: "hello", stream: false, store: false });
    expect(validateDirectResponsesRequest("rs-fixture", { model: "fixture", instructions: "hello", input: null }).input).toBeNull();
  });

  it.each([
    [null, "body"],
    [{ model: "PRIVATE\n", input: "" }, "model"],
    [{ model: "fixture" }, "input"],
    [{ model: "fixture", input: ["PRIVATE"] }, "input[0]"],
    ...["stream", "store", "background", "previous_response_id", "conversation"].map((field): [unknown, string] => [
      { model: "fixture", input: "", [field]: "PRIVATE" }, field,
    ]),
    ...[null, 0, 1, {}, []].map((store): [unknown, string] => [{ model: "fixture", input: "", store }, "store"]),
  ])("rejects local lifecycle or shape violations without exposing input %#", (request, param) => {
    try { validateDirectResponsesRequest("rs-fixture", request); expect.fail("must reject"); }
    catch (error) {
      expect(error).toBeInstanceOf(DirectResponsesRequestError);
      expect(error).toMatchObject({ param });
      expect(String(error)).not.toContain("PRIVATE");
    }
  });
});
