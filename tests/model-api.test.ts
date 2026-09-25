import { describe, expect, it } from "vitest";
import { ChatToResponses, responsesToChat } from "../src/model-api/index.js";

const request = (input: unknown) => ({ model: "fixture", stream: true, input });
const chunk = (delta: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const detail = (text: string) => ({ type: "reasoning.text", text, format: "unknown", index: 0 });

it.each([true, false])("converts plaintext reasoning details once (mirrored: %s)", mirrored => {
  const converter = new ChatToResponses("r", "fixture");
  converter.push(chunk({ reasoning_details: [] }));
  for (const text of ["Think ", "carefully."]) {
    converter.push(chunk({ ...(mirrored ? { reasoning: text } : {}), reasoning_details: [detail(text)] }));
  }
  converter.push(chunk({ content: "answer" }, "stop"));
  expect(converter.finish().at(-1)).toMatchObject({ response: { output: [
    { type: "reasoning", summary: [{ text: "Think carefully." }] },
    { type: "message", content: [{ text: "answer" }] },
  ] } });
});

it.each([
  { reasoning_details: [{ type: "reasoning.encrypted", data: "secret" }] },
  { reasoning_details: [{ ...detail("secret"), signature: "secret" }] },
  { reasoning: "other", reasoning_details: [detail("secret")] },
])("rejects unsupported or conflicting reasoning without exposing it", delta => {
  const converter = new ChatToResponses("r", "fixture");
  expect(() => converter.push(chunk(delta))).toThrow();
  try { converter.push(chunk(delta)); } catch (error) { expect(String(error)).not.toContain("secret"); }
});

describe("Responses / Chat conversion", () => {
  it("preserves ordered parallel tool calls and correlated results", () => {
    const converted = responsesToChat({ ...request([
      { role: "developer", content: [{ type: "input_text", text: "instructions" }] },
      ...["a", "b"].map(call_id => ({ type: "function_call", call_id, name: "tool", arguments: "{}" })),
      ...["b", "a"].map(call_id => ({ type: "function_call_output", call_id, output: call_id })),
    ]), tools: [{ type: "function", name: "tool", parameters: { type: "object" } }] });
    expect(converted.request.messages).toEqual([
      { role: "system", content: "instructions" },
      { role: "assistant", content: null, tool_calls: ["a", "b"].map(id => ({ id, type: "function", function: { name: "tool", arguments: "{}" } })) },
      { role: "tool", tool_call_id: "b", content: "b" }, { role: "tool", tool_call_id: "a", content: "a" },
    ]);
    expect(converted.request.tools).toEqual([{ type: "function", function: { name: "tool", parameters: { type: "object" } } }]);
  });
  it("reassembles interleaved tool fragments and preserves absent cache usage", () => {
    const converter = new ChatToResponses("r", "fixture");
    converter.start();
    converter.push(chunk({ tool_calls: [0, 1].map(index => ({ index, id: `call-${index}`, type: "function", function: { name: "tool", arguments: '{"x":' } })) }));
    converter.push(chunk({ tool_calls: [1, 0].map(index => ({ index, function: { arguments: `${index}}` } })) }, "tool_calls"));
    converter.push({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } });
    const events = converter.finish();
    expect(events.filter(event => event.type === "response.output_item.done").map(event => event.item)).toEqual([0, 1].map(index => expect.objectContaining({ call_id: `call-${index}`, name: "tool", arguments: `{"x":${index}}` })));
    expect(events.at(-1)).toMatchObject({ response: { usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } } });
    expect((events.at(-1)?.response as { usage: object }).usage).not.toHaveProperty("input_tokens_details");
  });
  it("keeps reasoning separate from the answer and reports measured cache", () => {
    const converter = new ChatToResponses("r", "fixture");
    converter.push(chunk({ reasoning: "think" }));
    converter.push({ ...chunk({ content: "answer" }, "stop"), usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 12 } } });
    const completed = converter.finish().at(-1)?.response as { output: unknown[] };
    expect(completed).toMatchObject({ usage: { input_tokens_details: { cached_tokens: 12 } } });
    const replay = responsesToChat(request(completed.output));
    expect(replay.request.messages).toEqual([{ role: "assistant", content: "answer", reasoning: "think" }]);
  });
  it.each([
    { ...request([]), previous_response_id: "secret" },
    request([{ type: "function_call_output", call_id: "unknown", output: "secret" }]),
    request([{ type: "reasoning", summary: [], encrypted_content: "secret" }]),
    { ...request([]), tools: [{ type: "custom", name: "patch" }] },
    request([{ role: "user", content: [{ type: "input_image", image_url: "secret" }] }]),
  ])("rejects unsupported semantics without echoing content", body => {
    expect(() => responsesToChat(body)).toThrow();
    try { responsesToChat(body); } catch (error) { expect(String(error)).not.toContain("secret"); }
  });
  it("does not complete truncated or error streams", () => {
    const converter = new ChatToResponses("r", "fixture");
    converter.push(chunk({ content: "partial" }));
    expect(() => converter.finish()).toThrow("finish reason");
    expect(() => converter.push(chunk({}, "error"))).toThrow();
    const limited = new ChatToResponses("r2", "fixture");
    limited.push(chunk({ content: "partial" }, "length"));
    expect(limited.finish().at(-1)).toMatchObject({ type: "response.incomplete" });
  });
});

