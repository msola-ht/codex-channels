import { checkpointDelivery } from "../delivery-receipt.js";
import type { FeishuCardDocument } from "./approval-card.js";
import { FeishuMessageError } from "./message-error.js";

export interface FeishuMessagePort {
  sendText(chatId: string, text: string, signal?: AbortSignal): Promise<void>;
  sendPost(chatId: string, markdown: string, signal?: AbortSignal): Promise<void>;
  sendMarkdownCard(chatId: string, markdown: string, signal?: AbortSignal): Promise<string | void>;
  sendFile?(chatId: string, fileName: string, file: Buffer, signal?: AbortSignal): Promise<void>;
  sendImage?(chatId: string, image: Buffer, signal?: AbortSignal): Promise<void>;
  replyPost?(messageId: string, markdown: string, signal?: AbortSignal): Promise<void>;
  replyMarkdownCard?(messageId: string, markdown: string, signal?: AbortSignal): Promise<string | void>;
  sendCard(chatId: string, card: FeishuCardDocument, signal?: AbortSignal): Promise<string>;
  updateCard(messageId: string, card: FeishuCardDocument, signal?: AbortSignal): Promise<void>;
  createStreamingCard(
    chatId: string,
    initialText: string,
    signal?: AbortSignal,
  ): Promise<{ cardId: string; messageId: string }>;
  createStreamingReplyCard?(
    messageId: string,
    initialText: string,
    signal?: AbortSignal,
  ): Promise<{ cardId: string; messageId: string }>;
  updateStreamingCard(
    cardId: string,
    content: string,
    sequence: number,
    signal?: AbortSignal,
  ): Promise<void>;
  finishStreamingCard(
    cardId: string,
    sequence: number,
    summary: string,
    footer?: string,
    signal?: AbortSignal,
  ): Promise<void>;
}


/** 所有 Outbox 平台操作共用一个生命周期边界，包括可选媒体、回复与原地更新。 */
export function bindOutboxMessagePort(port: FeishuMessagePort, closed: AbortSignal): FeishuMessagePort {
  async function send<T>(request: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    const signal = external === undefined ? closed : AbortSignal.any([closed, external]);
    signal.throwIfAborted();
    const result = await checkpointDelivery("feishu-message", () => request(signal),
      (error) => error instanceof FeishuMessageError && error.code === "card-create-failed");
    signal.throwIfAborted();
    return result;
  }
  return {
    sendText: (chatId, text, signal) => send((active) => port.sendText(chatId, text, active), signal),
    sendPost: (chatId, text, signal) => send((active) => port.sendPost(chatId, text, active), signal),
    sendMarkdownCard: (chatId, text, signal) => send((active) => port.sendMarkdownCard(chatId, text, active), signal),
    sendCard: (chatId, card, signal) => send((active) => port.sendCard(chatId, card, active), signal),
    updateCard: (id, card, signal) => send((active) => port.updateCard(id, card, active), signal),
    createStreamingCard: (chatId, text, signal) => send((active) => port.createStreamingCard(chatId, text, active), signal),
    updateStreamingCard: (id, text, sequence, signal) => send((active) => port.updateStreamingCard(id, text, sequence, active), signal),
    finishStreamingCard: (id, sequence, text, footer, signal) => send((active) => port.finishStreamingCard(id, sequence, text, footer, active), signal),
    ...(port.sendImage === undefined ? {} : {
      sendImage: (chatId: string, bytes: Buffer, signal?: AbortSignal) => send((active) => port.sendImage!(chatId, bytes, active), signal),
    }),
    ...(port.sendFile === undefined ? {} : {
      sendFile: (chatId: string, name: string, bytes: Buffer, signal?: AbortSignal) => send((active) => port.sendFile!(chatId, name, bytes, active), signal),
    }),
    ...(port.replyPost === undefined ? {} : {
      replyPost: (id: string, text: string, signal?: AbortSignal) => send((active) => port.replyPost!(id, text, active), signal),
    }),
    ...(port.replyMarkdownCard === undefined ? {} : {
      replyMarkdownCard: (id: string, text: string, signal?: AbortSignal) => send((active) => port.replyMarkdownCard!(id, text, active), signal),
    }),
    ...(port.createStreamingReplyCard === undefined ? {} : {
      createStreamingReplyCard: (id: string, text: string, signal?: AbortSignal) => send((active) => port.createStreamingReplyCard!(id, text, active), signal),
    }),
  };
}
