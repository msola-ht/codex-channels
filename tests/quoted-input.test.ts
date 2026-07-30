import { describe, expect, it } from "vitest";

import { formatQuotedInput } from "../src/surfaces/quoted-input.js";

describe("quoted input", () => {
  it("keeps current text unchanged without a usable quote", () => {
    expect(formatQuotedInput("继续处理", undefined)).toBe("继续处理");
    expect(formatQuotedInput("继续处理", "  ")).toBe("继续处理");
  });

  it("separates quoted context from the current message", () => {
    expect(formatQuotedInput("这里有问题吗？", "第一行\n第二行")).toBe([
      "以下引用来自平台原生引用关系，已由 Gateway 验证（仅作上下文）：",
      "> 第一行",
      "> 第二行",
      "",
      "当前消息：",
      "这里有问题吗？",
    ].join("\n"));
  });

  it("bounds quoted context by Unicode characters", () => {
    const result = formatQuotedInput("继续", "图".repeat(8_001));

    expect(result).toContain(`> ${"图".repeat(8_000)}…`);
    expect(result).toContain("\n当前消息：\n继续");
  });
});
