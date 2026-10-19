import { agentMessageText, stripEncryptedMarker } from "./codex-private-items.js";
import { object } from "./validation.js";
import type { JsonObject } from "./validation.js";

export interface NormalizedResponsesRequest {
  body: JsonObject;
  /** 未发生改写时保持 `false`，调用方应沿用原始字节而不是重新序列化。 */
  changed: boolean;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 第三方 Responses 上游不认识 Codex 私有的输入项与参数标记：把 multi-agent v2 的
 * `agent_message` 降级为普通 `user` 消息，并删除工具参数 schema 里的 `encrypted` 布尔标记。
 * 只改写这两处；其余顶层字段、输入项与工具声明逐字透传，未知条目交给上游判断，
 * 空正文或未知内容段的 `agent_message` 明确拒绝而不是伪造占位内容。
 */
export function normalizeResponsesRequest(value: unknown): NormalizedResponsesRequest {
  const source = object(value);
  const body: JsonObject = { ...source };
  let changed = false;

  const input = normalizeInput(source.input);
  if (input.changed) {
    body.input = input.value;
    changed = true;
  }
  const tools = normalizeTools(source.tools);
  if (tools.changed) {
    body.tools = tools.value;
    changed = true;
  }
  return { body: changed ? body : source, changed };
}

function normalizeInput(value: unknown): { value: unknown; changed: boolean } {
  if (!Array.isArray(value)) return { value, changed: false };
  const entries: unknown[] = value;
  let changed = false;
  const items = entries.map(item => {
    if (!isRecord(item) || item.type !== "agent_message") return item;
    changed = true;
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: agentMessageText(item.content) }],
    };
  });
  return { value: changed ? items : value, changed };
}

function normalizeTools(value: unknown): { value: unknown; changed: boolean } {
  if (!Array.isArray(value)) return { value, changed: false };
  const entries: unknown[] = value;
  let changed = false;
  const tools = entries.map(raw => {
    if (!isRecord(raw)) return raw;
    const tool: JsonObject = { ...raw };
    let toolChanged = false;
    if (Object.hasOwn(raw, "parameters")) {
      const parameters = stripEncryptedMarker(raw.parameters);
      if (parameters.changed) {
        tool.parameters = parameters.value;
        toolChanged = true;
      }
    }
    if (Array.isArray(raw.tools)) {
      const nested = normalizeTools(raw.tools);
      if (nested.changed) {
        tool.tools = nested.value;
        toolChanged = true;
      }
    }
    if (!toolChanged) return raw;
    changed = true;
    return tool;
  });
  return { value: changed ? tools : value, changed };
}
