import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deliverySchemaVersion, type DeliverySubmission } from "./types.js";

/** Authentication binds a payload to its persisted schema and delivery identity. */
export function deliveryPayloadAad(value: Pick<DeliverySubmission, "id" | "account" | "conversation">): string {
  return JSON.stringify([deliverySchemaVersion, value.id, value.account, value.conversation]);
}

export function encryptDeliveryPayload(key: Buffer, text: string, aad: string): { payload: Buffer; nonce: Buffer; tag: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return { payload: Buffer.concat([cipher.update(text, "utf8"), cipher.final()]), nonce, tag: cipher.getAuthTag() };
}

export function decryptDeliveryPayload(key: Buffer, payload: Uint8Array, nonce: Uint8Array, tag: Uint8Array, aad: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
}
