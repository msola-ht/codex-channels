import { createHash } from "node:crypto";
import type { ChatReasoningEffort } from "./chat-request.js";
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
  reasoning?: { effort: ChatReasoningEffort };
  response_format?: JsonObject;
}

/** Stateless conversion: the caller supplies complete Responses input on every request. */
export interface ChatToolIdentity { name: string; namespace?: string; kind: ChatToolKind }
export function responsesToChat(value: unknown, supportedReasoningEfforts?: readonly string[]): { request: ChatRequest; toolNames: ReadonlyMap<string, ChatToolIdentity> } {
  const source = object(value);
  const allowed = new Set(["model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options", "store", "include", "reasoning", "text", "service_tier", "prompt_cache_key", "client_metadata", "max_output_tokens"]);
  if (Object.keys(source).some(key => !allowed.has(key))) throw new ModelConversionError("Unsupported Responses request field");
  if (source.stream !== true || source.store === true) throw new ModelConversionError("Only stateless streaming Responses requests are supported");
  if (source.service_tier != null && source.service_tier !== "default" && source.service_tier !== "auto") throw new ModelConversionError("Unsupported service tier");
  let responseFormat: JsonObject | undefined;
  if (source.text != null) {
    const text = object(source.text);
    if (Object.keys(text).some(key => !["format", "verbosity"].includes(key))) throw new ModelConversionError("Unsupported Responses text controls");
    // Chat 上游没有 verbosity 等价字段；Codex 仅在目录声明支持时携带，取值校验后忽略。
    if (text.verbosity != null && (typeof text.verbosity !== "string" || !["low", "medium", "high"].includes(text.verbosity))) throw new ModelConversionError("Unsupported Responses text verbosity");
    if (text.format != null) responseFormat = chatResponseFormat(text.format);
  }
  let reasoningControl: ChatRequest["reasoning"];
  if (source.reasoning != null) {
    const reasoning = object(source.reasoning);
    if (Object.keys(reasoning).some(key => !["effort", "summary"].includes(key))
      || (reasoning.summary != null && reasoning.summary !== "none")) throw new ModelConversionError("Reasoning controls are unsupported by this Chat adapter");
    const effort = reasoning.effort;
    if (effort != null) {
      if (effort !== "none" && effort !== "minimal" && effort !== "low" && effort !== "medium"
        && effort !== "high" && effort !== "xhigh" && effort !== "max"
        && !(effort === "enabled" && supportedReasoningEfforts?.includes("enabled"))) throw new ModelConversionError("Unsupported Chat reasoning effort");
      if (supportedReasoningEfforts && !supportedReasoningEfforts.includes(effort)) throw new ModelConversionError("Reasoning option is not supported by this model");
      reasoningControl = { effort };
    }
  }
  if (source.include != null && array(source.include).some(entry => entry !== "reasoning.encrypted_content")) throw new ModelConversionError("Unsupported Responses include");
  const toolNames = new Map<string, ChatToolIdentity>();
  const messages: ChatMessage[] = [];
  if (source.instructions != null) messages.push({ role: "system", content: string(source.instructions) });
  const pendingCalls = new Set<string>();
  const seenCalls = new Set<string>();
  const pendingImages: ChatUserContentPart[] = [];
  // Chat 的 tool 消息只能携带文本，工具结果中的图片改由结果之后的 user 消息承载。
  // 并行调用要求 tool 消息连续，因此图片先缓存，等本轮结果齐了再一次性写出。
  const flushToolImages = (): void => {
    if (pendingImages.length === 0) return;
    messages.push({ role: "user", content: pendingImages.splice(0, pendingImages.length) });
  };
  // A Chat assistant message owns its text, reasoning and all parallel calls.
  // Once tool results start, a new assistant group requires every result first.
  const assistant = (): ChatTextMessage => {
    const last = messages.at(-1);
    if (last?.role === "assistant") return last;
    if (pendingCalls.size) throw new ModelConversionError("Missing tool results");
    flushToolImages();
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
  const pushToolOutput = (callId: string, value: unknown): void => {
    const result = toolResult(callId, value);
    pushResult(callId, result.text);
    pendingImages.push(...result.images);
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
      pushToolOutput(string(item.call_id), item.output);
    } else if (item.type === "custom_tool_call_output") {
      pushToolOutput(string(item.call_id), item.output);
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
        flushToolImages();
        messages.push(role === "user"
          ? { role, content: userContent(item.content) }
          : { role, content: textContent(item.content) });
      }
    } else if (item.type === "agent_message") {
      // Codex multi-agent v2 的 agent_message 是 Responses 私有输入项；Chat 上游没有等价类型，
      // 只能降级为普通 user 消息，正文按可读文本原样搬运。
      if (pendingCalls.size) throw new ModelConversionError("Missing tool results");
      flushToolImages();
      messages.push({ role: "user", content: agentMessageText(item.content) });
    } else {
      throw new ModelConversionError("Unsupported Responses input item");
    }
  }
  if (pendingCalls.size) throw new ModelConversionError("Missing tool results");
  flushToolImages();
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
    const fn: JsonObject = { name: convertedName, parameters: chatToolParameters(tool.parameters) };
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
    // Unmapped top-level declarations belong to the upstream. They do not
    // acquire a local execution identity or become client-side functions.
    if (!["function", "custom", "namespace"].includes(string(tool.type)) && !(tool.type === "tool_search" && tool.execution === "client")) return [tool];
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
      const type = string(choice.type);
      if (type === "function" || type === "custom") {
        result.tool_choice = { type: "function", function: { name: chatToolName(string(choice.name), choice.namespace == null ? undefined : string(choice.namespace)) } };
      } else if (type === "tool_search" && toolNames.get(toolSearchName)?.kind === "tool_search") {
        result.tool_choice = { type: "function", function: { name: toolSearchName } };
      } else {
        result.tool_choice = choice;
      }
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
  if (responseFormat) result.response_format = responseFormat;
  return { request: result, toolNames };
}

