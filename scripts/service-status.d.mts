export interface ManagedServiceStatusEntry {
  target: "gateway" | "app-server" | "webui" | "center";
  name: string;
  identifier: string;
  loaded: boolean;
  running: boolean;
  state: string;
  pid: number | null;
}

export interface ManagedServiceStatus {
  platform: "systemd" | "launchd";
  target: "gateway" | "app-server" | "webui" | "center" | "all";
  healthy: boolean;
  services: ManagedServiceStatusEntry[];
}

export interface ServiceStatusRunResult {
  error?: Error;
  status: number | null;
  stdout?: string;
  stderr?: string;
}

export type ServiceStatusRunner = (
  command: string,
  args: readonly string[],
  options: { encoding: "utf8"; env: NodeJS.ProcessEnv },
) => ServiceStatusRunResult;

export function inspectManagedServiceStatus(options?: {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: ServiceStatusRunner;
  target?: ManagedServiceStatus["target"];
  userId?: number;
}): ManagedServiceStatus;
