import type { AccountRateLimits } from "./account-port.js";
import type { ModelOption } from "./model-port.js";

export const lunaReserveModel = "gpt-reserve";

export interface LunaReserveThreadSettings {
  model: string;
  effort: string | null;
  serviceTier: string | null;
  collaborationMode: "default" | "plan";
}

export interface LunaReservePort {
  accountRateLimits(options?: { background?: boolean; signal?: AbortSignal }): Promise<AccountRateLimits>;
  lunaReserveModel(): Promise<ModelOption | null>;
  updateLunaReserveThreadSettings(
    threadId: string,
    settings: LunaReserveThreadSettings,
    beforeSubmit?: () => void,
  ): Promise<void>;
}
