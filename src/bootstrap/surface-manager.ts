import type { Logger } from "pino";

import {
  surfaceAccountKey,
  type OutputEvent,
} from "../conversation-core/index.js";
import type { EventBus } from "../event-bus/index.js";
import type {
  SurfaceAdapter,
  SurfaceConfigurationChange,
} from "../surfaces/index.js";

export class SurfaceManager {
  private readonly started: SurfaceAdapter[] = [];
  private readonly surfacesByAccount = new Map<string, SurfaceAdapter>();
  private removeOutputSubscription: (() => void) | undefined;
  private acceptingOutput = true;

  constructor(
    private readonly surfaces: readonly SurfaceAdapter[],
    output: EventBus<OutputEvent>,
    private readonly logger: Logger,
  ) {
    for (const surface of surfaces) {
      const key = surfaceAccountKey(surface.surface, surface.accountId);
      if (this.surfacesByAccount.has(key)) {
        throw new Error(`Surface 重复注册：${key}`);
      }
      this.surfacesByAccount.set(key, surface);
    }
    this.removeOutputSubscription = output.subscribe(
      "surface-output-router",
      (event) => this.routeOutput(event),
    );
  }

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
    this.acceptingOutput = false;
    this.removeOutputSubscription?.();
    this.removeOutputSubscription = undefined;
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
      const scopedChange = configurationChangeForSurface(surface, change);
      if (!scopedChange) {
        continue;
      }
      try {
        surface.configurationChanged?.(scopedChange);
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

  async deliverConfigurationChange(change: SurfaceConfigurationChange): Promise<void> {
    if (this.started.length !== this.surfaces.length) {
      throw new Error("Surface 尚未全部启动，不能确认持久化配置事件");
    }
    const surfaces = [...this.started];
    const results = await Promise.allSettled(
      surfaces.map(async (surface) => {
        const scopedChange = configurationChangeForSurface(surface, change);
        if (scopedChange) {
          await surface.deliverConfigurationChange(scopedChange);
        }
        return surface;
      }),
    );
    const failures = results.flatMap((result, index) => {
      if (result.status === "fulfilled") {
        return [];
      }
      const surface = surfaces[index]!;
      this.logger.warn(
        {
          errorType: result.reason instanceof Error ? result.reason.name : typeof result.reason,
          surface: surface.surface,
          accountId: surface.accountId,
        },
        "Surface 持久化配置事件投递失败",
      );
      return [result.reason as unknown];
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, "部分 Surface 未收到配置事件");
    }
  }

  private routeOutput(event: OutputEvent): void {
    if (!this.acceptingOutput) {
      return;
    }
    const surface = this.surfacesByAccount.get(
      surfaceAccountKey(event.target.surface, event.target.accountId),
    );
    if (!surface) {
      this.logger.debug(
        {
          surface: event.target.surface,
          accountId: event.target.accountId,
          eventType: event.type,
        },
        "输出事件没有已启用的 Surface",
      );
      return;
    }
    try {
      surface.output.handle(event);
    } catch (error) {
      this.logger.warn(
        {
          errorType: error instanceof Error ? error.name : typeof error,
          surface: surface.surface,
          accountId: surface.accountId,
          eventType: event.type,
        },
        "Surface 拒绝输出事件",
      );
    }
  }
}

function configurationChangeForSurface(
  surface: SurfaceAdapter,
  change: SurfaceConfigurationChange,
): SurfaceConfigurationChange | undefined {
  const changes = change.changes.filter(
    (item) => item.scope === "global" || item.scope === surface.surface,
  );
  if (
    changes.length === 0
    && change.addedWorkspaces.length === 0
    && change.action === "reloaded"
  ) {
    return undefined;
  }
  return {
    ...change,
    changes,
  };
}
