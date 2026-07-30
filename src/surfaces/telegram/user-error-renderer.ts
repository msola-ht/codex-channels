import type { UserFacingError } from "../../conversation-core/index.js";
import { formatSurfaceUserFacingError } from "../user-facing-error-format.js";

export function formatTelegramUserFacingError(error: UserFacingError): string {
  return formatSurfaceUserFacingError(error, "Telegram");
}
