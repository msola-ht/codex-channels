import type { InteractionPort } from "../approval/index.js";
import type { ScheduledTaskConfirmation } from "../application/index.js";
import type {
  ConfigChange,
  OperationUpdateDisplay,
} from "../config/index.js";
import type {
  ConversationTarget,
  OutputEvent,
  SurfaceId,
} from "../conversation-core/index.js";
import type { Workspace } from "../policy/index.js";
import type { DeliveryCheckpoint } from "./delivery-receipt.js";

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

export interface SurfaceOutputPort {
  /** Fix disposable live admission identities before routing waits; never change presentation lifecycle. */
  admitLive?(event: OutputEvent): void;
  /** Apply live local lifecycle state synchronously; never await platform delivery. Not called on replay. */
  observe?(event: OutputEvent): void;
  retains?(event: OutputEvent): boolean;
  /** Successful live admission also applies to enriched copies; handle still owns ordinary lifecycle observation. */
  handle(event: OutputEvent, context?: { liveAdmitted: true }): Promise<void> | void;
  /** Settle actual transient operations (including intentional no-op); validate ownership before sending. */
  deliverSnapshot?(event: OutputEvent, signal: AbortSignal, authorized: () => boolean): Promise<void>;
  deliver?(event: OutputEvent, signal: AbortSignal, checkpoint: (value: DeliveryCheckpoint) => Promise<void>, authorized?: () => boolean): Promise<void>;
}

export type { OperationUpdateDisplay };

export interface SurfaceAdapter {
  readonly surface: SurfaceId;
  readonly accountId: string;
  readonly interactions: InteractionPort;
  readonly output: SurfaceOutputPort;
  sendChannelImage?(conversationId: string, imagePath: string): Promise<void>;
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
