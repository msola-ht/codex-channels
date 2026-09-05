export interface SessionMenuPrompts {
  intro(message: string): void;
  cancel(message: string): void;
  isCancel(value: unknown): boolean;
  select(options: Record<string, unknown>): Promise<unknown>;
  text(options: Record<string, unknown>): Promise<unknown>;
}

export function runSessionMenu(options: {
  prompts?: SessionMenuPrompts;
  runCleanup: (args: string[]) => void | Promise<unknown>;
}): Promise<unknown>;
