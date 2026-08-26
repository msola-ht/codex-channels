import type {
  AppServerProviderReleaseResult,
  AppServerSupervisorInspection,
} from "../runtime/app-server-supervisor.mjs";
import type { ManagedModelProviderId } from "../runtime/model-provider-definitions.mjs";

export class OpenCodeGoAccountManagementError extends Error {
  code: string;
  field: string;
}

export interface OpenCodeGoDefaultAccountPreview {
  operation: "set-default";
  account: { id: string; default: true };
  currentDefaultAccountId: string | null;
  updatesExternalAgent: boolean;
  willChange: boolean;
  activation: "restart-all";
}

export interface OpenCodeGoAccountStopPreview {
  operation: "stop";
  account: { id: string; provider: string };
  status: "running" | "not-running";
  willChange: boolean;
  activation: "none";
}

export interface OpenCodeGoAccountRemovalPreview {
  operation: "remove";
  account: { id: string; provider: string; default: boolean };
  effects: {
    stopsRunningAppServer: boolean;
    promotesDefaultAccountId: string | null;
    preservesPrivateBackup: true;
    historyThreadsBecomeUnavailable: true;
  };
  confirmation: { required: true; field: "confirmHistoryLoss" };
  activation: "restart-all";
}

interface AccountManagementOptions {
  environment?: NodeJS.ProcessEnv;
  loadAccounts?: (environment: NodeJS.ProcessEnv) => Array<{
    id: string;
    default: boolean;
  }>;
}

export function previewOpencodeGoDefaultAccountChange(
  accountId: string,
  options?: AccountManagementOptions & {
    loadRole?: (environment: NodeJS.ProcessEnv) =>
      | { provider: ManagedModelProviderId; model: string }
      | undefined;
  },
): OpenCodeGoDefaultAccountPreview;

export function applyOpencodeGoDefaultAccountChange(
  accountId: string,
  options?: AccountManagementOptions & {
    loadRole?: (environment: NodeJS.ProcessEnv) =>
      | { provider: ManagedModelProviderId; model: string }
      | undefined;
    writeAccounts?: (
      environment: NodeJS.ProcessEnv,
      accounts: Array<{ id: string; default: boolean }>,
    ) => void;
    configureRole?: (
      provider: ManagedModelProviderId,
      model: string | undefined,
      environment: NodeJS.ProcessEnv,
    ) => unknown | Promise<unknown>;
  },
): Promise<{ action: "default-set" } & OpenCodeGoDefaultAccountPreview>;

interface StopOptions extends AccountManagementOptions {
  resolvePrimarySocket?: (environment: NodeJS.ProcessEnv) => string;
  inspectSupervisor?: (socketPath: string) => Promise<AppServerSupervisorInspection>;
}

export function previewOpencodeGoAccountStop(
  accountId: string,
  options?: StopOptions,
): Promise<OpenCodeGoAccountStopPreview>;

export function applyOpencodeGoAccountStop(
  accountId: string,
  options?: StopOptions & {
    releaseProvider?: (
      socketPath: string,
      provider: string,
    ) => Promise<AppServerProviderReleaseResult>;
  },
): Promise<{
  action: "stopped" | "not-running" | "in-use";
  operation: "stop";
  account: { id: string; provider: string };
  status: "stopped" | "not-running" | "in-use";
  willChange: false;
  activation: "none";
}>;

interface RemovalOptions extends StopOptions {
  loadRole?: (environment: NodeJS.ProcessEnv) =>
    | { provider: ManagedModelProviderId; model: string }
    | undefined;
}

export function previewOpencodeGoAccountRemoval(
  accountId: string,
  options?: RemovalOptions,
): Promise<OpenCodeGoAccountRemovalPreview>;

export function applyOpencodeGoAccountRemoval(
  input: {
    accountId: string;
    confirmHistoryLoss?: boolean;
  },
  options?: RemovalOptions & {
    writeAccounts?: (
      environment: NodeJS.ProcessEnv,
      accounts: Array<{ id: string; default: boolean }>,
    ) => void;
    releaseProvider?: (
      socketPath: string,
      provider: string,
    ) => Promise<AppServerProviderReleaseResult>;
    stopAccount?: (
      accountId: string,
      options: StopOptions & {
        releaseProvider?: (
          socketPath: string,
          provider: string,
        ) => Promise<AppServerProviderReleaseResult>;
      },
    ) => Promise<{ action: "stopped" | "not-running" | "in-use" }>;
  },
): Promise<{
  action: "removed";
  runtime: "stopped" | "not-running";
  backupDirectory: string;
} & OpenCodeGoAccountRemovalPreview>;
