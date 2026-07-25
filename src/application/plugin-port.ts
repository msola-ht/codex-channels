export interface InstalledPlugin {
  name: string;
  enabled: boolean;
}

export interface PluginQueryPort {
  listPlugins(cwd: string): Promise<InstalledPlugin[]>;
}
