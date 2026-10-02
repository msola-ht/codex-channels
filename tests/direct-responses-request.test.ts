import { describe, expect, it } from "vitest";
import { DirectResponsesRequestError, validateDirectResponsesRequest, validateDirectChatRequest, applyChatReasoningPolicy, applyResponsesReasoningPolicy } from "../src/model-api/index.js";

describe("native Responses request boundary", () => {
  it.each(["extra_body", "extraBody"].flatMap(container =>
    ["reasoning", "thinking", "reasoning_effort", "enable_thinking"].map(field => ({ container, field }))))(
    "reports the same exact reasoning conflict path in both protocols ($container.$field)", ({ container, field }) => {
      const fields = { model: "deepseek-flash", [container]: { [field]: "PRIVATE" } };
      const chat = validateDirectChatRequest({ ...fields, messages: [{ role: "user", content: "hello" }] });
      const responses = validateDirectResponsesRequest("ds-main", { ...fields, input: "hello" });
      expect(applyChatReasoningPolicy(chat, "ds-main", "passthrough")).toBe(chat);
      expect(applyResponsesReasoningPolicy(responses, "ds-main", "passthrough")).toBe(responses);
      for (const apply of [() => applyChatReasoningPolicy(chat, "ds-main", "off"), () => applyResponsesReasoningPolicy(responses, "ds-main", "off")]) {
        try { apply(); expect.fail("must reject"); }
        catch (error) {
          expect(error).toMatchObject({ param: `${container}.${field}` });
          expect(String(error)).not.toContain("PRIVATE");
        }
      }
    });

  it("uses protocol-specific DS reasoning controls without rewriting history", () => {
    const input = validateDirectResponsesRequest("ds-main", { model: "deepseek-flash", input: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "prior" }] }], reasoning: { effort: "high", summary: "auto" } });
    expect(applyResponsesReasoningPolicy(input, "ds-main", "off")).toMatchObject({ input: input.input, reasoning: { effort: "none", summary: "auto" } });
    expect(input.reasoning).toEqual({ effort: "high", summary: "auto" });
    const chat = validateDirectChatRequest({ model: "deepseek-flash", messages: [{ role: "user", content: "hello" }], reasoning: { effort: "high" }, thinking: { type: "enabled" } });
    const outgoing = applyChatReasoningPolicy(chat, "ds-main", "off");
    expect(outgoing.reasoning_effort).toBe("none"); expect(outgoing).not.toHaveProperty("reasoning"); expect(outgoing).not.toHaveProperty("thinking");
    expect(applyResponsesReasoningPolicy(input, "rs-custom", "off")).toBe(input);
  });

  it.each(["clp-main", "ds-main", "rs-custom"])("preserves unknown model controls when Key off cannot be applied (%s)", provider => {
    const fields = { model: "cline-pass/muse-spark-1.3-contributor", reasoning: { effort: "high" }, extra_body: { thinking: true } };
    const chat = validateDirectChatRequest({ ...fields, messages: [{ role: "user", content: "hello" }] });
    const responses = validateDirectResponsesRequest(provider, { ...fields, input: "hello" });
    expect(applyChatReasoningPolicy(chat, provider, "off")).toBe(chat);
    expect(applyResponsesReasoningPolicy(responses, provider, "off")).toBe(responses);
    if (provider.startsWith("clp-")) expect(applyChatReasoningPolicy(chat, provider, "off", {
      id: fields.model, reasoning: "passthrough", reasoning_efforts: [],
    })).toBe(chat);
  });

  it("honors verified static off capability even when an extra model only declares high", () => {
    const model = "cline-pass/deepseek-v4.1-flash";
    const chat = validateDirectChatRequest({ model, messages: [{ role: "user", content: "hello" }], reasoning: { effort: "low" } });
    const extraModel = { id: model, reasoning: "high" as const, reasoning_efforts: ["high" as const] };
    expect(applyChatReasoningPolicy(chat, "clp-main", "off", extraModel).reasoning).toEqual({ effort: "none" });
    const overridden = applyChatReasoningPolicy(chat, "clp-main", "passthrough", extraModel);
    expect(overridden.reasoning_effort).toBe("high"); expect(overridden).not.toHaveProperty("reasoning");
    expect(() => applyChatReasoningPolicy(chat, "clp-main", "passthrough", { ...extraModel, reasoning: "none" }))
      .toThrow("Reasoning effort is not declared");
    expect(chat.reasoning).toEqual({ effort: "low" });
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
