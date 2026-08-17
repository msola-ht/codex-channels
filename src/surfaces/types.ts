import type { InteractionPort } from "../approval/index.js";
import type {
  ConfigChange,
  OperationUpdateDisplay,
} from "../config/index.js";
import type { OutputEvent, SurfaceId } from "../conversation-core/index.js";
import type { Workspace } from "../policy/index.js";

export interface SurfaceConfigurationChange {
  action:
    | "reloaded"
    | "restarting"
    | "reinstall-required"
    | "reload-failed"
    | "provider-settings-scheduled"
    | "provider-settings-restarting"
    | "provider-settings-applied"
    | "provider-settings-failed";
  changes: readonly ConfigChange[];
  addedWorkspaces: readonly Workspace[];
  providers?: readonly string[];
}

export interface SurfaceOutputPort {
  handle(event: OutputEvent): Promise<void> | void;
}

export type { OperationUpdateDisplay };

export interface SurfaceAdapter {
  readonly surface: SurfaceId;
  readonly accountId: string;
  readonly interactions: InteractionPort;
  readonly output: SurfaceOutputPort;
  sendChannelImage?(conversationId: string, imagePath: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  configurationChanged?(change: SurfaceConfigurationChange): void;
  deliverConfigurationChange(change: SurfaceConfigurationChange): Promise<void>;
}
