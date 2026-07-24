export type UserFacingErrorCode =
  | "message.empty"
  | "conversation.name.invalid"
  | "conversation.missing"
  | "conversation.busy"
  | "image.path.invalid"
  | "image.too-large"
  | "image.unsupported"
  | "session.selector.required"
  | "session.selector.ambiguous"
  | "session.selector.not-found"
  | "thread.bound"
  | "goal.empty"
  | "goal.usage"
  | "queue.usage"
  | "queue.inactive"
  | "queue.full"
  | "queue.thread-changed"
  | "workspace.missing"
  | "workspace.selector.required"
  | "workspace.selector.ambiguous"
  | "workspace.selector.not-found"
  | "model.current.missing"
  | "model.selector.required"
  | "model.selector.ambiguous"
  | "model.selector.not-found"
  | "effort.unsupported"
  | "fast.usage"
  | "fast.unsupported"
  | "command.unsupported"
  | "review.usage"
  | "rules.usage"
  | "rules.exists"
  | "rules.missing"
  | "rules.unsafe-path"
  | "rules.check-failed"
  | "rules.unavailable";

export type UserFacingErrorDetails = Readonly<
  Record<string, string | readonly string[]>
>;

export class UserFacingError extends Error {
  constructor(
    readonly code: UserFacingErrorCode,
    message: string,
    readonly details: UserFacingErrorDetails = {},
  ) {
    super(message);
    this.name = "UserFacingError";
  }
}
