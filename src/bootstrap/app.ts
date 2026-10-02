import type { Logger } from "pino";

import type { GatewayConfig } from "../config/index.js";
import {
  GatewayComponentGraph,
  currentGitBranch,
  effectiveCodexBinary,
} from "./gateway-component-graph.js";
import type { BuiltInSurfacePlugin } from "./surface-plugin.js";

export class GatewayApplication extends GatewayComponentGraph {
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private startupSettled = false;

  constructor(
    config: GatewayConfig,
    logger: Logger,
    surfacePlugins: readonly BuiltInSurfacePlugin[],
    configPath?: string,
  ) {
    super(config, logger, surfacePlugins, configPath);
  }

  start(): Promise<void> {
    this.startTask ??= this.startInternal().finally(() => {
      this.startupSettled = true;
    });
    return this.startTask;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopTask = this.stopInternal(this.startTask, this.startupSettled);
    return this.stopTask;
  }

  protected override requestStop(): Promise<void> {
    return this.stop();
  }
}

export { currentGitBranch, effectiveCodexBinary };
