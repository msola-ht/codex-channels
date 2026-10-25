import type { InteractionPort } from "../approval/index.js";
import type { ScheduledTaskConfirmation, SubmissionObserver } from "../application/index.js";
import type {
  ConfigChange,
  OperationUpdateDisplay,
  MessageDisplaySettings,
} from "../config/index.js";
import type {
  ConversationTarget,
  OutputEvent,
  SurfaceId,
  UserMessageIdentity,
} from "../conversation-core/index.js";
import type { Workspace } from "../policy/index.js";
import type { DeliveryCheckpoint } from "./delivery-receipt.js";
import type { ChannelFileMediaType } from "./bounded-local-file.js";

export interface SurfaceConfigurationChange {
  action:
    | "reloaded"
    | "restarting"
    | "reinstall-required"
    | "reload-failed"
    | "provider-settings-scheduled"
    | "provider-settings-restarting"
    | "provider-settings-applied"
    | "provider-settings-restart-required"
    | "provider-settings-failed";
  changes: readonly ConfigChange[];
  addedWorkspaces: readonly (Workspace & { readonly listNumber: number })[];
  providers?: readonly string[];
}

/** Disposable input participation identity; a stored reference alone grants no authority. */
interface SurfaceTaskDeliveryIdentity {
  readonly generation: string;
  readonly sourceToken: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly threadId: string;
  readonly turnId: string;
}

export type SurfaceTaskDeliverySource = SurfaceTaskDeliveryIdentity & (
  | { readonly kind?: never; readonly workspaceId?: never; readonly workspaceCwd?: never }
  | { readonly kind: "scheduled"; readonly workspaceId: string; readonly workspaceCwd: string }
);

/** Disposable authority for a live lifecycle notice; it never grants Turn output. */
interface SurfaceNotificationDeliveryIdentity {
  readonly kind: "notification";
  readonly generation: string;
  readonly sourceToken: string;
  readonly accountId: string;
  readonly conversationId: string;
}

export type SurfaceNotificationDeliverySource = SurfaceNotificationDeliveryIdentity & (
  | { readonly eventType: "mcp.oauth.completed"; readonly threadId: string; readonly serverName: string }
  | { readonly eventType: "conversation.idle.released" | "warning" | "hook.completed" | "autoApprovalReview.updated"
      | "operation.updated" | "connection.lost" | "connection.restored" | "thread.availability" | "thread.name"
      | "account.updated" | "account.rateLimits.updated" | "mcp.status.updated";
      readonly threadId: string | null; readonly serverName?: never }
);

export type SurfaceDeliverySource = SurfaceTaskDeliverySource | SurfaceNotificationDeliverySource;

/** One-time answer submission participation; retain confirmed sources until their normal release. */
export interface SurfaceAsyncAnswerSubmission {
  readonly observer: SubmissionObserver;
  isCurrent(): boolean;
  cancel(): void;
  failed?(): Promise<void>;
}

/** A fresh unattended submission in its fixed Workspace; contains no task content. */
export interface SurfaceScheduledTaskSubmissionContext {
  readonly runId: string;
  readonly target: ConversationTarget;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly workspaceCwd: string;
  readonly threadId: string;
}

