import type { CodexUserConfigValue, CodexUserConfigEdit } from "./codex-user-config.mjs";

export interface CodexToolSettingField {
  path: string[];
  label: string;
  type: "choice" | "boolean" | "number" | "integer" | "list";
  options: string[] | null;
  userValue: CodexUserConfigValue;
  mergedValue: CodexUserConfigValue;
}

export interface CodexToolSettings {
  mergedAvailable: boolean;
  fields: CodexToolSettingField[];
}

export function toolSettingValueError(field: CodexToolSettingField, value: unknown): string | undefined;

export function projectToolSettings(
  config: Record<string, CodexUserConfigValue | undefined>,
  merged?: Record<string, CodexUserConfigValue | undefined>,
): CodexToolSettings;

export function toolSettingEdits(
  input: { path: string[]; value: CodexUserConfigValue },
  config: Record<string, CodexUserConfigValue | undefined>,
  merged: Record<string, CodexUserConfigValue | undefined> | undefined,
  invalid: (field: string, code: string, message: string) => Error,
): { edits: CodexUserConfigEdit[]; value: Record<string, unknown> };
