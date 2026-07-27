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
  WeixinSurface,
  type WeixinProtocolClient,
} from "./weixin/index.js";
export {
  ConversationDeliveryQueue,
  type ConversationDeliveryQueueOptions,
} from "./conversation-delivery-queue.js";
export type {
  OperationUpdateDisplay,
  SurfaceAdapter,
  SurfaceConfigurationChange,
  SurfaceOutputPort,
} from "./types.js";
