import { describe, expect, it } from "vitest";

import type { OutputEvent } from "../src/conversation-core/index.js";
import { TurnPlanProgressState } from "../src/surfaces/plan-presentation.js";

describe("TurnPlanProgressState", () => {
  it("tracks completed steps independently for each Turn", () => {
    const state = new TurnPlanProgressState();
    const initial = planUpdated("turn-one", [
      { step: "第一步", status: "inProgress" },
      { step: "第二步", status: "pending" },
    ]);

    expect(state.accept(initial)).toHaveLength(1);
    expect(state.accept(planUpdated("turn-one", [
      { step: "第一步", status: "completed" },
      { step: "第二步", status: "inProgress" },
    ]))).toMatchObject([{ title: "计划进度 · 1/2" }]);
    expect(state.accept(planUpdated("turn-two", [
      { step: "另一任务", status: "inProgress" },
    ]))).toMatchObject([{ title: "任务计划 · 0/1" }]);
  });

  it("releases a completed Turn so reused identifiers start with a full snapshot", () => {
    const state = new TurnPlanProgressState();
    const event = planUpdated("turn", [
      { step: "步骤", status: "completed" },
    ]);

    expect(state.accept(event)).toMatchObject([{ title: "任务计划 · 1/1" }]);
    expect(state.accept(event)).toEqual([]);
    state.complete(turnCompleted("turn"));
    expect(state.accept(event)).toMatchObject([{ title: "任务计划 · 1/1" }]);

    state.clear();
    expect(state.accept(event)).toMatchObject([{ title: "任务计划 · 1/1" }]);
  });
});

const target = {
  surface: "telegram" as const,
  accountId: "default",
  conversationId: "chat",
};

function planUpdated(
  turnId: string,
  steps: Extract<OutputEvent, { type: "plan.updated" }>["steps"],
): Extract<OutputEvent, { type: "plan.updated" }> {
  return {
    type: "plan.updated",
    target,
    threadId: "thread",
    turnId,
    explanation: null,
    steps,
  };
}

function turnCompleted(
  turnId: string,
): Extract<OutputEvent, { type: "turn.completed" }> {
  return {
    type: "turn.completed",
    target,
    threadId: "thread",
    turnId,
    status: "completed",
  };
}
