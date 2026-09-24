export interface CliMenuPrompts {
  intro(message: string): void;
  isCancel(value: unknown): boolean;
  select(options: Record<string, unknown>): Promise<unknown>;
  confirm(options: Record<string, unknown>): Promise<unknown>;
}
export function reportMenuError(error: unknown): void;
export function runCliMenu(options: {
  prompts?: CliMenuPrompts;
  runCommand: (args: string[]) => unknown | Promise<unknown>;
}): Promise<void>;
export function runServiceMenu(options: {
  prompts?: CliMenuPrompts;
  runCommand: (args: string[]) => unknown | Promise<unknown>;
}): Promise<void>;
