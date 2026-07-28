import {
  ConversationCommandService,
  isConversationCommandName,
  type ConversationService,
} from "../../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
} from "../../conversation-core/index.js";
import { parseSlashCommand } from "../slash-command.js";
import { SurfaceInputCoalescer } from "../surface-input-coalescer.js";
import {
  formatWeixinCommandText,
  renderWeixinCommandResult,
  renderWeixinHelp,
  renderWeixinIdentity,
  renderWeixinUserFacingError,
} from "./command-renderer.js";
import {
  WeixinImageDownloadError,
  type WeixinImagePort,
} from "./image-store.js";
import type { WeixinOutbox } from "./outbox.js";
import type { WeixinImageReference } from "./protocol-client.js";

const maximumInboundImageBatchBytes = 20 * 1024 * 1024;

export type WeixinConversationMessage =
  | {
      target: ConversationTarget;
      actorId: string;
      kind: "text";
      text: string;
    }
  | {
      target: ConversationTarget;
      actorId: string;
      kind: "image";
      text?: string;
      images: readonly WeixinImageReference[];
    };

export class WeixinConversationAdapter {
  private readonly commands: ConversationCommandService;
  private readonly inputs: SurfaceInputCoalescer;
  private nextSequence = 0;

  constructor(
    private readonly conversations: ConversationService,
    private readonly outbox: Pick<WeixinOutbox, "notifyText">,
    private readonly images?: Pick<WeixinImagePort, "download">,
    inputOptions: { quietWindowMs?: number } = { quietWindowMs: 0 },
  ) {
    this.commands = new ConversationCommandService(conversations);
    this.inputs = new SurfaceInputCoalescer(
      (target, input) => conversations.submit(target, input),
      inputOptions,
    );
  }

  async handle(message: WeixinConversationMessage): Promise<void> {
    try {
      if (message.kind === "image") {
        const sequence = this.nextSequence;
        this.nextSequence += 1;
        if (this.images === undefined) {
          throw new UserFacingError(
            "image.unsupported",
            "微信图片输入尚未启用",
          );
        }
        const localImages: Array<{ path: string; bytes: number }> = [];
        let totalBytes = 0;
        for (const reference of message.images) {
          const image = await this.images.download(reference);
          totalBytes += image.bytes;
          if (totalBytes > maximumInboundImageBatchBytes) {
            throw new UserFacingError(
              "image.too-large",
              "图片总大小超过 20 MiB 限制",
              { scope: "batch" },
            );
          }
          localImages.push({ path: image.path, bytes: image.bytes });
        }
        const result = await this.inputs.enqueue({
          target: message.target,
          actorId: message.actorId,
          sequence,
          ...(message.text === undefined ? {} : { text: message.text }),
          localImages,
        });
        if (result.tail && result.submission.steered) {
          this.notify(message.target, "已将图片追加到当前 Turn。");
        }
        return;
      }
      const command = parseSlashCommand(message.text);
      if (command === null) {
        await this.conversations.submit(message.target, message.text);
        return;
      }
      if (command.name === "start" || command.name === "help") {
        this.notify(message.target, renderWeixinHelp());
        return;
      }
      if (command.name === "whoami") {
        this.notify(message.target, renderWeixinIdentity(message));
        return;
      }
      if (!isConversationCommandName(command.name)) {
        throw new UserFacingError(
          "command.unsupported",
          "微信命令不受支持",
          { command: command.name },
        );
      }
      const result = await this.commands.execute(
        message.target,
        command.name,
        command.argumentsText,
      );
      this.notify(message.target, renderWeixinCommandResult(result));
    } catch (error) {
      if (error instanceof WeixinOutputQueueError) {
        throw error;
      }
      if (error instanceof WeixinImageDownloadError) {
        this.notify(message.target, `操作失败：${error.message}。`);
        return;
      }
      if (!(error instanceof UserFacingError)) {
        throw error;
      }
      this.notify(
        message.target,
        `操作失败：${renderWeixinUserFacingError(error)}。`,
      );
    }
  }

  close(): Promise<void> {
    return this.inputs.close();
  }

  private notify(target: ConversationTarget, text: string): void {
    if (!this.outbox.notifyText(target, formatWeixinCommandText(text))) {
      throw new WeixinOutputQueueError();
    }
  }
}

class WeixinOutputQueueError extends Error {
  constructor() {
    super("微信输出队列拒绝消息");
    this.name = "WeixinOutputQueueError";
  }
}
