import type { Logger } from "pino";

import type { GatewayConfig } from "../config/index.js";
import {
  GatewayComponentGraph,
  effectiveCodexBinary,
} from "./gateway-component-graph.js";
import type { BuiltInSurfacePlugin } from "./surface-plugin.js";

export class GatewayApplication extends GatewayComponentGraph {
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private startupSettled = false;
  private stopRequested = false;

  constructor(
    config: GatewayConfig,
    logger: Logger,
    surfacePlugins: readonly BuiltInSurfacePlugin[],
    configPath?: string,
    private readonly onStopRequested?: () => void,
  ) {
    super(config, logger, surfacePlugins, configPath);
  }

  start(): Promise<void> {
    this.startTask ??= Promise.resolve().then(() => this.startInternal()).finally(() => {
      this.startupSettled = true;
    });
    return this.startTask;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const task = new Promise<void>((resolveTask, rejectTask) => {
      resolve = resolveTask;
      reject = rejectTask;
    });
    this.stopTask = task;
    void this.stopInternal(this.startTask, this.startupSettled).then(resolve, reject);
    return task;
  }

  protected override requestStop(): Promise<void> {
    if (this.stopRequested) return this.stop();
    this.stopRequested = true;
    this.onStopRequested?.();
    return this.stop();
  }
}

export { effectiveCodexBinary };
