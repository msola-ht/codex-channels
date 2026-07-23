import type { InteractionDecision, InteractionRequest } from "../../approval/index.js";
import type { OperationUpdate } from "../../conversation-core/index.js";

export interface HeldApprovalOperation {
  chatId: string;
  turnKey: string;
  operation: OperationUpdate;
}

export interface ApprovalOperationResolution {
  operationKey: string;
  rejected: boolean;
  pending: boolean;
  suppressed: boolean;
  held?: HeldApprovalOperation;
}

export class TelegramApprovalOperationCoordinator {
  private readonly requestIdsByOperation = new Map<string, Set<string>>();
  private readonly operationByRequestId = new Map<string, string>();
  private readonly heldByOperation = new Map<string, HeldApprovalOperation>();
  private readonly suppressedOperations = new Set<string>();

  prepare(request: InteractionRequest, held?: HeldApprovalOperation): string | undefined {
    if (request.type !== "approval") {
      return undefined;
    }
    const operationKey = keyFor(request.threadId, request.turnId, request.itemId);
    const requestIds = this.requestIdsByOperation.get(operationKey) ?? new Set<string>();
    requestIds.add(request.requestId);
    this.requestIdsByOperation.set(operationKey, requestIds);
    this.operationByRequestId.set(request.requestId, operationKey);
    if (held) {
      this.heldByOperation.set(operationKey, held);
    }
    return operationKey;
  }

  routeOperation(operationKey: string, held: HeldApprovalOperation): "show" | "hold" | "suppress" {
    if (this.suppressedOperations.has(operationKey)) {
      return "suppress";
    }
    if (this.requestIdsByOperation.has(operationKey)) {
      this.heldByOperation.set(operationKey, held);
      return "hold";
    }
    return "show";
  }

  finish(
    request: InteractionRequest,
    decision: InteractionDecision,
  ): ApprovalOperationResolution | undefined {
    if (request.type !== "approval") {
      return undefined;
    }
    const operationKey = this.operationByRequestId.get(request.requestId);
    if (!operationKey) {
      return undefined;
    }
    this.operationByRequestId.delete(request.requestId);
    const requestIds = this.requestIdsByOperation.get(operationKey);
    requestIds?.delete(request.requestId);
    const rejected = decision.type !== "approval" || !decision.approved;
    if (rejected) {
      this.suppressedOperations.add(operationKey);
      this.heldByOperation.delete(operationKey);
    }
    if (requestIds && requestIds.size > 0) {
      return {
        operationKey,
        rejected,
        pending: true,
        suppressed: this.suppressedOperations.has(operationKey),
      };
    }
    this.requestIdsByOperation.delete(operationKey);
    const suppressed = this.suppressedOperations.has(operationKey);
    const held = suppressed ? undefined : this.heldByOperation.get(operationKey);
    this.heldByOperation.delete(operationKey);
    return {
      operationKey,
      rejected,
      pending: false,
      suppressed,
      ...(held ? { held } : {}),
    };
  }

  clearTurn(turnKey: string): void {
    this.clearPrefix(`${turnKey}:`);
  }

  clearThread(threadId: string): void {
    this.clearPrefix(`${threadId}:`);
  }

  private clearPrefix(prefix: string): void {
    for (const [requestId, operationKey] of this.operationByRequestId) {
      if (operationKey.startsWith(prefix)) {
        this.operationByRequestId.delete(requestId);
      }
    }
    for (const operationKey of this.requestIdsByOperation.keys()) {
      if (operationKey.startsWith(prefix)) {
        this.requestIdsByOperation.delete(operationKey);
      }
    }
    for (const operationKey of this.heldByOperation.keys()) {
      if (operationKey.startsWith(prefix)) {
        this.heldByOperation.delete(operationKey);
      }
    }
    for (const operationKey of this.suppressedOperations) {
      if (operationKey.startsWith(prefix)) {
        this.suppressedOperations.delete(operationKey);
      }
    }
  }

  clear(): void {
    this.requestIdsByOperation.clear();
    this.operationByRequestId.clear();
    this.heldByOperation.clear();
    this.suppressedOperations.clear();
  }
}

function keyFor(threadId: string, turnId: string, itemId: string): string {
  return `${threadId}:${turnId}:${itemId}`;
}
