import { describe, expect, it } from "vitest";

import {
  isThreadIdle,
  parseSessionCleanupArgs,
} from "../scripts/session-cleanup.mjs";

describe("session cleanup CLI", () => {
  it("parses the Turn, idle and confirmation options", () => {
    expect(parseSessionCleanupArgs(["3"])).toEqual({
      confirm: false,
      maxTurns: 3,
      idleDays: null,
    });
    expect(parseSessionCleanupArgs(["3", "--idle-days", "30", "--confirm"])).toEqual({
      confirm: true,
      maxTurns: 3,
      idleDays: 30,
    });
  });

  it("rejects malformed idle options", () => {
    expect(() => parseSessionCleanupArgs(["3", "--idle-days", "0"])).toThrow();
    expect(() => parseSessionCleanupArgs(["3", "--confirm", "--idle-days"])).toThrow();
  });

  it("prefers recencyAt and fails closed when activity metadata is absent", () => {
    expect(isThreadIdle({ recencyAt: 90, updatedAt: 10 }, 100)).toBe(true);
    expect(isThreadIdle({ recencyAt: 110, updatedAt: 10 }, 100)).toBe(false);
    expect(isThreadIdle({ recencyAt: null, updatedAt: 90 }, 100)).toBe(true);
    expect(isThreadIdle({}, 100)).toBe(false);
  });
});
