export interface AppServerUnixSocket {
  path: string;
  identity: { dev: number; ino: number };
  available: boolean;
}

export function inspectAppServerUnixSocket(socketPath: string): AppServerUnixSocket | undefined;
