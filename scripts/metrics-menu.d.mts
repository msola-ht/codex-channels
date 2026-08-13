export interface MetricsMenuPrompts {
  intro(message: string): void;
  cancel(message: string): void;
  isCancel(value: unknown): boolean;
  select(options: Record<string, unknown>): Promise<unknown>;
  text(options: Record<string, unknown>): Promise<unknown>;
  confirm(options: Record<string, unknown>): Promise<unknown>;
}

export interface MetricsMenuThread {
  threadId: string;
  turnCount: number;
  requestCount: number;
  lastRecordedAtMs: number;
}

export function runMetricsMenu(options: {
  prompts?: MetricsMenuPrompts;
  readStorage?: () => Record<string, unknown>;
  readThreads?: () => MetricsMenuThread[] | Promise<MetricsMenuThread[]>;
  runDatabaseCommand: (args: string[]) => void;
  runMetricsCommand: (args: string[]) => void;
}): Promise<void>;
