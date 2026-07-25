import { describe, expect, it } from "vitest";

import { toThreadStateEvent } from "../src/codex-client/index.js";

describe("Notification adapter", () => {
  it("maps complete Thread settings to a stable routing event", () => {
    expect(toThreadStateEvent({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          model: "gpt-5.6-sol",
          effort: "high",
          serviceTier: "priority",
        },
      },
    })).toEqual({
      type: "thread.settings.updated",
      threadId: "thread-1",
      settings: {
        model: "gpt-5.6-sol",
        effort: "high",
        serviceTier: "priority",
      },
    });
  });

  it("preserves nullable effort and service tier values", () => {
    expect(toThreadStateEvent({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          model: "gpt-5.6-sol",
          effort: null,
          serviceTier: null,
        },
      },
    })).toEqual({
      type: "thread.settings.updated",
      threadId: "thread-1",
      settings: {
        model: "gpt-5.6-sol",
        effort: null,
        serviceTier: null,
      },
    });
  });

  it("maps Thread lifecycle notifications without protocol envelopes", () => {
    expect(toThreadStateEvent({
      method: "thread/archived",
      params: { threadId: "thread-1" },
    })).toEqual({ type: "thread.archived", threadId: "thread-1" });
    expect(toThreadStateEvent({
      method: "thread/deleted",
      params: { threadId: "thread-2" },
    })).toEqual({ type: "thread.deleted", threadId: "thread-2" });
    expect(toThreadStateEvent({
      method: "thread/closed",
      params: { threadId: "thread-3" },
    })).toEqual({ type: "thread.closed", threadId: "thread-3" });
  });

  it("ignores incomplete or unrelated notifications", () => {
    expect(toThreadStateEvent({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          model: "gpt-5.6-sol",
          effort: "high",
        },
      },
    })).toBeUndefined();
    expect(toThreadStateEvent({
      method: "thread/deleted",
      params: { threadId: 1 },
    })).toBeUndefined();
    expect(toThreadStateEvent({
      method: "turn/started",
      params: { threadId: "thread-1" },
    })).toBeUndefined();
  });
});
