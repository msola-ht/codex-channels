export function promptManagedAccountId(prompts: {
  select(options: { message: string; options: { value: string; label: string }[] }): Promise<string | symbol>;
  text(options: { message: string; validate(value: string): string | undefined }): Promise<string | symbol>;
  isCancel(value: unknown): boolean;
}, accounts: readonly { id: string }[], reservedIds?: readonly string[]): Promise<string | symbol>;
export function promptManagedAccountEdit(options: {
  prompts: typeof import("@clack/prompts");
  current?: { mode: "switching" | "exclusive" };
  definition: import("../runtime/model-provider-definitions.mjs").ModelProviderDefinition;
  reconfigure: boolean;
}): Promise<{ mode: "switching" | "exclusive"; apiKey?: string } | undefined>;
export function confirmManagedAccountEdit(preview: {
  account: { provider: string }; mode: string; previousMode?: string; credentialAction: string; willChange: boolean; model?: string; effects: { writesMainConfig: boolean };
}, options: { prompts: typeof import("@clack/prompts"); output: { write(value: string): unknown } }): Promise<boolean>;
