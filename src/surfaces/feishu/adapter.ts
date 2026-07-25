import type { ConversationService } from "../../application/index.js";
import { UserFacingError } from "../../conversation-core/index.js";

import type { FeishuInboxMessage } from "./inbox.js";
import type { FeishuOutbox } from "./outbox.js";
import { renderFeishuUserFacingError } from "./renderer.js";

export class FeishuConversationAdapter {
  constructor(
    private readonly conversations: Pick<ConversationService, "submit">,
    private readonly outbox: FeishuOutbox,
  ) {}

  async handle(message: FeishuInboxMessage): Promise<void> {
    try {
      const submission = await this.conversations.submit(
        message.target,
        message.text,
      );
      if (!submission.steered) {
        return;
      }
      this.outbox.notifyText(
        message.target.conversationId,
        "已将补充要求追加到当前 Turn。",
      );
    } catch (error) {
      const detail = error instanceof UserFacingError
        ? renderFeishuUserFacingError(error)
        : "Gateway 未能完成请求，请稍后重试";
      this.outbox.notifyText(
        message.target.conversationId,
        `操作失败：${detail}。`,
      );
      throw error;
    }
  }
}
