import type { InteractionPort } from "../approval/index.js";
import type { SurfaceId } from "../conversation-core/index.js";

export interface SurfaceAdapter {
  readonly surface: SurfaceId;
  readonly accountId: string;
  readonly interactions: InteractionPort;
  start(): Promise<void>;
  stop(): Promise<void>;
}
