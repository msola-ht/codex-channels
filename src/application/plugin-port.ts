export interface InstalledPlugin {
  id: string;
  name: string;
  displayName: string;
  marketplaceName: string;
  description: string | null;
  enabled: boolean;
  available: boolean;
}

export interface InvocablePlugin {
  id: string;
  name: string;
  displayName: string;
  path: string;
}

export interface PluginQueryPort {
  listPlugins(cwd: string): Promise<InstalledPlugin[]>;
  resolvePlugin(cwd: string, id: string): Promise<InvocablePlugin | undefined>;
}
