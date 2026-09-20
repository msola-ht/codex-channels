export function runCodexUserSettingsSetup(options?: {
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  prompts?: {
    select(options: unknown): Promise<unknown>;
    confirm(options: unknown): Promise<unknown>;
    text?(options: { message: string; initialValue?: string; validate?: (value: string) => string | undefined }): Promise<string | symbol>;
    isCancel(value: unknown): boolean;
  };
  defaultsSetup?: typeof import("./codex-defaults-setup.mjs").runCodexDefaultsSetup;
  loadSettings?: typeof import("./codex-user-settings-management.mjs").loadCodexUserSettings;
  updateSetting?: typeof import("./codex-user-settings-management.mjs").updateCodexUserSetting;
  createClient?: import("./codex-user-settings-management.mjs").CodexUserSettingsDependencies["createClient"];
  primaryProvider?: import("./codex-user-settings-management.mjs").CodexUserSettingsDependencies["primaryProvider"];
}): Promise<unknown>;
