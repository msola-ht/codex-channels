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
): Promise<{ edits: CodexUserConfigEdit[]; value: Record<string, unknown> }>;
export function isStrataServer(server: unknown): boolean;
export function validateStrataMcpEdit(
  config: Record<string, CodexUserConfigValue | undefined>,
  merged: Record<string, CodexUserConfigValue | undefined> | undefined,
  name: string,
  field: string,
  value: CodexUserConfigValue,
): Promise<{ timeoutSeconds: number; toolTimeoutSeconds: number; root: string; channelRoot?: string } | undefined>;
export const mcpToolApprovalModes: readonly ["auto", "prompt", "writes", "approve"];
