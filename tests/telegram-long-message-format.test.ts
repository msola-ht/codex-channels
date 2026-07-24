import { describe, expect, it } from "vitest";

import {
  planLongFinalMessage,
  splitExpandableMessage,
} from "../src/surfaces/telegram/long-message-format.js";

describe("Telegram long final message planner", () => {
  it("keeps short replies on the normal formatter path", () => {
    expect(planLongFinalMessage("简短回复")).toBeUndefined();
  });

  it("splits ordinary long text into collapsed Telegram-safe chunks", () => {
    const text = Array.from({ length: 500 }, (_, index) => `第 ${index + 1} 行普通说明`).join("\n");
    const plan = planLongFinalMessage(text);

    expect(plan?.kind).toBe("expandable");
    if (plan?.kind !== "expandable") {
      throw new Error("预期生成折叠消息");
    }
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.chunks.every((chunk) => chunk.length <= 3_800)).toBe(true);
    expect(plan.chunks.join("\n")).toBe(text);
  });

  it("uses a Markdown document for large fenced code", () => {
    const code = [
      "```ts",
      ...Array.from({ length: 100 }, (_, index) =>
        `export const value${index} = "${"x".repeat(40)}";`
      ),
      "```",
    ].join("\n");
    const plan = planLongFinalMessage(code);

    expect(plan?.kind).toBe("document");
    if (plan?.kind !== "document") {
      throw new Error("预期生成完整回复文件");
    }
    expect(plan.filename).toBe("codex-response.md");
    expect(new TextDecoder().decode(plan.content)).toBe(code);
    expect(plan.previewHtml).toContain("完整内容已作为文件发送");
    expect(plan.lineCount).toBe(102);
  });

  it("limits document previews after HTML escaping", () => {
    const code = [
      "```html",
      ...Array.from({ length: 100 }, () => `"<script>&${"<&>".repeat(80)}`),
      "```",
    ].join("\n");
    const plan = planLongFinalMessage(code);

    expect(plan?.kind).toBe("document");
    if (plan?.kind !== "document") {
      throw new Error("预期生成完整回复文件");
    }
    expect(plan.previewHtml.length).toBeLessThan(4_096);
    expect(plan.previewHtml).toContain("&lt;");
    expect(plan.previewHtml).not.toContain("<script>");
  });

  it("does not split surrogate pairs when preparing expandable chunks", () => {
    const chunks = splitExpandableMessage("😀".repeat(4_000));

    expect(chunks.every((chunk) => chunk.length <= 3_800)).toBe(true);
    expect(chunks.join("")).toBe("😀".repeat(4_000));
  });
});
