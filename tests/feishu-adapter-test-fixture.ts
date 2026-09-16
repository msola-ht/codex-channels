import pino from "pino";
import { vi } from "vitest";

import type { ScheduledTaskUseCases } from "../src/application/index.js";
import {
  FeishuConversationAdapter as ProductionFeishuConversationAdapter,
  FeishuOutbox,
  type FeishuInboxMessage,
} from "../src/surfaces/feishu/index.js";
import {
  conversationCommandExecutor,
  conversationInputUseCases,
  type ConversationMethodOverrides,
} from "./conversation-command-fixture.js";

export const message: Extract<FeishuInboxMessage, { kind: "text" }> = {
  target: {
    surface: "feishu",
    accountId: "cli_0123456789abcdef",
    conversationId: "oc_chat",
  },
  actorId: "ou_actor",
  eventId: "event-1",
  messageId: "om_message",
  createdAtMs: 1_784_900_000_000,
  kind: "text",
  text: "继续开发",
};

export const imagePort = {
  download: vi.fn(),
};

type FeishuAdapterArguments = ConstructorParameters<
  typeof ProductionFeishuConversationAdapter
>;

export class FeishuConversationAdapter extends ProductionFeishuConversationAdapter {
  constructor(
    conversations: ConversationMethodOverrides,
    outbox: FeishuAdapterArguments[1],
    images: FeishuAdapterArguments[2],
    permissionStatus?: FeishuAdapterArguments[4],
    oauth?: FeishuAdapterArguments[5],
    commandCenter?: FeishuAdapterArguments[6],
    applicationSetup?: FeishuAdapterArguments[7],
    interactions?: FeishuAdapterArguments[8],
    inputOptions: FeishuAdapterArguments[9] & {
      scheduledTasks?: ScheduledTaskUseCases;
    } = {},
  ) {
    const { scheduledTasks, ...options } = inputOptions;
    super(
      conversationInputUseCases(conversations),
      outbox,
      images,
      conversationCommandExecutor(conversations, scheduledTasks),
      permissionStatus,
      oauth,
      commandCenter,
      applicationSetup,
      interactions,
      options,
    );
  }
}

export function createOutbox(): {
  outbox: FeishuOutbox;
  sent: Array<{ chatId: string; text: string }>;
} {
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    sent,
    outbox: new FeishuOutbox(
      message.target.accountId,
      {
        sendCard: async () => "om_card",
        updateCard: async () => {},
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        sendPost: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        sendMarkdownCard: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        createStreamingCard: async () => ({
          cardId: "735537276613415731",
          messageId: "om_stream",
        }),
        updateStreamingCard: async () => {},
        finishStreamingCard: async () => {},
      },
      pino({ level: "silent" }),
    ),
  };
}
