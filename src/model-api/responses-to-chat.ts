import { createHash } from "node:crypto";
import { array, ModelConversionError, object, string, toolSearchArguments } from "./validation.js";
import type { JsonObject } from "./validation.js";

/** Chat 只有 function 一种工具，因此 Responses 的 function / custom(freeform) / 客户端 tool_search 都映射为 function，回程再还原原始形态。 */
export type ChatToolKind = "function" | "custom" | "tool_search";
/** 客户端执行的检索工具名；与锁定 Codex 的 `TOOL_SEARCH_TOOL_NAME` 一致。 */
const toolSearchName = "tool_search";
const freeformInputDescription = "Freeform tool input, passed through verbatim.";
/** 自由格式工具在本上游只能以 JSON function 表达，必须明确告知模型输入放在 input 字段。 */
const freeformBridgeNote = "This upstream invokes the tool as a JSON function: put the complete freeform input into the \"input\" field as a single string.";

export type ChatUserContentPart = { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };
interface ChatTextMessage {
  role: "system" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  reasoning?: string;
  reasoning_content?: string;
}
export type ChatMessage = ChatTextMessage | { role: "user"; content: string | ChatUserContentPart[] };
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: JsonObject[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_completion_tokens?: number;
  reasoning?: { effort: "none" | "low" | "high" | "max" };
}