/** Codex 只请求 json_schema；Chat 用 `response_format` 表达同一份 schema 约束。 */
function chatResponseFormat(value: unknown): JsonObject {
  const format = object(value);
  if (format.type !== "json_schema" || Object.keys(format).some(key => !["type", "strict", "schema", "name"].includes(key))) {
    throw new ModelConversionError("Unsupported Responses output format");
  }
  const name = string(format.name);
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(name) || typeof format.strict !== "boolean") throw new ModelConversionError("Unsupported Responses output format");
  return { type: "json_schema", json_schema: { name, strict: format.strict, schema: object(format.schema) } };
}

function userContent(value: unknown): string | ChatUserContentPart[] {
  if (typeof value === "string") return value;
  const parts: ChatUserContentPart[] = array(value).map(raw => {
    const part = object(raw);
    if (part.type === "input_text") return { type: "text", text: string(part.text) };
    if (part.type !== "input_image") throw new ModelConversionError("Unsupported user content");
    return chatImagePart(part);
  });
  return parts.some(part => part.type === "image_url") ? parts : parts.map(part => part.type === "text" ? part.text : "").join("");
}

/** 用户输入与工具结果共用同一份内联图片校验；保持纯转换，不下载也不解码。 */
function chatImagePart(part: JsonObject): ChatUserContentPart {
  if (part.file_id != null) throw new ModelConversionError("Image references are unsupported");
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
}

