export function promptManagedAccountId(prompts: {
  select(options: { message: string; options: { value: string; label: string }[] }): Promise<string | symbol>;
  text(options: { message: string; validate(value: string): string | undefined }): Promise<string | symbol>;
  isCancel(value: unknown): boolean;
}, accounts: readonly { id: string }[], reservedIds?: readonly string[]): Promise<string | symbol>;
