import {
  surfaceAccountKey,
  type ConversationTarget,
  type SurfaceId,
} from "../conversation-core/index.js";
import type {
  InteractionDecision,
  InteractionPort,
  InteractionRequest,
} from "./types.js";

export class InteractionRouter implements InteractionPort {
  private readonly ports = new Map<string, InteractionPort>();

  register(surface: SurfaceId, accountId: string, port: InteractionPort): () => void {
    const key = this.key(surface, accountId);
    if (this.ports.has(key)) {
      throw new Error(`交互端口重复注册：${key}`);
    }
    this.ports.set(key, port);
    return () => {
      if (this.ports.get(key) === port) {
        this.ports.delete(key);
      }
    };
  }

  request(
    target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    const port = this.ports.get(this.key(target.surface, target.accountId));
    return port
      ? port.request(target, request)
      : Promise.resolve(safeDecline(request));
  }

  resolved(requestId: string): void {
    for (const port of this.ports.values()) {
      port.resolved?.(requestId);
    }
  }

  cancelAll(outcome?: string): void {
    for (const port of this.ports.values()) {
      port.cancelAll?.(outcome);
    }
  }

  private key(surface: SurfaceId, accountId: string): string {
    return surfaceAccountKey(surface, accountId);
  }
}

function safeDecline(request: InteractionRequest): InteractionDecision {
  switch (request.type) {
    case "approval":
      return { type: "approval", approved: false };
    case "user-input":
      return { type: "user-input", answers: {} };
    case "elicitation":
      return { type: "elicitation", action: "cancel", content: null };
  }
}
