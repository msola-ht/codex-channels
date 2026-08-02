export type UserFacingErrorCode =
  | "message.empty"
  | "conversation.name.invalid"
  | "conversation.missing"
  | "conversation.busy"
  | "image.path.invalid"
  | "image.too-large"
  | "image.too-many"
  | "image.unsupported"
  | "vision.failed"
  | "vision.command.usage"
  | "vision.prompt.invalid"
  | "vision.prompt.capacity"
  | "vision.collection.active"
  | "vision.collection.missing"
  | "vision.collection.empty"
  | "audio.path.invalid"
  | "audio.duration-missing"
  | "audio.too-large"
  | "audio.unsupported"
  | "model.input.audio.unsupported"
  | "model.input.image.unsupported"
  | "model.input.unsupported"
  | "session.selector.required"
  | "session.selector.ambiguous"
  | "session.selector.not-found"
  | "thread.bound"
  | "thread.takeover.busy"
  | "thread.takeover.workspace"
  | "thread.takeover.changed"
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
  | "model.unavailable"
  | "model.selector.required"
  | "model.selector.ambiguous"
  | "model.selector.not-found"
  | "effort.unsupported"
  | "fast.usage"
  | "fast.unsupported"
  | "provider.account.unavailable"
  | "collaboration-mode.unsupported"
  | "collaboration-mode.unavailable"
  | "plan.prompt.empty"
  | "skill.usage"
  | "skill.not-found"
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
