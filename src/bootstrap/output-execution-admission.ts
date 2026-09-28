import type { ThreadQueuePort, TurnExecutionPort } from "../application/index.js";

/** Gate only new execution/input writes; stop, inspection and Queue deletion stay available. */
export function withOutputExecutionAdmission(
  port: TurnExecutionPort & ThreadQueuePort,
  assertAllowed: (threadId: string) => void,
): TurnExecutionPort & ThreadQueuePort {
  return {
    cancelPendingInput: (id) => port.cancelPendingInput?.(id) ?? false,
    startTurn: async (...args) => { assertAllowed(args[0]); return port.startTurn(...args); },
    steerTurn: async (...args) => { assertAllowed(args[0]); return port.steerTurn(...args); },
    compactThread: async (id) => { assertAllowed(id); return port.compactThread(id); },
    startReview: async (...args) => { assertAllowed(args[0]); return port.startReview(...args); },
    setGoal: async (...args) => { assertAllowed(args[0]); return port.setGoal(...args); },
    interruptTurn: (...args) => port.interruptTurn(...args),
    setThreadName: (...args) => port.setThreadName(...args),
    setThreadPinned: (...args) => port.setThreadPinned(...args),
    getGoal: (id) => port.getGoal(id),
    clearGoal: (id) => port.clearGoal(id),
    addQueueItem: async (...args) => { assertAllowed(args[0]); return port.addQueueItem(...args); },
    updateQueueItem: async (...args) => { assertAllowed(args[0]); return port.updateQueueItem(...args); },
    startQueueItem: async (...args) => { assertAllowed(args[0]); return port.startQueueItem(...args); },
    listQueue: (...args) => port.listQueue(...args),
    deleteQueueItem: (...args) => port.deleteQueueItem(...args),
    reorderQueue: (...args) => port.reorderQueue(...args),
  };
}
