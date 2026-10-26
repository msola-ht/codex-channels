import type { Logger } from "pino";
import type { ConversationTarget } from "../conversation-core/index.js";
import type { ChannelFileMediaType } from "../surfaces/index.js";
import { ChannelMediaSpool } from "./channel-media-spool.js";

export interface ChannelFileManifest {
  version: 1;
  threadId: string;
  filePath: string;
  fileName: string;
  mediaType?: ChannelFileMediaType;
  createdAtMs: number;
}

export interface ChannelFileSpoolOptions {
  directory: string;
  resolveTarget(threadId: string): ConversationTarget | undefined;
  sendFile(target: ConversationTarget, filePath: string, fileName: string, isCurrent: () => boolean, mediaType?: ChannelFileMediaType, signal?: AbortSignal): Promise<void>;
  logger: Logger;
  pollIntervalMs?: number;
}

export class ChannelFileSpool extends ChannelMediaSpool {
  constructor(options: ChannelFileSpoolOptions) {
    super({ ...options, kind: "file", send: (target, path, fileName, isCurrent, mediaType, signal) => {
      if (fileName === undefined) throw new Error("渠道文件缺少文件名");
      return options.sendFile(target, path, fileName, isCurrent, mediaType, signal);
    } });
  }
}
