import type { QqInboundTextMessage } from "./inbound.js";

/** Callback IDs identify interactions, never ordinary messages or passive reply anchors. */
export interface QqButtonInput {
  readonly kind: "interaction";
  readonly id: string;
  readonly actorId: string;
  readonly content: string;
  readonly buttonId: string;
  readonly sentAtMs: number;
}

export type QqMessageInput = QqInboundTextMessage | QqButtonInput;
export type QqSourceInput = Pick<QqInboundTextMessage, "id" | "actorId" | "msgIdx" | "sentAtMs">
  | Pick<QqButtonInput, "kind" | "id" | "actorId" | "sentAtMs">;
