export {
  createFeishuSurface,
  renderFeishuStartupNotification,
  type FeishuSurfaceOptions,
} from "./feishu/index.js";
export {
  createTelegramSurface,
  telegramDefaultAccountId,
  type CreateTelegramSurfaceOptions,
  type TelegramAudioPort,
  type TelegramImagePort,
} from "./telegram/index.js";
export {
  createWeixinSurface,
  renderWeixinStartupNotification,
  type CreateWeixinSurfaceOptions,
  type WeixinAudioPort,
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
export {
  ManagedAudioStore,
  maximumManagedAudioBytes,
  type ManagedAudioSource,
  type StoredManagedAudio,
} from "./managed-audio-store.js";
export {
  surfaceErrorMetadata,
  type SurfaceErrorMetadata,
} from "./error-metadata.js";
export { formatQuotedInput } from "./quoted-input.js";
export {
  formatConversationCommandOutcome,
  formatConversationScheduledConfirmation,
  formatConversationScheduledRuns,
  formatConversationScheduledTasks,
} from "./conversation-command-format.js";
export { setConfiguredCustomPrimaryProviderId } from "./provider-format.js";
export type {
  OperationUpdateDisplay,
  SurfaceAdapter,
  SurfaceConfigurationChange,
  SurfaceOutputPort,
} from "./types.js";
