export {
  createFeishuSurface,
  renderFeishuStartupNotification,
  type FeishuSurfaceOptions,
} from "./feishu/index.js";
export {
  TelegramSurface,
  telegramDefaultAccountId,
  type TelegramImagePort,
} from "./telegram/index.js";
export {
  createCredentialBackedWeixinClient,
  createWeixinCredentialStore,
  createWeixinReplyContextPersistence,
  FileWeixinUpdatesCursorStore,
  renderWeixinStartupNotification,
  WeixinImageStore,
  WeixinSurface,
  type WeixinProtocolClient,
} from "./weixin/index.js";
export {
  ConversationDeliveryQueue,
  type ConversationDeliveryQueueOptions,
} from "./conversation-delivery-queue.js";
export {
  SurfaceInputCoalescer,
  type SurfaceInputBatchResult,
  type SurfaceInputCoalescerOptions,
  type SurfaceInputPart,
} from "./surface-input-coalescer.js";
export type {
  OperationUpdateDisplay,
  SurfaceAdapter,
  SurfaceConfigurationChange,
  SurfaceOutputPort,
} from "./types.js";
