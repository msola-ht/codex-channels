/** Project only bounded request attribution from the locked Codex metadata. */
export function autoReviewMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.thread_source !== "guardian_review") return undefined;
  const parentThreadId = boundedIdentity(value.parent_thread_id);
  const parentTurnId = boundedIdentity(value.parent_turn_id);
  const associated = parentThreadId !== null && parentTurnId !== null;
  return {
    requestPurpose: "autoApprovalReview",
    threadId: associated ? parentThreadId : null,
    turnId: associated ? parentTurnId : null,
    reviewerThreadId: boundedIdentity(value.thread_id),
    reviewerTurnId: boundedIdentity(value.turn_id),
  };
}

function boundedIdentity(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128
    ? value : null;
}
