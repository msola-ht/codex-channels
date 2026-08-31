import { UnixWebSocketTransport } from "./unix-websocket-transport.js";
import { WindowsProxyTransport } from "./windows-proxy-transport.js";
import type { CodexTransport } from "./transport.js";
import type {
  CreateCodexProcessInvocation,
  TerminateCodexProcess,
} from "./codex-process.js";

export interface LocalAppServerEndpoint {
  readonly kind: "local-app-server";
  readonly socketPath: string;
}

export interface AppServerTransportOptions {
  codexBinary: string;
  createCodexProcessInvocation?: CreateCodexProcessInvocation;
  terminateCodexProcess?: TerminateCodexProcess;
  connectTimeoutMs?: number;
  maxPayloadBytes?: number;
  platform?: NodeJS.Platform;
}

export function createAppServerTransport(
  endpoint: LocalAppServerEndpoint,
  options: AppServerTransportOptions,
): CodexTransport {
  if ((options.platform ?? process.platform) === "win32") {
    return new WindowsProxyTransport(endpoint.socketPath, {
      codexBinary: options.codexBinary,
      ...(options.createCodexProcessInvocation === undefined
        ? {}
        : { createCodexProcessInvocation: options.createCodexProcessInvocation }),
      ...(options.terminateCodexProcess === undefined
        ? {}
        : { terminateCodexProcess: options.terminateCodexProcess }),
      ...(options.connectTimeoutMs === undefined
        ? {}
        : { connectTimeoutMs: options.connectTimeoutMs }),
      ...(options.maxPayloadBytes === undefined
        ? {}
        : { maxPayloadBytes: options.maxPayloadBytes }),
    });
  }
  return new UnixWebSocketTransport(endpoint.socketPath, {
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.maxPayloadBytes === undefined
      ? {}
      : { maxPayloadBytes: options.maxPayloadBytes }),
  });
}
