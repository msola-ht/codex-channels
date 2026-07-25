import type { Logger } from "pino";

import {
  isCriticalOutputEvent,
  type OutputEvent,
} from "../../conversation-core/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import type { SurfaceOutputPort } from "../types.js";
import type { FeishuCardDocument } from "./approval-card.js";
import { encodeFeishuPostContent } from "./message-content.js";
import { renderFeishuOutput } from "./renderer.js";

const maximumFeishuMessageContentBytes = 20_000;
const maximumFeishuMessageChunks = 5;
const feishuChunkHeaderReserveBytes = 64;
const feishuTruncationNotice = "\n\n[内容过长，已截断]";

export interface FeishuMessagePort {
  sendText(chatId: string, text: string): Promise<void>;
  sendPost(chatId: string, markdown: string): Promise<void>;
  sendCard(chatId: string, card: FeishuCardDocument): Promise<string>;
  updateCard(messageId: string, card: FeishuCardDocument): Promise<void>;
}

export class FeishuOutbox implements SurfaceOutputPort {
  private readonly delivery: ConversationDeliveryQueue;
  private closed = false;

  constructor(
    private readonly accountId: string,
    private readonly messagePort: FeishuMessagePort,
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
      () => event.type === "text.completed"
        ? this.sendPost(event.target.conversationId, text)
        : this.sendText(event.target.conversationId, text),
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

  notifyPost(chatId: string, markdown: string): boolean {
    if (this.closed) {
      return false;
    }
    return this.delivery.enqueue(
      chatId,
      () => this.sendPost(chatId, markdown),
      true,
    );
  }

  deliverText(chatId: string, text: string): Promise<void> {
    return this.delivery.runOrdered(
      chatId,
      () => this.sendText(chatId, text),
    );
  }

  deliverCard(
    chatId: string,
    card: FeishuCardDocument,
  ): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error("飞书输出队列已经关闭"));
    }
    return this.delivery.runOrdered(
      chatId,
      () => this.messagePort.sendCard(chatId, card),
    );
  }

  updateCard(
    chatId: string,
    messageId: string,
    card: FeishuCardDocument,
  ): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("飞书输出队列已经关闭"));
    }
    return this.delivery.runOrdered(
      chatId,
      () => this.messagePort.updateCard(messageId, card),
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

  private async sendPost(chatId: string, markdown: string): Promise<void> {
    for (const chunk of splitFeishuPost(markdown)) {
      await this.messagePort.sendPost(chatId, chunk);
    }
  }
}

function splitFeishuText(text: string): string[] {
  return splitFeishuContent(
    text,
    (value) => Buffer.byteLength(value, "utf8"),
  );
}

function splitFeishuPost(markdown: string): string[] {
  return splitFeishuContent(
    markdown,
    (value) => Buffer.byteLength(encodeFeishuPostContent(value), "utf8"),
  );
}

function splitFeishuContent(
  text: string,
  measureBytes: (value: string) => number,
): string[] {
  if (measureBytes(text) <= maximumFeishuMessageContentBytes) {
    return [text];
  }
  const payloadLimit =
    maximumFeishuMessageContentBytes - feishuChunkHeaderReserveBytes;
  const payloads: string[] = [];
  const characters = [...text];
  let offset = 0;
  while (
    offset < characters.length
    && payloads.length < maximumFeishuMessageChunks
  ) {
    const end = findLargestFittingEnd(
      characters,
      offset,
      payloadLimit,
      measureBytes,
    );
    if (end === offset) {
      throw new Error("飞书消息分片上限不足以容纳单个字符");
    }
    payloads.push(characters.slice(offset, end).join(""));
    offset = end;
  }
  if (offset < characters.length) {
    const lastIndex = payloads.length - 1;
    payloads[lastIndex] = appendWithinByteLimit(
      payloads[lastIndex]!,
      feishuTruncationNotice,
      payloadLimit,
      measureBytes,
    );
  }
  return payloads.map(
    (payload, index) => `（${index + 1}/${payloads.length}）\n${payload}`,
  );
}

function findLargestFittingEnd(
  characters: readonly string[],
  offset: number,
  byteLimit: number,
  measureBytes: (value: string) => number,
): number {
  let low = offset + 1;
  let high = characters.length;
  let best = offset;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = characters.slice(offset, middle).join("");
    if (measureBytes(candidate) <= byteLimit) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function appendWithinByteLimit(
  text: string,
  suffix: string,
  byteLimit: number,
  measureBytes: (value: string) => number,
): string {
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${suffix}`;
    if (measureBytes(candidate) <= byteLimit) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return `${characters.slice(0, best).join("")}${suffix}`;
}
