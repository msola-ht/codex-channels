export type BackgroundUpdateArgs =
  | { kind: "interactive" }
  | { kind: "submit"; sourceDirectory: string }
  | { kind: "status"; taskId: string | undefined; json: boolean }
  | { kind: "help"; topic: "update" | "status" };

export const BACKGROUND_UPDATE_USAGE: string;
export const BACKGROUND_UPDATE_STATUS_USAGE: string;
export function parseBackgroundUpdateArgs(args: readonly string[]): BackgroundUpdateArgs;
