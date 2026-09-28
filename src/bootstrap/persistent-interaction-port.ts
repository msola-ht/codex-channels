import { safeInteractionDecision, type InteractionDecision, type InteractionPort, type InteractionRequest } from "../approval/index.js";
import type { ConversationTarget } from "../conversation-core/index.js";

/** Keep ephemeral approvals behind earlier durable results without persisting approval content. */
export class PersistentInteractionPort implements InteractionPort {
  private readonly waiting = new Map<string, AbortController>();
  constructor(private readonly port: InteractionPort,
    private readonly wait: (target: ConversationTarget, signal: AbortSignal) => Promise<void>) {}

  async request(target: ConversationTarget, request: InteractionRequest): Promise<InteractionDecision> {
    if (this.waiting.size >= 100 || this.waiting.has(request.requestId)) return safeInteractionDecision(request);
    const controller = new AbortController();
    this.waiting.set(request.requestId, controller);
    const deadline = performance.now() + request.expiresInMs;
    const timer = setTimeout(() => {
      if (this.waiting.get(request.requestId) === controller) this.resolved(request.requestId);
    }, request.expiresInMs);
    let cancel!: () => void;
    const cancelled = new Promise<InteractionDecision>((resolve) => {
      cancel = () => resolve(safeInteractionDecision(request));
      controller.signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      await Promise.race([this.wait(target, controller.signal), cancelled]);
      const remaining = Math.ceil(deadline - performance.now());
      if (controller.signal.aborted || remaining <= 0) return safeInteractionDecision(request);
      const decision = await Promise.race([this.port.request(target, { ...request, expiresInMs: remaining }), cancelled]);
      return controller.signal.aborted || performance.now() >= deadline ? safeInteractionDecision(request) : decision;
    } catch {
      return safeInteractionDecision(request);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
      if (this.waiting.get(request.requestId) === controller) this.waiting.delete(request.requestId);
    }
  }

  resolved(id: string): void {
    const controller = this.waiting.get(id);
    this.waiting.delete(id);
    controller?.abort();
    this.port.resolved?.(id);
  }

  cancelAll(outcome?: string): void {
    for (const controller of this.waiting.values()) controller.abort();
    this.waiting.clear();
    this.port.cancelAll?.(outcome);
  }
}
