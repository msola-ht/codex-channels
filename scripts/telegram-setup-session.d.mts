import type { TomlTable } from "smol-toml";

export type TelegramSetupSource = "new" | "existing" | "configured";

export type TelegramSetupSessionState =
  | "created"
  | "validating"
  | "validated"
  | "preparing-pairing"
  | "waiting-for-message"
  | "sender-detected"
  | "ready"
  | "saving"
  | "saved"
  | "cancelled"
  | "expired"
  | "failed";

export interface TelegramSetupSessionStatus {
  sessionId: string;
  state: TelegramSetupSessionState;
  revision: number;
  expiresAt?: number;
  bot?: {
    username: string;
    source: TelegramSetupSource;
    reusesConfiguredBot: boolean;
    configuredAllowedUserIds?: string[];
  };
  pairing?: {
    link?: string;
    sender?: {
      id: string;
      username?: string;
      displayName: string;
    };
  };
  preview?: {
    botUsername: string;
    allowedUserIds: string[];
  };
  error?: { code: string };
}

export interface TelegramSetupSessionResult {
  action: "configured";
  botUsername: string;
  allowedUserIds: string[];
  configPath: string;
  activation: "restart-gateway";
}

export class TelegramSetupSessionError extends Error {
  code: string;
  field: string;
}

export interface TelegramSetupSession {
  start(
    ownerId: string,
    input: { source: TelegramSetupSource; token?: string },
  ): TelegramSetupSessionStatus;
  status(ownerId: string): TelegramSetupSessionStatus;
  subscribe(
    ownerId: string,
    listener: (status: TelegramSetupSessionStatus) => void,
  ): () => void;
  waitForValidation(ownerId: string): Promise<TelegramSetupSessionStatus>;
  startPairing(
    ownerId: string,
    input?: { waitSeconds?: number },
  ): TelegramSetupSessionStatus;
  waitForPairing(ownerId: string): Promise<TelegramSetupSessionStatus>;
  useAllowedUserIds(
    ownerId: string,
    values: Array<string | number>,
  ): TelegramSetupSessionStatus;
  acceptPairing(
    ownerId: string,
    input?: { additionalUserIds?: Array<string | number> },
  ): TelegramSetupSessionStatus;
  confirm(ownerId: string): Promise<TelegramSetupSessionResult>;
  cancel(ownerId: string): TelegramSetupSessionStatus;
}

export function createTelegramSetupSession(
  input: { ownerId: string; timeoutMs?: number },
  options?: {
    environment?: NodeJS.ProcessEnv;
    createSessionId?: () => string;
    createClient?: (token: string, proxyUrl?: string) => {
      getMe(signal?: AbortSignal): Promise<{ username?: string }>;
      getUpdates(parameters: object, signal?: AbortSignal): Promise<unknown[]>;
    };
    createPairingCode?: () => string;
    now?: () => number;
    writeConfig?: (
      configPath: string,
      document: TomlTable,
    ) => void;
  },
): TelegramSetupSession;
