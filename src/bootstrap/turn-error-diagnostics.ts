import {
  turnErrorCode,
  turnErrorType,
} from "../application/index.js";
import type { TurnErrorCode } from "../conversation-core/index.js";
/** Task errors are diagnostic events, never evidence of a model request. */
export function turnErrorDiagnostics(
  provider: string,
  model: string | null,
  threadId: string | null,
  turnId: string | null,
  phase: Parameters<typeof turnErrorType>[1],
  error: unknown,
  structuredErrorCode?: TurnErrorCode,
) {
  return {
    event: "turn.failed",
    provider,
    threadId,
    turnId,
    model,
    phase,
    errorType: structuredErrorCode === "misalignmentPolicyViolation"
      ? "misalignment_policy_violation"
      : turnErrorType(error, phase),
    errorCode: structuredErrorCode ?? turnErrorCode(error),
  };
}
