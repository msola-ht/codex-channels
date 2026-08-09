export interface AppServerTopology {
  primaryProvider: string;
  managedProvider?: "deepseek";
  socketPaths: string[];
}

export interface InspectedAppServerTopology {
  version: 1;
  pid: number;
  primaryProvider: string;
  managedProvider: "deepseek" | null;
  socketPaths: string[];
}

export class AppServerSupervisorOwner {
  constructor(primarySocketPath: string, topology: AppServerTopology);
  start(): Promise<void>;
  close(): Promise<void>;
}

export function appServerSupervisorSocketPath(primarySocketPath: string): string;
export function inspectAppServerSupervisor(
  primarySocketPath: string,
): Promise<InspectedAppServerTopology | undefined>;
export function sameAppServerTopology(
  actual: InspectedAppServerTopology | undefined,
  expected: AppServerTopology,
): boolean;
export function prepareAppServerSocketPaths(socketPaths: string[]): Promise<void>;
export function appServerSocketAcceptsWebSocket(socketPath: string): Promise<boolean>;
