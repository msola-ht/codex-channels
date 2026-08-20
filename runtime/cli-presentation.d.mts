export type CliStatusKind = "success" | "failure" | "note" | "remediation";
export interface CliPresentationOptions {
  stream?: Pick<NodeJS.WriteStream, "isTTY">;
  environment?: NodeJS.ProcessEnv;
}
export interface CliOutputStream {
  isTTY?: boolean;
  write(value: string): unknown;
}
export interface CliMessageWriterOptions {
  stdout?: CliOutputStream;
  stderr?: CliOutputStream;
  environment?: NodeJS.ProcessEnv;
  destination?: "stdout" | "stderr";
}
export function cliColorsEnabled(
  stream?: Pick<NodeJS.WriteStream, "isTTY">,
  environment?: NodeJS.ProcessEnv,
): boolean;
export function colorizeCliText(
  kind: CliStatusKind,
  value: string,
  options?: CliPresentationOptions,
): string;
export function formatCliStatus(
  kind: CliStatusKind,
  name: string,
  detail: string,
  options?: CliPresentationOptions,
): string;
export function formatCliMessage(
  kind: CliStatusKind,
  message: string,
  options?: CliPresentationOptions,
): string;
export function writeCliMessage(
  kind: CliStatusKind,
  message: string,
  options?: CliMessageWriterOptions,
): void;
export function writeCliRemediationRestartAll(
  options?: CliMessageWriterOptions,
): void;
