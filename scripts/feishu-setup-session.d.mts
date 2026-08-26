import type { TomlTable } from "smol-toml";

export type FeishuSetupMode = "manual" | "scan";

export type FeishuSetupSessionState =
  | "created"
  | "registering"
  | "waiting-for-authorization"
  | "validating"
  | "validated"
  | "ready"
  | "saving"
  | "configuring-application"
  | "saved"
  | "cancelled"
  | "expired"
  | "failed";

export interface FeishuSetupSessionStatus {
  sessionId: string;
  state: FeishuSetupSessionState;
  revision: number;
  expiresAt?: number;
  registrationStatus?: "polling" | "slow-down" | "domain-switched";
  authorization?: {
    url: string;
    expiresInSeconds: number;
  };
  application?: {
    mode: FeishuSetupMode;
    appId: string;
    botName: string;
    configuredAllowedOpenIds?: string[];
  };
  preview?: {
    enabled: true;
    appId: string;
    botName: string;
    allowedOpenIds: string[];
  };
  error?: { code: string };
}

export interface FeishuSetupSessionResult {
  action: "configured";
  appId: string;
  allowedOpenIds: string[];
  configPath: string;
  activation: "restart-gateway";
  applicationConfiguration:
    | "not-requested"
    | "updated"
    | "unchanged"
    | "failed";
  warnings: Array<{ code: "application-configuration-failed" }>;
}

export class FeishuSetupSessionError extends Error {
  code: string;
  field: string;
}

export interface FeishuSetupSession {
  start(
    ownerId: string,
    input:
      | { mode: "scan" }
      | { mode: "manual"; appId: string; appSecret: string },
  ): FeishuSetupSessionStatus;
  status(ownerId: string): FeishuSetupSessionStatus;
  subscribe(
    ownerId: string,
    listener: (status: FeishuSetupSessionStatus) => void,
  ): () => void;
  waitForReady(ownerId: string): Promise<FeishuSetupSessionStatus>;
  useAllowedOpenIds(
    ownerId: string,
    values: string[],
  ): FeishuSetupSessionStatus;
  confirm(ownerId: string): Promise<FeishuSetupSessionResult>;
  cancel(ownerId: string): FeishuSetupSessionStatus;
}

export function createFeishuSetupSession(
  input: { ownerId: string; timeoutMs?: number },
  options?: {
    environment?: NodeJS.ProcessEnv;
    createSessionId?: () => string;
    now?: () => number;
    registerApplication?: (options: {
      source: string;
      signal: AbortSignal;
      addons: object;
      onQRCodeReady(info: { url: string; expireIn: number }): void;
      onStatusChange(info: {
        status: "polling" | "slow_down" | "domain_switched";
        interval?: number;
      }): void;
    }) => Promise<unknown>;
    validateApplication?: (
      credentials: { appId: string; appSecret: string },
      options?: { signal?: AbortSignal },
    ) => Promise<{ openId?: string; name?: string }>;
    configureApplication?: (
      credentials: { appId: string; appSecret: string },
      options?: { signal?: AbortSignal },
    ) => Promise<{ changed?: boolean }>;
    writeConfig?: (configPath: string, document: TomlTable) => void;
  },
): FeishuSetupSession;

export function normalizeOpenIds(values: Array<string | number>): string[];