/** Stateless conversion: the caller supplies complete Responses input on every request. */
export interface ChatToolIdentity { name: string; namespace?: string; kind: ChatToolKind }
export function responsesToChat(value: unknown): { request: ChatRequest; toolNames: ReadonlyMap<string, ChatToolIdentity> } {
  const source = object(value);
  const allowed = new Set(["model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options", "store", "include", "reasoning", "text", "service_tier", "prompt_cache_key", "client_metadata", "max_output_tokens"]);
  if (Object.keys(source).some(key => !allowed.has(key))) throw new ModelConversionError("Unsupported Responses request field");
  if (source.stream !== true || source.store === true) throw new ModelConversionError("Only stateless streaming Responses requests are supported");
  if (source.service_tier != null && source.service_tier !== "default" && source.service_tier !== "auto") throw new ModelConversionError("Unsupported service tier");
  if (source.text != null && Object.keys(object(source.text)).length > 0) throw new ModelConversionError("Structured output and verbosity are unsupported");
  let reasoningControl: ChatRequest["reasoning"];
  if (source.reasoning != null) {
    const reasoning = object(source.reasoning);
    if (Object.keys(reasoning).some(key => !["effort", "summary"].includes(key))
      || (reasoning.summary != null && reasoning.summary !== "none")) throw new ModelConversionError("Reasoning controls are unsupported by this Chat adapter");
    const effort = reasoning.effort;
    if (effort != null) {
      if (effort !== "none" && effort !== "low" && effort !== "high" && effort !== "max") throw new ModelConversionError("Unsupported Chat reasoning effort");
      reasoningControl = { effort };
    }
  }
  if (source.include != null && array(source.include).some(entry => entry !== "reasoning.encrypted_content")) throw new ModelConversionError("Unsupported Responses include");
  const toolNames = new Map<string, ChatToolIdentity>();
  const messages: ChatMessage[] = [];
  if (source.instructions != null) messages.push({ role: "system", content: string(source.instructions) });
  const pendingCalls = new Set<string>();
  const seenCalls = new Set<string>();
  // A Chat assistant message owns its text, reasoning and all parallel calls.
  // Once tool results start, a new assistant group requires every result first.
  const assistant = (): ChatTextMessage => {
    const last = messages.at(-1);
    if (last?.role === "assistant") return last;
    if (pendingCalls.size) throw new ModelConversionError("Missing tool results");
    const message: ChatTextMessage = { role: "assistant", content: null };
    messages.push(message);
    return message;
  };
  const chatCallName = (item: JsonObject): string =>
    chatToolName(string(item.name), item.namespace == null ? undefined : string(item.namespace));
  const pushCall = (message: ChatTextMessage, callId: string, name: string, argumentsText: string): void => {
    if (!callId || seenCalls.has(callId)) throw new ModelConversionError("Invalid tool call identity");
    seenCalls.add(callId); pendingCalls.add(callId);
    (message.tool_calls ??= []).push({ id: callId, type: "function", function: { name, arguments: argumentsText } });
  };
  const pushResult = (callId: string, content: string): void => {
    if (!pendingCalls.delete(callId)) throw new ModelConversionError("Unmatched tool result");
    messages.push({ role: "tool", tool_call_id: callId, content });
  };
  /** tool_search 结果带回的工具必须在本轮声明；Chat 上游没有“上游自动补工具”的等价机制。 */
  const discovered: unknown[] = [];
  const input = typeof source.input === "string" ? [{ role: "user", content: source.input }] : array(source.input);
  for (const raw of input) {
    const item = object(raw);
    if (item.type === "function_call") {
      if (item.encrypted_function_args != null) throw new ModelConversionError("Encrypted tool arguments are unsupported");
      const message = assistant();
      pushCall(message, string(item.call_id), chatCallName(item), string(item.arguments));
    } else if (item.type === "custom_tool_call") {
      // 自由格式工具的输入在 Chat 侧包一层 input 字段，回程再取出原始文本。
      const message = assistant();
      pushCall(message, string(item.call_id), chatCallName(item), JSON.stringify({ input: string(item.input) }));
    } else if (item.type === "tool_search_call") {
      if (item.execution !== "client") throw new ModelConversionError("Server-executed tool search is unsupported");
      const message = assistant();
      pushCall(message, string(item.call_id), toolSearchName, JSON.stringify(toolSearchArguments(item.arguments)));
    } else if (item.type === "function_call_output") {
      pushResult(string(item.call_id), textContent(item.output));
    } else if (item.type === "custom_tool_call_output") {
      pushResult(string(item.call_id), textContent(item.output));
    } else if (item.type === "tool_search_output") {
      if (item.execution !== "client") throw new ModelConversionError("Server-executed tool search is unsupported");
      pushResult(string(item.call_id), JSON.stringify(array(item.tools)));
      discovered.push(...array(item.tools));
    } else if (item.type === "reasoning") {
      if (item.encrypted_content != null) throw new ModelConversionError("Encrypted reasoning cannot be converted to Chat");
      // Full reasoning content and display summaries are distinct wire fields.
      // When full text exists, do not substitute or append its summary.
      if (item.content != null) {
        const thought = array(item.content).map(raw => {
          const part = object(raw);
          if (part.type !== "reasoning_text") throw new ModelConversionError("Unsupported reasoning content");
          return string(part.text);
        }).join("");
        const message = assistant();
        message.reasoning_content = (message.reasoning_content ?? "") + thought;
        continue;
      }
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
        messages.push(role === "user"
          ? { role, content: userContent(item.content) }
          : { role, content: textContent(item.content) });
      }
    } else {
      throw new ModelConversionError("Unsupported Responses input item");
    }
  }
  if (pendingCalls.size) throw new ModelConversionError("Missing tool results");
  const result: ChatRequest = { model: string(source.model), messages, stream: true, stream_options: { include_usage: true } };
  if (reasoningControl) result.reasoning = reasoningControl;
  const convertTool = (raw: unknown, namespace?: string, loaded = false): JsonObject => {
    const tool = object(raw);
    if (namespace !== undefined && tool.type !== "function" && tool.type !== "custom") {
      throw new ModelConversionError("Unsupported namespace tool type");
    }
    if (tool.defer_loading === true && !loaded) throw new ModelConversionError("Deferred tools are unsupported");
    if (tool.type === "custom") {
      const name = string(tool.name);
      const convertedName = chatToolName(name, namespace);
      if (toolNames.has(convertedName)) throw new ModelConversionError("Conflicting Chat tool names");
      toolNames.set(convertedName, { name, ...(namespace === undefined ? {} : { namespace }), kind: "custom" });
      // Chat 没有语法约束解码；完整语法作为模型输入说明保留。
      const format = object(tool.format);
      let grammar = "";
      if (format.type === "grammar") {
        if (format.syntax !== "lark" || typeof format.definition !== "string") throw new ModelConversionError("Unsupported custom tool grammar");
        grammar = `\n\nThe input must follow this lark grammar:\n${format.definition}`;
      } else if (format.type !== "text") throw new ModelConversionError("Unsupported custom tool format");
      return { type: "function", function: {
        name: convertedName,
        description: `${string(tool.description)}\n\n${freeformBridgeNote}${grammar}`,
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: freeformInputDescription } },
          required: ["input"],
          additionalProperties: false,
        },
      } };
    }
    if (tool.type === "tool_search") {
      // 服务端执行的检索由上游自行补工具，Chat 上游没有等价机制，只能拒绝。
      if (tool.execution !== "client") throw new ModelConversionError("Server-executed tool search is unsupported");
      const convertedName = chatToolName(toolSearchName);
      if (toolNames.has(convertedName)) throw new ModelConversionError("Conflicting Chat tool names");
      toolNames.set(convertedName, { name: toolSearchName, kind: "tool_search" });
      return { type: "function", function: { name: convertedName, description: string(tool.description), parameters: object(tool.parameters) } };
    }
    if (tool.type !== "function") throw new ModelConversionError("Unsupported Responses tool type");
    const name = string(tool.name);
    const convertedName = chatToolName(name, namespace);
    if (toolNames.has(convertedName)) throw new ModelConversionError("Conflicting Chat tool names");
    toolNames.set(convertedName, { name, ...(namespace === undefined ? {} : { namespace }), kind: "function" });
    const fn: JsonObject = { name: convertedName, parameters: object(tool.parameters) };
    if (tool.description !== undefined) fn.description = string(tool.description);
    if (tool.strict !== undefined) {
      if (typeof tool.strict !== "boolean") throw new ModelConversionError();
      fn.strict = tool.strict;
    }
    return { type: "function", function: fn };
  };
  const tools: JsonObject[] = [];
  if (source.tools !== undefined) tools.push(...array(source.tools).flatMap(raw => {
    const tool = object(raw);
    return tool.type === "namespace"
      ? array(tool.tools).map(nested => convertTool(nested, string(tool.name)))
      : [convertTool(tool)];
  }));
  const addDiscovered = (raw: unknown, namespace?: string): void => {
    const tool = object(raw);
    if (tool.type !== "function" && tool.type !== "custom") throw new ModelConversionError("Unsupported discovered tool type");
    const name = string(tool.name);
    const identity = toolNames.get(chatToolName(name, namespace));
    if (identity) {
      if (identity.name !== name || identity.namespace !== namespace || identity.kind !== tool.type) {
        throw new ModelConversionError("Conflicting Chat tool names");
      }
      return;
    }
    // Codex marks search results defer_loading=true even though the client has
    // already discovered them. Chat must declare these tools eagerly.
    tools.push(convertTool(tool, namespace, true));
  };
  for (const raw of discovered) {
    const tool = object(raw);
    if (tool.type === "namespace") {
      const namespace = string(tool.name);
      for (const nested of array(tool.tools)) {
        addDiscovered(nested, namespace);
      }
      continue;
    }
    addDiscovered(tool);
  }
  if (tools.length > 0) result.tools = tools;
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

