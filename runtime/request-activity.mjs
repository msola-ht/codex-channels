const toolTypes = new Set(["function_call", "custom_tool_call", "tool_search_call", "web_search_call", "file_search_call", "computer_call", "image_generation_call", "code_interpreter_call", "mcp_call"]);
const fields = ["toolResult", "reply", "toolCalls", "tools", "partial"];
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nameValid = value => typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(value);
const textPresent = value => typeof value === "string" && value.trim().length > 0;

export function validRequestActivity(value) {
  return record(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
    && ["toolResult", "reply", "toolCalls", "partial"].every(key => typeof value[key] === "boolean")
    && Array.isArray(value.tools) && value.tools.length <= 4 && value.tools.every(nameValid)
    && new Set(value.tools).size === value.tools.length && (value.toolCalls || value.tools.length === 0);
}

/** Bounded metadata only: never retain prompts, tool arguments or tool results. */
export class RequestActivityObserver {
  #value = { toolResult: false, reply: false, toolCalls: false, tools: [], partial: false };
  #seen = false;
  #chatNames = new Map();
  request(body, protocol = "responses") {
    if (!record(body)) { this.incomplete(); return; }
    this.#seen = true;
    const input = protocol === "chat" ? body.messages : body.input;
    const last = Array.isArray(input) ? input.at(-1) : undefined;
    this.#value.toolResult ||= protocol === "chat" ? last?.role === "tool"
      : ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(last?.type);
  }
  incomplete() { this.#seen = true; this.#value.partial = true; }
  #tool(name) {
    this.#value.toolCalls = true;
    if (!nameValid(name)) return;
    if (!this.#value.tools.includes(name)) {
      if (this.#value.tools.length < 4) this.#value.tools.push(name);
      else this.#value.partial = true;
    }
  }
  #item(item) {
    if (!record(item)) return;
    if (item.type === "message" && (textPresent(item.content) || textPresent(item.refusal)
      || Array.isArray(item.content) && item.content.some(part => textPresent(part?.text) || textPresent(part?.refusal)))) this.#value.reply = true;
    if (toolTypes.has(item.type)) this.#tool(item.name ?? (!["function_call", "custom_tool_call", "mcp_call"].includes(item.type) ? item.type : undefined));
  }
  response(value, protocol = "responses") {
    if (!record(value)) { this.incomplete(); return; }
    this.#seen = true;
    if (protocol === "chat") {
      if (!Array.isArray(value.choices)) return;
      for (const [position, choice] of value.choices.entries()) {
        if (!record(choice)) { this.incomplete(); continue; }
        const message = choice?.message ?? choice?.delta;
        if (record(message)) this.#item({ ...message, type: "message" });
        const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
        for (const [toolPosition, call] of calls.entries()) {
          this.#value.toolCalls = true;
          if (choice.message) { this.#tool(call?.function?.name); continue; }
          const index = choice.index ?? position;
          const toolIndex = call?.index ?? toolPosition;
          if (!Number.isSafeInteger(index) || index < 0 || index > 128 || !Number.isSafeInteger(toolIndex) || toolIndex < 0 || toolIndex >= 64) { this.incomplete(); continue; }
          const key = `${index}:${toolIndex}`;
          if (!this.#chatNames.has(key) && this.#chatNames.size >= 64) { this.incomplete(); continue; }
          const old = this.#chatNames.has(key) ? this.#chatNames.get(key) : "";
          if (old === null) continue;
          const fragment = call?.function?.name;
          if (typeof fragment !== "string") continue;
          if (old.length + fragment.length > 128) { this.#chatNames.set(key, null); this.incomplete(); }
          else this.#chatNames.set(key, old + fragment);
        }
        if (choice.finish_reason != null) this.finishChatChoice(choice.index ?? position);
      }
      return;
    }
    const response = record(value.response) ? value.response : value;
    if (Array.isArray(response.output)) for (const item of response.output) this.#item(item);
    if (["response.output_item.added", "response.output_item.done"].includes(value.type)) this.#item(value.item);
    if (["response.output_text.delta", "response.refusal.delta"].includes(value.type) && textPresent(value.delta)) this.#value.reply = true;
  }
  finishChatChoice(index) {
    for (const [key, name] of this.#chatNames) if (key.startsWith(`${index}:`)) { this.#tool(name); this.#chatNames.delete(key); }
  }
  snapshot() {
    if (!this.#seen) return null;
    return { ...this.#value, tools: [...this.#value.tools], partial: this.#value.partial || this.#chatNames.size > 0 };
  }
}