it("restores function namespaces and rejects ambiguous flattened names", () => {
  const source = { ...request([]), tools: [{ type: "namespace", name: "tasks", tools: [{ type: "function", name: "list", parameters: { type: "object" } }] }] };
  const converted = responsesToChat(source);
  expect(converted.request.tools).toMatchObject([{ function: { name: "tasks__list" } }]);
  const response = new ChatToResponses("r", "fixture", converted.toolNames);
  response.push(chunk({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "tasks__list", arguments: "{}" } }] }, "tool_calls"));
  const item = response.finish().find(event => event.type === "response.output_item.done")?.item;
  expect(item).toMatchObject({ name: "list", namespace: "tasks", call_id: "call" });
  expect(responsesToChat({ ...source, input: [item, { type: "function_call_output", call_id: "call", output: "ok" }] }).request.messages[0]).toMatchObject({ role: "assistant", tool_calls: [{ function: { name: "tasks__list" } }] });
  expect(() => responsesToChat({ ...source, tools: [...source.tools, { type: "function", name: "tasks__list", parameters: {} }] })).toThrow("Conflicting");
});

it("groups assistant text and reasoning after parallel calls before their results", () => {
  const calls = ["a", "b"].map(call_id => ({ type: "function_call", call_id, name: "tool", arguments: "{}" }));
  const input = [...calls,
    { type: "message", role: "assistant", content: "Checking both." },
    { type: "reasoning", summary: [{ type: "summary_text", text: "Check results." }] },
    ...["b", "a"].map(call_id => ({ type: "function_call_output", call_id, output: "ok" })),
  ];
  const converted = responsesToChat(request(input)).request.messages;
  expect(converted).toHaveLength(3);
  expect(converted[0]).toMatchObject({ role: "assistant", content: "Checking both.", reasoning: "Check results.", tool_calls: [{ id: "a" }, { id: "b" }] });
  for (const interrupt of [
    { role: "user", content: "interrupt" },
    { role: "system", content: "interrupt" },
    { type: "function_call_output", call_id: "a", output: "ok" },
  ]) {
    expect(() => responsesToChat(request([...calls, interrupt, { role: "assistant", content: "premature" }]))).toThrow("Missing tool results");
  }
});

