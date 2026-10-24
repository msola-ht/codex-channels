export {
  QqProtocolClient, QqProtocolError, QqTextSendError, QQ_TEXT_PART_BYTES,
  type QqProtocolClientOptions, type QqTextMessage, type QqTextSendContext,
  type QqTextOutcome, type QqTextRejection,
} from "./protocol.js";
export { QqWebSocketTransport, QqTransportError } from "./transport.js";
export {
  parseQqTextEvent,
  type QqInboundTextMessage, type QqTextEventResult,
  type QqInboundFailureCategory, type QqInboundFailureField, type QqInboundFailureReason,
} from "./inbound.js";
export type { QqNetwork } from "./network.js";
export { QqTextOutbox } from "./outbox.js";
export {
  QqTaskSources,
  type QqTaskScope, type QqTaskSourceReference, type QqTaskTicket, type QqTaskReservation,
} from "./task-sources.js";
export { QqSurface, type CreateQqSurfaceOptions } from "./surface.js";
export { renderQqStartupNotification } from "./lifecycle.js";