export interface SurfaceOutputPort {
  /** Observe current official identity synchronously; no network, content, persistence or replay. */
  observeUserMessageIdentity?(identity: Readonly<UserMessageIdentity>): void;
  /** Invalidate unused selections only; this does not prove deletion or revoke task output. */
  observeQueueChanged?(target: ConversationTarget, threadId: string): void;
  deliverySource?: {
    capture(event: OutputEvent): SurfaceDeliverySource | undefined;
    await(reference: SurfaceDeliverySource, signal: AbortSignal): Promise<boolean>;
    current(reference: SurfaceDeliverySource): boolean;
    /** Idempotently discard disposable source identity; never release retained task sources. */
    release?(reference: SurfaceDeliverySource): void;
  };
  /** Fix disposable live admission identities before routing waits; never change presentation lifecycle. */
  admitLive?(event: OutputEvent): void;
  /** Apply live local lifecycle state synchronously; never await platform delivery. Not called on replay. */
  observe?(event: OutputEvent): void;
  retains?(event: OutputEvent): boolean;
  /** Pure live snapshot visibility; does not replace source authorization or terminal settlement. */
  acceptsSnapshot?(event: OutputEvent): boolean;
  /** Freeze the live presentation choice at admission; replay always defaults to detailed. */
  liveCompletionDisplay?(event: Extract<OutputEvent, { type: "turn.completed" }>): "off" | "brief" | "detailed";
  shouldSettleLiveCompletion?(event: Extract<OutputEvent, { type: "turn.completed" }>): boolean;
  /** Finish the original Turn's live resources without creating a durable delivery or ACK. */
  settleLiveCompletion?(event: Extract<OutputEvent, { type: "turn.completed" }>, signal: AbortSignal, authorized: () => boolean, source?: SurfaceDeliverySource): Promise<void>;
  /** Local, exact-Turn cleanup only; never sends or grants delivery authority. */
  discardLiveCompletion?(event: Extract<OutputEvent, { type: "turn.completed" }>): void;
  /** Successful live admission also applies to enriched copies; handle still owns ordinary lifecycle observation. */
  handle(event: OutputEvent, context?: { liveAdmitted: true; completion?: "brief" | "detailed" }, signal?: AbortSignal): Promise<void> | void;
  /** Settle actual transient operations (including intentional no-op); validate ownership before sending. */
  deliverSnapshot?(event: OutputEvent, signal: AbortSignal, authorized: () => boolean): Promise<void>;
  /** Source is the original durable owner identity, never recaptured from an enriched event. */
  deliver?(event: OutputEvent, signal: AbortSignal, checkpoint: (value: DeliveryCheckpoint) => Promise<void>, authorized?: () => boolean, source?: SurfaceDeliverySource, context?: { completion: "brief" | "detailed" }): Promise<void>;
}

export type { OperationUpdateDisplay };

/** Resolve presentation only; the original business target and authorization remain unchanged. */
export type SurfaceMessageDisplaySettings = (target: ConversationTarget) => MessageDisplaySettings;

export interface SurfaceAdapter {
  readonly surface: SurfaceId;
  readonly accountId: string;
  /** Connection lifecycle only: no conversation recovery, output or notification recipients. */
  readonly connectionOnly?: true;
  readonly capabilities?: {
    readonly recoverBindings?: boolean;
    readonly interactions?: boolean;
    readonly scheduledTasks?: boolean;
    readonly configurationNotifications?: boolean;
  };
  readonly interactions: InteractionPort;
  readonly output: SurfaceOutputPort;
  takeAsyncAnswerSubmission?(target: ConversationTarget, requestId: string): SurfaceAsyncAnswerSubmission | undefined;
  prepareScheduledTaskSubmission?(context: SurfaceScheduledTaskSubmissionContext): SurfaceAsyncAnswerSubmission;
  sendChannelImage?(conversationId: string, imagePath: string, isCurrent: () => boolean, signal?: AbortSignal, format?: "markdown"): Promise<void>;
  sendChannelFile?(conversationId: string, filePath: string, fileName: string, isCurrent: () => boolean, mediaType?: ChannelFileMediaType, signal?: AbortSignal): Promise<void>;
  presentScheduledTaskConfirmation?(
    target: ConversationTarget,
    actorId: string,
    preview: ScheduledTaskConfirmation,
  ): Promise<void> | void;
  start(): Promise<void>;
  stop(): Promise<void>;
  configurationChanged?(change: SurfaceConfigurationChange): void;
  deliverConfigurationChange(change: SurfaceConfigurationChange): Promise<void>;
}
