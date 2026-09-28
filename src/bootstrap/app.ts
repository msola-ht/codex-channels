import type { Logger } from "pino";

import type {
  ConfigReloadResult,
  GatewayConfig,
} from "../config/index.js";
import {
  classifyConfigReload,
  includesConfigChange,
} from "../config/index.js";
import {
  GatewayComponentGraph,
  currentGitBranch,
  effectiveCodexBinary,
  immediateAddedWorkspaceNotifications,
} from "./gateway-component-graph.js";

export class GatewayApplication extends GatewayComponentGraph {
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private startupSettled = false;

  constructor(config: GatewayConfig, logger: Logger, configPath?: string) {
    super(config, logger, configPath);
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

  reloadConfig(
    next: GatewayConfig,
    pendingAddedWorkspaces: readonly GatewayConfig["workspaces"][number][] = [],
    weixinCredentialsChanged = false,
  ): ConfigReloadResult {
    const result = classifyConfigReload(this.config, next, weixinCredentialsChanged);
    if (result.action === "reinstall") {
      this.surfaceManager.configurationChanged({
        action: "reinstall-required",
        changes: result.changes,
        addedWorkspaces: [],
      });
      return result;
    }
    if (result.action === "restart") {
      const restoreRecipients: Array<() => void> = [];
      try {
        for (const module of this.surfaceModules) {
          restoreRecipients.push(module.prepareRestartNotification(next));
        }
        this.surfaceManager.configurationChanged({
          action: "restarting",
          changes: result.changes,
          addedWorkspaces: [],
        });
      } finally {
        for (const restore of restoreRecipients.reverse()) restore();
      }
      return result;
    }

    const addedWorkspaces = immediateAddedWorkspaceNotifications(
      this.config.workspaces,
      next.workspaces,
      result.changes,
      pendingAddedWorkspaces,
    );
    if (includesConfigChange(result.changes, "workspace.registry")) {
      this.workspaces.replace(next.workspaces, next.defaultWorkspaceId);
    }
    for (const module of this.surfaceModules) {
      module.applyHotReload(next, result.changes);
    }
    this.config = next;
    const nonWorkspaceChanges = result.changes.filter(
      (change) => change.code !== "workspace.registry",
    );
    if (nonWorkspaceChanges.length > 0 || addedWorkspaces.length > 0) {
      this.surfaceManager.configurationChanged({
        action: "reloaded",
        changes: result.changes,
        addedWorkspaces,
      });
    }
    return result;
  }
}

export { currentGitBranch, effectiveCodexBinary };
