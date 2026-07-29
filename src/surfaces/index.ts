export {
  createFeishuSurface,
  renderFeishuStartupNotification,
  type FeishuSurfaceOptions,
} from "./feishu/index.js";
export {
  createTelegramSurface,
  telegramDefaultAccountId,
  type CreateTelegramSurfaceOptions,
  type TelegramImagePort,
} from "./telegram/index.js";
export {
  createWeixinSurface,
  renderWeixinStartupNotification,
  type CreateWeixinSurfaceOptions,
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
export { formatQuotedInput } from "./quoted-input.js";
export type {
  OperationUpdateDisplay,
  SurfaceAdapter,
  SurfaceConfigurationChange,
  SurfaceOutputPort,
} from "./types.js";
