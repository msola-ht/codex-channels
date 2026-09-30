import type { ModelRelayCommand } from "./model-relay-command.mjs";
import type { RelayQueueSnapshot, RelayManagementSnapshot } from "./webui-api.js";
export function readRelayManagement(environment?: NodeJS.ProcessEnv): RelayManagementSnapshot;
export function manageModelRelay(input: ModelRelayCommand, environment?: NodeJS.ProcessEnv, options?: { preview?: boolean; expectedRevision?: string; expectedConfigRevision?: string }): Promise<Record<string, unknown>>;
export function withRelayManagementTransaction<T extends object>(environment: NodeJS.ProcessEnv, operation: () => Promise<T>): Promise<T & { cleanupStatus?: "failed" }>;

export function readRelayQueue(environment?: NodeJS.ProcessEnv): Promise<RelayQueueSnapshot>;

export function readRelayListener(environment?: NodeJS.ProcessEnv): { enabled: boolean; host: string; port: number; revision: string };
