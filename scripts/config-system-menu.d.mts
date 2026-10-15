import type { writeGatewayConfig } from "../runtime/gateway-config.mjs";

type SystemMenuOptions = {
  environment: NodeJS.ProcessEnv;
  output: { write(value: string): unknown };
  prompts: {
    select(options: unknown): Promise<unknown>;
    confirm(options: unknown): Promise<unknown>;
    text(options: unknown): Promise<string | symbol>;
    isCancel(value: unknown): boolean;
  };
  writeConfig?: typeof writeGatewayConfig;
};

export function runSystemSettings(options: SystemMenuOptions & {
  input: { isTTY?: boolean };
  group?: "conversation" | "identity" | "traffic";
}): Promise<unknown>;

export function runDefaultWorkspace(options: Pick<SystemMenuOptions,
  "environment" | "output" | "writeConfig"
> & {
  prompts: Pick<SystemMenuOptions["prompts"], "select" | "isCancel">;
}): Promise<unknown>;
export function runOfficialTuiIdentity(options: SystemMenuOptions): Promise<unknown>;
