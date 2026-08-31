import type { Socket } from "node:net";

export class PrivateIpcServer {
  constructor(logicalPath: string, listener: (socket: Socket) => void);
  get listening(): boolean;
  start(occupiedMessage: string): Promise<void>;
  close(): Promise<void>;
}

export function privateIpcEndpointExists(logicalPath: string): boolean;
export function assertPrivateIpcEndpointSync(logicalPath: string): unknown;
export function createPrivateIpcConnection(logicalPath: string): Socket;
export function privateIpcAcceptsConnections(logicalPath: string): Promise<boolean>;