function userContent(value: unknown): string | ChatUserContentPart[] {
  if (typeof value === "string") return value;
  const parts: ChatUserContentPart[] = array(value).map(raw => {
    const part = object(raw);
    if (part.type === "input_text") return { type: "text", text: string(part.text) };
    if (part.type !== "input_image" || part.file_id != null) throw new ModelConversionError("Unsupported user content");
    const url = string(part.image_url);
    // Preserve inline data without decoding or fetching it in this pure adapter.
    // Surface image validation remains responsible for file format and size.
    const prefix = /^data:image\/(?:png|jpeg|webp|gif);base64,/u.exec(url);
    const encoded = prefix ? url.slice(prefix[0].length) : "";
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
      throw new ModelConversionError("Only inline Base64 images are supported");
    }
    const detail = part.detail;
    if (detail != null && detail !== "auto" && detail !== "low" && detail !== "high") throw new ModelConversionError("Unsupported Chat image detail");
    return { type: "image_url", image_url: { url, ...(detail == null ? {} : { detail }) } };
  });
  return parts.some(part => part.type === "image_url") ? parts : parts.map(part => part.type === "text" ? part.text : "").join("");
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
  if (!name || (namespace !== undefined && !namespace) || !/^[a-zA-Z0-9_-]+$/u.test(result)) throw new ModelConversionError("Unsupported Chat tool name");
  if (result.length <= 64) return result;
  // Stable across requests and history, with the full identity retained in toolNames.
  const digest = createHash("sha256").update(JSON.stringify([namespace ?? null, name])).digest("hex").slice(0, 32);
  return `${result.slice(0, 24)}_${digest}`;
}
