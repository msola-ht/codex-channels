import type { Logger } from "pino";

import {
  isCriticalOutputEvent,
  type OutputEvent,
} from "../../conversation-core/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import type { SurfaceOutputPort } from "../types.js";
import { renderFeishuOutput } from "./renderer.js";

const maximumFeishuTextMessageBytes = 20_000;
const maximumFeishuTextChunks = 5;
const feishuChunkHeaderReserveBytes = 64;
const feishuTruncationNotice = "\n\n[内容过长，已截断]";

export interface FeishuTextMessagePort {
  sendText(chatId: string, text: string): Promise<void>;
}

export class FeishuOutbox implements SurfaceOutputPort {
  private readonly delivery: ConversationDeliveryQueue;
  private closed = false;

  constructor(
    private readonly accountId: string,
    private readonly messagePort: FeishuTextMessagePort,
    logger: Logger,
  ) {
    this.delivery = new ConversationDeliveryQueue(logger, {
      component: "Feishu",
    });
  }

  handle(event: OutputEvent): void {
    if (
      this.closed
      || event.target.surface !== "feishu"
      || event.target.accountId !== this.accountId
    ) {
      return;
    }
    const text = renderFeishuOutput(event);
    if (text === null) {
      return;
    }
    this.delivery.enqueue(
      event.target.conversationId,
      () => this.sendText(event.target.conversationId, text),
      isCriticalOutputEvent(event),
    );
  }

  notifyText(chatId: string, text: string): boolean {
    if (this.closed) {
      return false;
    }
    return this.delivery.enqueue(
      chatId,
      () => this.sendText(chatId, text),
      true,
    );
  }

  deliverText(chatId: string, text: string): Promise<void> {
    return this.delivery.runOrdered(
      chatId,
      () => this.sendText(chatId, text),
    );
  }

  close(): Promise<void> {
    this.closed = true;
    return this.delivery.close();
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    for (const chunk of splitFeishuText(text)) {
      await this.messagePort.sendText(chatId, chunk);
    }
  }
}

function splitFeishuText(text: string): string[] {
  if (Buffer.byteLength(text, "utf8") <= maximumFeishuTextMessageBytes) {
    return [text];
  }
  const payloadLimit =
    maximumFeishuTextMessageBytes - feishuChunkHeaderReserveBytes;
  const payloads: string[] = [];
  let characters: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > payloadLimit && characters.length > 0) {
      payloads.push(characters.join(""));
      if (payloads.length === maximumFeishuTextChunks) {
        truncated = true;
        characters = [];
        break;
      }
      characters = [];
      bytes = 0;
    }
    characters.push(character);
    bytes += characterBytes;
  }
  if (characters.length > 0) {
    payloads.push(characters.join(""));
  }
  if (truncated) {
    const lastIndex = payloads.length - 1;
    payloads[lastIndex] = appendWithinByteLimit(
      payloads[lastIndex]!,
      feishuTruncationNotice,
      payloadLimit,
    );
  }
  return payloads.map(
    (payload, index) => `（${index + 1}/${payloads.length}）\n${payload}`,
  );
}

function appendWithinByteLimit(
  text: string,
  suffix: string,
  byteLimit: number,
): string {
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const kept: string[] = [];
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes + suffixBytes > byteLimit) {
      break;
    }
    kept.push(character);
    bytes += characterBytes;
  }
  return `${kept.join("")}${suffix}`;
}
