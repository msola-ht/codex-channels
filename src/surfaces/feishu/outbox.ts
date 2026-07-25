import type { Logger } from "pino";

import {
  isCriticalOutputEvent,
  type OutputEvent,
} from "../../conversation-core/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import type { SurfaceOutputPort } from "../types.js";
import { renderFeishuOutput } from "./renderer.js";

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
      () => this.messagePort.sendText(event.target.conversationId, text),
      isCriticalOutputEvent(event),
    );
  }

  notifyText(chatId: string, text: string): boolean {
    if (this.closed) {
      return false;
    }
    return this.delivery.enqueue(
      chatId,
      () => this.messagePort.sendText(chatId, text),
      true,
    );
  }

  deliverText(chatId: string, text: string): Promise<void> {
    return this.delivery.runOrdered(
      chatId,
      () => this.messagePort.sendText(chatId, text),
    );
  }

  close(): Promise<void> {
    this.closed = true;
    return this.delivery.close();
  }
}
