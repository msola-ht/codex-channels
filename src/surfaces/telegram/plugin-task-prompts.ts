export interface TelegramPluginTaskPrompt {
  chatId: string;
  actorId: string;
  messageId: number;
  pluginId: string;
  pluginName: string;
}

export type TelegramPluginTaskPromptResult =
  | { kind: "none" | "expired" | "forbidden" }
  | { kind: "matched"; pluginId: string; pluginName: string };

interface StoredPrompt extends TelegramPluginTaskPrompt {
  createdAtMs: number;
}

export class TelegramPluginTaskPrompts {
  private readonly prompts = new Map<string, StoredPrompt>();
  private readonly now: () => number;
  private readonly lifetimeMs: number;
  private readonly capacity: number;

  constructor(options: {
    now?: () => number;
    lifetimeMs?: number;
    capacity?: number;
  } = {}) {
    this.now = options.now ?? Date.now;
    this.lifetimeMs = options.lifetimeMs ?? 10 * 60_000;
    this.capacity = options.capacity ?? 100;
  }

  add(prompt: TelegramPluginTaskPrompt): void {
    while (this.prompts.size >= this.capacity) {
      const oldest = this.prompts.keys().next().value;
      if (oldest === undefined) break;
      this.prompts.delete(oldest);
    }
    const key = promptKey(prompt.chatId, prompt.messageId);
    this.prompts.delete(key);
    this.prompts.set(key, { ...prompt, createdAtMs: this.now() });
  }

  consume(
    chatId: string,
    actorId: string,
    replyToMessageId: number,
  ): TelegramPluginTaskPromptResult {
    const key = promptKey(chatId, replyToMessageId);
    const prompt = this.prompts.get(key);
    if (!prompt) return { kind: "none" };
    if (this.now() - prompt.createdAtMs > this.lifetimeMs) {
      this.prompts.delete(key);
      return { kind: "expired" };
    }
    if (prompt.actorId !== actorId) return { kind: "forbidden" };
    this.prompts.delete(key);
    return {
      kind: "matched",
      pluginId: prompt.pluginId,
      pluginName: prompt.pluginName,
    };
  }

  clear(): void {
    this.prompts.clear();
  }
}

function promptKey(chatId: string, messageId: number): string {
  return `${chatId}:${messageId}`;
}
