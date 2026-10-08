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
  | { type: "rejected"; reason: "authentication" | "capacity" | "protocol" | "provider" }
  | {
    type: "connection-error";
    stage: "upstream" | "upstream-send" | "downstream-send";
  };

export interface DesktopAppBridgeOptions {
  port: number;
  socketPath: string;
  primaryProvider: string;
  providerSocketPaths?: Readonly<Record<string, string>>;
  codexBinary: string;
  dataDir: string;
  token?: string;
  createTransport?: (provider: string) => DesktopAppBridgeTransport | Promise<DesktopAppBridgeTransport>;
  acquireLease?: (provider: string) => DesktopAppBridgeLease | Promise<DesktopAppBridgeLease>;
  onEvent?: (event: DesktopAppBridgeEvent) => void;
}

export interface DesktopAppStdioProxyOptions {
  socketPath: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  connectTimeoutMs?: number;
}

export class DesktopAppBridge {
  constructor(options: Pick<
    DesktopAppBridgeOptions,
    "port" | "token" | "createTransport" | "acquireLease" | "onEvent"
  > & {
    token: string;
    createTransport: NonNullable<DesktopAppBridgeOptions["createTransport"]>;
    acquireLease: NonNullable<DesktopAppBridgeOptions["acquireLease"]>;
    primaryProvider?: string;
    providers?: string[];
  });
  start(): Promise<void>;
  address(): { host: "127.0.0.1"; port: number; path: "/codex-app-server" } | undefined;
  close(): Promise<void>;
}

export function desktopAppBridgeTokenPath(dataDir: string): string;
export function loadOrCreateDesktopAppBridgeToken(dataDir: string): string;
export function readDesktopAppBridgeToken(dataDir: string): string;
export function proxyDesktopAppStdioToUnixSocket(
  options: DesktopAppStdioProxyOptions,
): Promise<void>;
export function startDesktopAppBridge(
  options: DesktopAppBridgeOptions,
): Promise<DesktopAppBridge>;
