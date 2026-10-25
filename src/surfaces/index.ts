// Channel implementations are loaded only after validated configuration enables them.
export function loadFeishuSurface() {
  return import("./feishu/index.js");
}
export function loadTelegramSurface() {
  return import("./telegram/index.js");
}
export function loadWeixinSurface() {
  return import("./weixin/index.js");
}
export function loadQqSurface() {
  return import("./qq/index.js");
}
export { telegramDefaultAccountId } from "./telegram/constants.js";
export { createWeixinCredentialStore } from "./weixin/credential-store.js";
export { createWeixinCredentialChangeCheck } from "./weixin/credential-client.js";
export type { FeishuSurfaceOptions } from "./feishu/index.js";
export type {
  CreateTelegramSurfaceOptions, TelegramAudioPort, TelegramImagePort,
} from "./telegram/index.js";
export type { CreateWeixinSurfaceOptions, WeixinAudioPort } from "./weixin/index.js";
export {
  ConversationDeliveryQueue,
  type ConversationDeliveryQueueOptions,
  type ConversationDeliveryOptions,
} from "./conversation-delivery-queue.js";
export {
  isSheddableBacklogEvent,
  resolveSurfaceDelivery,
  surfaceDeliveryCoalesceKey,
  SurfaceOutputCoalescer,
  surfaceOutputSnapshotKey,
  supersedesSurfaceSnapshot,
} from "./delivery-policy.js";
export {
  SurfaceInputBatcher,
  type SurfaceInputSubmissionResult,
  type SurfaceInputBatcherOptions,
  type SurfaceInputPart,
} from "./surface-input-batcher.js";
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
export { formatConversationIdleReleased } from "./output-copy.js";
export { formatProviderIdleReleaseNotice } from "./output-copy.js";
export {
  formatConversationCommandOutcome,
} from "./conversation-command-outcome-format.js";
export {
  formatConversationScheduledConfirmation,
  formatConversationScheduledRuns,
  formatConversationScheduledTasks,
} from "./conversation-scheduled-task-command-format.js";
export { canReviewConversationHook } from "./conversation-hook-command-format.js";
export { canPreserveWeixinHookReviewText } from "./weixin/markdown-sanitize.js";
export { canPreserveQqHookReviewText } from "./qq/hook-review.js";
export type {
  OperationUpdateDisplay,
  SurfaceAdapter,
  SurfaceAsyncAnswerSubmission,
  SurfaceConfigurationChange,
  SurfaceOutputPort,
  SurfaceDeliverySource,
} from "./types.js";
export { mayReleaseUncertainOutputBarrier, isPersistentOutput, snapshotPersistentOutput, decodePersistentOutput, withPersistentOutputImage } from "./persistent-output.js";
export type { DeliveryCheckpoint } from "./delivery-receipt.js";
export { withPersistentDeliveryDiagnostics } from "./diagnostics.js";
export { readGeneratedImage, GeneratedImageError } from "./generated-image.js";
export type { QqNetwork } from "./qq/index.js";
export { readBoundedLocalFile, assertChannelFileName, maximumChannelFileBytes, LocalFileError } from "./bounded-local-file.js";
