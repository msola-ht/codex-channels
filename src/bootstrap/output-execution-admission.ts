import type { ThreadQueuePort, TurnExecutionPort } from "../application/index.js";

/** Gate only new execution/input writes; stop and inspection stay available. */
export function withOutputExecutionAdmission(
  port: TurnExecutionPort & ThreadQueuePort,
  assertAllowed: (threadId: string) => void | Promise<void>,
): TurnExecutionPort & ThreadQueuePort {
  return {
    cancelPendingInput: (id) => port.cancelPendingInput?.(id) ?? false,
    startTurn: async (...args) => { await assertAllowed(args[0]); return port.startTurn(...args); },
    steerTurn: async (...args) => { await assertAllowed(args[0]); return port.steerTurn(...args); },
    compactThread: async (...args) => { await assertAllowed(args[0]); return port.compactThread(...args); },
    startReview: async (...args) => { await assertAllowed(args[0]); return port.startReview(...args); },
    interruptTurn: (...args) => port.interruptTurn(...args),
    setThreadName: (...args) => port.setThreadName(...args),
    setThreadPinned: (...args) => port.setThreadPinned(...args),
    listQueue: (...args) => port.listQueue(...args),
  };
}
