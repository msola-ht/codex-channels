import { describe, expect, it } from "vitest";

import {
  decodeFeishuMenuEvent,
  FeishuMenuEventError,
} from "../src/surfaces/feishu/index.js";

describe("Feishu bot menu event", () => {
  it("keeps only stable routing fields", () => {
    expect(decodeFeishuMenuEvent({
      event_id: "event-menu-1",
      app_id: "cli_0123456789abcdef",
      operator: {
        operator_name: "Sensitive Name",
        operator_id: {
          open_id: "ou_actor",
          user_id: "user-ignored",
        },
      },
      event_key: "codexc_home",
      tenant_key: "tenant-ignored",
    })).toEqual({
      eventId: "event-menu-1",
      appId: "cli_0123456789abcdef",
      actorOpenId: "ou_actor",
      eventKey: "codexc_home",
    });
  });

  it.each([
    [{
      event_id: "event-menu-1",
      app_id: "cli_0123456789abcdef",
      event_key: "codexc_home",
    }, "operator"],
    [{
      event_id: "event-menu-1",
      app_id: "cli_0123456789abcdef",
      operator: {},
      event_key: "codexc_home",
    }, "operator.operator_id"],
    [{
      event_id: "event-menu-1",
      app_id: "cli_0123456789abcdef",
      operator: { operator_id: {} },
      event_key: "codexc_home",
    }, "operator.operator_id.open_id"],
  ])("fails closed for malformed routing fields", (input, field) => {
    expect(() => decodeFeishuMenuEvent(input)).toThrow(
      new FeishuMenuEventError(field as never),
    );
  });
});
