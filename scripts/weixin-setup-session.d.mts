export type WeixinSetupSessionState =
  | "created"
  | "starting"
  | "waiting-for-scan"
  | "scanned"
  | "verification-required"
  | "ready"
  | "already-connected"
  | "saving"
  | "saved"
  | "cancelled"
  | "expired"
  | "failed";

export interface WeixinSetupSessionStatus {
  sessionId: string;
  state: WeixinSetupSessionState;
  revision: number;
  expiresAt?: number;
  qrCode?: string;
  upstreamStatus?: string;
  verificationRequestId?: number;
  preview?: {
    accountId: string;
    scannerId: string;
    credentialConfigured: true;
    existingAllowedUserCount: number;
    enabled: false;
  };
  error?: { code: string };
}

export interface WeixinSetupSessionResult {
  action: "configured";
  accountId: string;
  allowedUserIds: string[];
  configPath: string;
  activation: "restart-gateway";
  warnings: Array<{ code: "old-credential-cleanup-failed" }>;
}

export class WeixinSetupSessionError extends Error {
  code: string;
  field: string;
}

export interface WeixinSetupSession {
  start(ownerId: string): WeixinSetupSessionStatus;
  status(ownerId: string): WeixinSetupSessionStatus;
  subscribe(
    ownerId: string,
    listener: (status: WeixinSetupSessionStatus) => void,
  ): () => void;
  waitForLogin(ownerId: string): Promise<WeixinSetupSessionStatus>;
  provideVerificationCode(
    ownerId: string,
    code: string,
  ): WeixinSetupSessionStatus;
  confirm(
    ownerId: string,
    input?: { preserveExistingAllowedUsers?: boolean },
  ): Promise<WeixinSetupSessionResult>;
  cancel(ownerId: string): WeixinSetupSessionStatus;
}

export function createWeixinSetupSession(
  input: { ownerId: string; timeoutMs?: number },
  options?: {
    environment?: NodeJS.ProcessEnv;
    client?: unknown;
    createSessionId?: () => string;
    now?: () => number;
    runLogin?: (options: {
      client: unknown;
      baseUrl: string;
      signal: AbortSignal;
      overallTimeoutMs: number;
      displayQr(value: string): Promise<void>;
      readVerifyCode(): Promise<string>;
      onStatus(status: string): void;
    }) => Promise<
      | { kind: "already-connected" }
      | {
          kind: "confirmed";
          accountId: string;
          userId?: string;
          botToken: string;
          baseUrl?: string;
        }
    >;
    validateCredential?: (
      result: {
        kind: "confirmed";
        accountId: string;
        userId?: string;
        botToken: string;
        baseUrl?: string;
      },
      grantedAt: number,
    ) => Promise<{
      version: 1;
      accountId: string;
      botToken: string;
      baseUrl: string;
      grantedAt: number;
    }>;
    createCredentialStore?: (directory: string) => Promise<{
      get(accountId: string): Promise<unknown>;
      set(credential: unknown): Promise<void>;
      remove(accountId: string): Promise<void>;
    }>;
    writeConfig?: (
      configPath: string,
      document: Record<string, unknown>,
    ) => void;
  },
): WeixinSetupSession;
