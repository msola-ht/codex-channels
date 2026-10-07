export interface AutoReviewMetadata {
  requestPurpose: "autoApprovalReview";
  threadId: string | null;
  turnId: string | null;
  reviewerThreadId: string | null;
  reviewerTurnId: string | null;
}
export function autoReviewMetadata(value: unknown): AutoReviewMetadata | undefined;
