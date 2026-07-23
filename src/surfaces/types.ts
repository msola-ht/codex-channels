import type { InteractionPort } from "../approval/index.js";
import type { SurfaceId } from "../conversation-core/index.js";
import type { Workspace } from "../policy/index.js";

export interface SurfaceConfigurationChange {
  action: "reloaded" | "restarting" | "reinstall-required" | "reload-failed";
  changes: readonly string[];
  addedWorkspaces: readonly Workspace[];
}

export interface SurfaceAdapter {
  readonly surface: SurfaceId;
  readonly accountId: string;
  readonly interactions: InteractionPort;
  start(): Promise<void>;
  stop(): Promise<void>;
  configurationChanged?(change: SurfaceConfigurationChange): void;
  deliverConfigurationChange(change: SurfaceConfigurationChange): Promise<void>;
}