/** 工具结果只保留文本，图片交给紧随其后的 user 消息；Chat 的 tool 消息不能携带图片。 */
function toolResult(callId: string, value: unknown): { text: string; images: ChatUserContentPart[] } {
  if (typeof value === "string") return { text: value, images: [] };
  const text: string[] = [];
  const images: ChatUserContentPart[] = [];
  let imageIndex = 0;
  for (const raw of array(value)) {
    const part = object(raw);
    if (part.type === "input_text" || part.type === "output_text") { text.push(string(part.text)); continue; }
    if (part.type === "input_image") {
      const image = chatImagePart(part);
      // 在原文位置与图片前写入相同标记，保留并行调用归属和混合图文顺序。
      const label = `[Tool output image: ${JSON.stringify({ call_id: callId, image: ++imageIndex })}]`;
      text.push(`\n${label}\n`);
      images.push({ type: "text", text: label }, image);
      continue;
    }
    throw new ModelConversionError("Unsupported tool result content");
  }
  return { text: text.join(""), images };
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  return array(value).map(raw => {
    const part = object(raw);
    if (!["input_text", "output_text"].includes(String(part.type))) throw new ModelConversionError("Only text content is supported");
    return string(part.text);
  }).join("");
}

/**
 * Codex multi-agent v2 的 agent_message 正文由可读信封与载荷两段构成，信封自带结尾换行，
 * 因此直接拼接即可还原锁定 CLI 的明文渲染。
 * 锁定 CLI 只在官方 Provider 上标记加密参数；第三方 Provider 的 `encrypted_content`
 * 承载的就是明文载荷，所以按原文搬运，不解密、不伪造占位文本，也不推断载荷内容。
 */
function agentMessageText(value: unknown): string {
  const text = array(value).map(raw => {
    const part = object(raw);
    if (part.type === "input_text") return string(part.text);
    if (part.type === "encrypted_content") return string(part.encrypted_content);
    throw new ModelConversionError("Unsupported agent message content");
  }).join("");
  if (text.trim() === "") throw new ModelConversionError("Empty agent message");
  return text;
}

/** 工具参数 schema 必须保持对象形态；标记清理只做副本，不修改调用方传入的报文。 */
function chatToolParameters(value: unknown): JsonObject {
  return stripEncryptedMarker(object(value)) as JsonObject;
}

/**
 * `encrypted` 是 Codex Responses 私有的参数标记（锁定 `JsonSchema` 注释：Responses-only
 * marker for reviewed encrypted tool parameters）。Chat 上游没有等价语义，保留会让上游或模型
 * 把它当成参数要求，因此仅在 schema 节点删除布尔标记。枚举等实例数据与属性名保持原样。
 */
function stripEncryptedMarker(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => stripEncryptedMarker(entry));
  if (!value || typeof value !== "object") return value;
  // 对象展开创建自有数据属性，保留 JSON 中的 __proto__，不触发原型 setter。
  const result: JsonObject = { ...value };
  if (typeof result.encrypted === "boolean") delete result.encrypted;
  // 与锁定 CLI JsonSchema 的子 schema 字段一致；不递归进入 enum 等实例数据。
  for (const key of ["items", "additionalProperties", "anyOf", "oneOf", "allOf"] as const) {
    if (Object.hasOwn(result, key)) result[key] = stripEncryptedMarker(result[key]);
  }
  for (const key of ["properties", "$defs", "definitions"] as const) {
    const table = result[key];
    if (table && typeof table === "object" && !Array.isArray(table)) {
      result[key] = Object.fromEntries(Object.entries(table).map(
        ([name, schema]) => [name, stripEncryptedMarker(schema)],
      ));
    }
  }
  return result;
}

function chatToolName(name: string, namespace?: string): string {
  const result = namespace === undefined ? name : `${namespace}__${name}`;
  if (!name || (namespace !== undefined && !namespace) || !/^[a-zA-Z0-9_-]+$/u.test(result)) throw new ModelConversionError("Unsupported Chat tool name");
  if (result.length <= 64) return result;
  // Stable across requests and history, with the full identity retained in toolNames.
  const digest = createHash("sha256").update(JSON.stringify([namespace ?? null, name])).digest("hex").slice(0, 32);
  return `${result.slice(0, 24)}_${digest}`;
}