it("keeps one active content item through empty and alternating Chat deltas", () => {
  const converter = new ChatToResponses("r", "fixture");
  expect(converter.push(chunk({ role: "assistant", content: "", reasoning: "" }))).toEqual([]);
  const events = [
    ...converter.push(chunk({ reasoning: "first thought" })),
    ...converter.push(chunk({ content: "first answer" })),
    ...converter.push(chunk({ reasoning: "second thought" })),
    ...converter.push(chunk({ content: "second answer" }, "stop")),
    ...converter.finish(),
  ];
  let active: { id: string; type: string } | undefined;
  const completed: string[] = [];
  for (const event of events) {
    if (event.type === "response.output_item.added") {
      expect(active).toBeUndefined();
      active = event.item as typeof active;
    } else if (event.type === "response.output_item.done") {
      const item = event.item as { id: string };
      expect(item.id).toBe(active?.id);
      completed.push(item.id);
      active = undefined;
    } else if (event.type === "response.output_text.delta" || event.type === "response.reasoning_summary_text.delta") {
      expect(event.item_id).toBe(active?.id);
      expect(active?.type).toBe(event.type === "response.output_text.delta" ? "message" : "reasoning");
    }
  }
  expect(active).toBeUndefined();
  expect(new Set(completed).size).toBe(4);
});

it("does not publish a tool call before every call has been validated", () => {
  const converter = new ChatToResponses("r", "fixture");
  const events = converter.push(chunk({ tool_calls: [
    { index: 0, id: "a", type: "function", function: { name: "tool", arguments: "{}" } },
    { index: 1, id: "b", type: "function", function: { name: "tool", arguments: "{" } },
  ] }, "tool_calls"));
  expect(events).toEqual([]);
  expect(() => converter.finish()).toThrow("Invalid Chat tool arguments");
});

it("keeps previously emitted response snapshots unchanged", () => {
  const converter = new ChatToResponses("r", "fixture");
  const created = converter.start();
  converter.push(chunk({ content: "answer" }, "stop"));
  const completed = converter.finish();
  expect(created).toMatchObject([{ response: { status: "in_progress", output: [] } }]);
  expect(completed.at(-1)).toMatchObject({ response: { status: "completed", output: [{ content: [{ text: "answer" }] }] } });
});

it("preserves interleaved image parts and their details in user history", () => {
  const url = "data:image/png;base64,iVBORw0KGgo=";
  const input = [{ role: "user", content: [
    { type: "input_text", text: "First" },
    { type: "input_image", image_url: url, detail: "high" },
    { type: "input_text", text: "Second" },
    { type: "input_image", image_url: url },
  ] }, { role: "assistant", content: "Two images." }, { role: "user", content: "Compare." }];
  expect(responsesToChat(request(input)).request.messages).toEqual([
    { role: "user", content: [
      { type: "text", text: "First" },
      { type: "image_url", image_url: { url, detail: "high" } },
      { type: "text", text: "Second" },
      { type: "image_url", image_url: { url } },
    ] }, { role: "assistant", content: "Two images." }, { role: "user", content: "Compare." },
  ]);
});

it.each([
  { image_url: "file:///secret.png" },
  { image_url: "https://example.com/secret.png" },
  { image_url: "data:image/svg+xml;base64,c2VjcmV0" },
  { image_url: "data:image/png;base64," },
  { image_url: "data:image/png;base64,secret!=" },
  { file_id: "secret" },
  { image_url: "data:image/png;base64,c2VjcmV0", file_id: "secret" },
  { image_url: "data:image/png;base64,c2VjcmV0", detail: "original" },
])("rejects unsupported image inputs without exposing data", image => {
  expect(() => responsesToChat(request([{ role: "user", content: [{ type: "input_image", ...image }] }]))).toThrow();
  try { responsesToChat(request([{ role: "user", content: [{ type: "input_image", ...image }] }])); }
  catch (error) { expect(String(error)).not.toContain("secret"); }
});

