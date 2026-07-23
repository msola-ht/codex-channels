import { describe, expect, it } from "vitest";

import { UserFacingError } from "../src/conversation-core/index.js";
import { formatTelegramUserFacingError } from "../src/surfaces/telegram/user-error-renderer.js";

describe("Telegram user error renderer", () => {
  it("renders platform syntax from an error code instead of the internal fallback", () => {
    const error = new UserFacingError(
      "fast.usage",
      "opaque-internal-fallback",
    );

    expect(formatTelegramUserFacingError(error)).toBe(
      "用法：/fast [on|off|status]",
    );
    expect(formatTelegramUserFacingError(error)).not.toContain("opaque");
  });

  it("renders semantic command details with Telegram slash syntax", () => {
    const error = new UserFacingError(
      "session.selector.required",
      "selector required",
      { command: "unarchive" },
    );

    expect(formatTelegramUserFacingError(error)).toContain("/unarchive");
  });
});
