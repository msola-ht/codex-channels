import type { Logger } from "pino";

import type {
  SurfaceAdapter,
  SurfaceConfigurationChange,
} from "../surfaces/index.js";

export class SurfaceManager {
  private readonly started: SurfaceAdapter[] = [];

  constructor(
    private readonly surfaces: readonly SurfaceAdapter[],
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    try {
      for (const surface of this.surfaces) {
        this.started.push(surface);
        await surface.start();
      }
    } catch (error) {
      await this.stop().catch((cleanupError) => {
        this.logger.error({ err: cleanupError }, "Surface 启动失败后的回滚不完整");
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    const failures: Array<{ surface: SurfaceAdapter; error: unknown }> = [];
    for (const surface of this.started.splice(0).reverse()) {
      try {
        await surface.stop();
      } catch (error) {
        failures.push({ surface, error });
        this.logger.error(
          {
            err: error,
            surface: surface.surface,
            accountId: surface.accountId,
          },
          "Surface 停止失败",
        );
      }
    }
    if (failures.length > 0) {
      this.started.push(...failures.map(({ surface }) => surface).reverse());
      throw new AggregateError(
        failures.map(({ error }) => error),
        "部分 Surface 未能停止",
      );
    }
  }

  configurationChanged(change: SurfaceConfigurationChange): void {
    for (const surface of this.started) {
      try {
        surface.configurationChanged?.(change);
      } catch (error) {
        this.logger.warn(
          {
            errorType: error instanceof Error ? error.name : typeof error,
            surface: surface.surface,
            accountId: surface.accountId,
          },
          "Surface 配置变更通知失败",
        );
      }
    }
  }
}
