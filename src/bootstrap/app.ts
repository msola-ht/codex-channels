import type { Logger } from "pino";

import type { GatewayConfig } from "../config/index.js";
import {
  GatewayComponentGraph,
  effectiveCodexBinary,
} from "./gateway-component-graph.js";
import type { BuiltInSurfacePlugin } from "./surface-plugin.js";

export class GatewayConstructionCleanupError extends AggregateError {
  constructor(error: unknown, failures: unknown[]) {
    super([error, ...failures], "Gateway 构造失败且资源未完全关闭", { cause: error });
  }
}

export class GatewayApplication extends GatewayComponentGraph {
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private startupSettled = false;
  private stopRequested = false;

  static async create(
    config: GatewayConfig,
    logger: Logger,
    surfacePlugins: readonly BuiltInSurfacePlugin[],
    configPath?: string,
    onStopRequested?: () => void,
    onConstructionFailure?: () => void,
  ): Promise<GatewayApplication> {
    const acquired: { component: string; close: () => void | Promise<void> }[] = [];
    try {
      return new GatewayApplication(config, logger, surfacePlugins,
        (component, close) => acquired.push({ component, close }), configPath, onStopRequested);
    } catch (error) {
      onConstructionFailure?.();
      const failures: unknown[] = [];
      const closed: string[] = [];
      for (const resource of acquired.reverse()) {
        try { await resource.close(); closed.push(resource.component); }
        catch (cleanupError) {
          failures.push(cleanupError);
          logger.error({ err: cleanupError, component: resource.component }, "Gateway 构造失败后的组件清理失败");
        }
      }
      logger.info({ components: closed }, "Gateway 构造失败后已清理取得的组件");
      if (failures.length) {
        throw new GatewayConstructionCleanupError(error, failures);
      }
      throw error;
    }
  }

  private constructor(
    config: GatewayConfig,
    logger: Logger,
    surfacePlugins: readonly BuiltInSurfacePlugin[],
    registerConstructionCleanup: (component: string, close: () => void | Promise<void>) => void,
    configPath?: string,
    private readonly onStopRequested?: () => void,
  ) {
    super(config, logger, surfacePlugins, registerConstructionCleanup, configPath);
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
