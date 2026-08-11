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
