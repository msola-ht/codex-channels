import type {
  OutputEvent,
  TurnPlanStep,
} from "../conversation-core/index.js";

const maximumPlanSteps = 12;
const maximumStepCharacters = 240;
const maximumExplanationCharacters = 500;

export interface PlanPresentation {
  title: string;
  text: string;
  fingerprint: string;
}

export class PlanProgressTracker {
  private initialized = false;
  private readonly completedSteps = new Set<string>();

  accept(
    event: Extract<OutputEvent, { type: "plan.updated" }>,
  ): readonly PlanPresentation[] {
    if (!this.initialized) {
      this.initialized = true;
      this.rememberCompleted(event.steps);
      return [createPlanPresentation(event)];
    }
    const presentations: PlanPresentation[] = [];
    event.steps.forEach((step, index) => {
      if (step.status !== "completed") {
        return;
      }
      const key = stepKey(step, index);
      if (this.completedSteps.has(key)) {
        return;
      }
      this.completedSteps.add(key);
      presentations.push(createCompletedStepPresentation(event, step, index));
    });
    return presentations;
  }

  private rememberCompleted(steps: readonly TurnPlanStep[]): void {
    steps.forEach((step, index) => {
      if (step.status === "completed") {
        this.completedSteps.add(stepKey(step, index));
      }
    });
  }
}

export function createPlanPresentation(
  event: Extract<OutputEvent, { type: "plan.updated" }>,
): PlanPresentation {
  const steps = event.steps.slice(0, maximumPlanSteps);
  const completed = steps.filter((step) => step.status === "completed").length;
  const title = `任务计划 · ${completed}/${event.steps.length}`;
  const explanation = boundedText(
    event.explanation?.trim() ?? "",
    maximumExplanationCharacters,
  );
  const lines = steps.map(formatStep);
  if (event.steps.length > steps.length) {
    lines.push(`… 其余 ${event.steps.length - steps.length} 项未显示`);
  }
  const text = [
    title,
    ...(explanation ? ["", explanation] : []),
    ...(lines.length > 0 ? ["", ...lines] : ["", "暂无步骤"]),
  ].join("\n");
  return {
    title,
    text,
    fingerprint: text,
  };
}

function createCompletedStepPresentation(
  event: Extract<OutputEvent, { type: "plan.updated" }>,
  step: TurnPlanStep,
  index: number,
): PlanPresentation {
  const completed = event.steps.filter(
    (candidate) => candidate.status === "completed",
  ).length;
  const title = `计划进度 · ${completed}/${event.steps.length}`;
  const text = [
    title,
    "",
    `✓ 第 ${index + 1} 步完成：${boundedText(
      step.step.trim() || "未命名步骤",
      maximumStepCharacters,
    )}`,
  ].join("\n");
  return {
    title,
    text,
    fingerprint: text,
  };
}

function formatStep(step: TurnPlanStep): string {
  const marker = step.status === "completed"
    ? "✓"
    : step.status === "inProgress"
      ? "◐"
      : "○";
  return `${marker} ${boundedText(step.step.trim() || "未命名步骤", maximumStepCharacters)}`;
}

function stepKey(step: TurnPlanStep, index: number): string {
  return `${index}\u0000${step.step}`;
}

function boundedText(value: string, maximumCharacters: number): string {
  const characters = Array.from(value);
  return characters.length <= maximumCharacters
    ? value
    : `${characters.slice(0, Math.max(0, maximumCharacters - 1)).join("")}…`;
}
