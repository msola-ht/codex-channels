export interface InstalledPlugin {
  id: string;
  name: string;
  displayName: string;
  marketplaceName: string;
  description: string | null;
  enabled: boolean;
  available: boolean;
  version: string | null;
  localVersion: string | null;
  source: "local" | "git" | "npm" | "remote";
  installedAt: number | null;
  developerName: string | null;
  category: string | null;
  capabilities: string[];
  authPolicy: "onInstall" | "onUse";
  eligiblePlanTypes: string[];
  disabledReason:
    | "disabled_by_admin"
    | "plan_not_eligible"
    | "required_app_unavailable"
    | "unknown"
    | null;
}

export interface InstalledPluginCatalog {
  plugins: InstalledPlugin[];
  loadErrorCount: number;
}

export interface PluginHealthReport {
  installedCount: number;
  enabledCount: number;
  callableCount: number;
  marketplaceLoadErrorCount: number;
  issues: Array<{
    type: "notEnabled" | "unavailable";
    plugin: string;
    selector: string;
    reason: InstalledPlugin["disabledReason"];
  }>;
}

export interface InvocablePlugin {
  id: string;
  name: string;
  displayName: string;
  path: string;
}

export interface PluginQueryPort {
  listPlugins(cwd: string): Promise<InstalledPluginCatalog>;
  resolvePlugin(cwd: string, id: string): Promise<InvocablePlugin | undefined>;
}
