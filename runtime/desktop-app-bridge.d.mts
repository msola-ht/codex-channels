export interface DesktopAppBridgeTransport {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(message: string): Promise<void>;
  onMessage(handler: (message: string) => void): () => void;
  onClose(handler: (error?: Error) => void): () => void;
}

export interface DesktopAppBridgeLease {
  close(): Promise<void>;
}

export type DesktopAppBridgeEvent =
  | { type: "started"; port: number }
  | { type: "stopped" }
  | { type: "connected" | "disconnected"; connections: number }
  | { type: "rejected"; reason: "authentication" | "capacity" | "protocol" }
  | {
    type: "connection-error";
    stage: "upstream" | "upstream-send" | "downstream-send";
  };

export interface DesktopAppBridgeOptions {
  port: number;
  socketPath: string;
  primaryProvider: string;
  codexBinary: string;
  dataDir: string;
  token?: string;
  createTransport?: () => DesktopAppBridgeTransport | Promise<DesktopAppBridgeTransport>;
  acquireLease?: () => DesktopAppBridgeLease | Promise<DesktopAppBridgeLease>;
  onEvent?: (event: DesktopAppBridgeEvent) => void;
}

export class DesktopAppBridge {
  constructor(options: Pick<
    DesktopAppBridgeOptions,
    "port" | "token" | "createTransport" | "acquireLease" | "onEvent"
  > & {
    token: string;
    createTransport: NonNullable<DesktopAppBridgeOptions["createTransport"]>;
    acquireLease: NonNullable<DesktopAppBridgeOptions["acquireLease"]>;
  });
  start(): Promise<void>;
  address(): { host: "127.0.0.1"; port: number; path: "/codex-app-server" } | undefined;
  close(): Promise<void>;
}

export function desktopAppBridgeTokenPath(dataDir: string): string;
export function loadOrCreateDesktopAppBridgeToken(dataDir: string): string;
export function readDesktopAppBridgeToken(dataDir: string): string;
export function startDesktopAppBridge(
  options: DesktopAppBridgeOptions,
): Promise<DesktopAppBridge>;