it.each(["system", "developer", "assistant"])("rejects images in %s messages", role => {
  expect(() => responsesToChat(request([{ role, content: [{ type: "input_image", image_url: "data:image/png;base64,c2VjcmV0" }] }]))).toThrow();
});

it.each(["none", "low", "high", "max"])("forwards explicit %s reasoning effort", effort => {
  expect(responsesToChat({ ...request("hello"), reasoning: { effort, summary: "none" } }).request.reasoning).toEqual({ effort });
});

it.each([undefined, {}, { summary: "none" }])("does not invent a reasoning effort for absent controls", reasoning => {
  expect(responsesToChat({ ...request("hello"), reasoning }).request).not.toHaveProperty("reasoning");
});

it.each([{ effort: "medium" }, { effort: "xhigh" }, { effort: "invalid" }, { effort: "high", summary: "auto" }, { max_tokens: 100 }])("rejects unsupported reasoning controls", reasoning => {
  expect(() => responsesToChat({ ...request("hello"), reasoning })).toThrow();
});

it("shortens long tool identities consistently across definitions, choice, output and history", () => {
  const namespace = "mcp__codex_apps__codex_document_control";
  const names = ["_execute_document_command", "_get_document_tool_schemas"];
  const tools = [{type:"namespace",name:namespace,tools:names.map(name=>({type:"function",name,parameters:{type:"object"}}))}];
  const source={...request([]),tools,tool_choice:{type:"function",namespace,name:names[0]}};
  const converted=responsesToChat(source);
  const aliases=[...converted.toolNames.keys()];
  expect(new Set(aliases).size).toBe(2);
  for(const alias of aliases) expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
  expect(converted.request.tool_choice).toEqual({type:"function",function:{name:aliases[0]}});
  const stream=new ChatToResponses("r","fixture",converted.toolNames);
  stream.push(chunk({tool_calls:[{index:0,id:"call",type:"function",function:{name:aliases[0],arguments:"{}"}}]},"tool_calls"));
  const item=stream.finish().find(event=>event.type === "response.output_item.done")?.item;
  expect(item).toMatchObject({name:names[0],namespace});
  const replay=responsesToChat({...source,input:[item,{type:"function_call_output",call_id:"call",output:"ok"}],tools:[{...tools[0],tools:[...tools[0]!.tools].reverse()}]});
  expect(replay.request.messages[0]).toMatchObject({tool_calls:[{function:{name:aliases[0]}}]});
  expect(replay.toolNames.get(aliases[0]!)).toEqual({name:names[0],namespace});
  expect([...responsesToChat({...request([]),tools:[{type:"function",name:"x".repeat(80),parameters:{}}]}).toolNames.keys()][0]).toHaveLength(57);
});

it.each(["length", "content_filter"])("preserves partial text and reasoning in %s terminal output without publishing partial tools", reason => {
  const converter = new ChatToResponses("r", "fixture");
  converter.push(chunk({ reasoning: "partial thought" }));
  converter.push(chunk({ content: "partial answer", tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "tool", arguments: '{"incomplete":' } }] }));
  converter.push(chunk({}, reason));
  const events = converter.finish();
  expect(events.at(-1)).toMatchObject({ type: "response.incomplete", response: { status: "incomplete", output: [
    { type: "reasoning", summary: [{ text: "partial thought" }] },
    { type: "message", status: "incomplete", content: [{ text: "partial answer" }] },
  ] } });
  expect(events.some(event => event.type === "response.output_item.done")).toBe(true);
  expect(events.some(event => event.type === "response.completed" || event.type === "response.function_call_arguments.done")).toBe(false);
});

it("preserves reasoning-only output on length termination", () => {
  const converter = new ChatToResponses("r", "fixture");
  converter.push(chunk({ reasoning: "partial thought" }, "length"));
  expect(converter.finish().at(-1)).toMatchObject({ response: { output: [{ summary: [{ text: "partial thought" }] }] } });
});
