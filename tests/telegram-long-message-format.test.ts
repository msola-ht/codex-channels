import { formatMarkdownAsTelegramHtmlChunks } from "../src/surfaces/telegram/markdown-format.js";
import { describe, expect, it } from "vitest";

import {
  planLongFinalMessage,
} from "../src/surfaces/telegram/long-message-format.js";

describe("Telegram long final message planner", () => {
  it("keeps short replies on the normal formatter path", () => {
    expect(planLongFinalMessage("简短回复")).toBeUndefined();
  });

  it("splits ordinary long text into expanded HTML chunks", () => {
    const text = Array.from({ length: 500 }, (_, index) => `第 ${index + 1} 行普通说明`).join("\n");
    const plan = planLongFinalMessage(text);

    expect(plan?.kind).toBe("html");
    if (plan?.kind !== "html") {
      throw new Error("预期生成 HTML 分段消息");
    }
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.chunks.every((chunk) => chunk.length <= 3_800)).toBe(true);
    expect(plan.chunks.join("")).toBe(text);
  });

  it("preserves code fences, inline code and links across expanded message boundaries", () => {
    const code = "const value = '<&>';\n".repeat(300);
    const markdown = "## 报告\n\n字段： `output_tokens`，详见 [文档](https://example.com).\n\n```ts\n" + code + "```";
    const chunks = formatMarkdownAsTelegramHtmlChunks(markdown);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("<b>报告</b>");
    expect(chunks[0]).toContain("<code>output_tokens</code>");
    expect(chunks[0]).toContain('<a href="https://example.com">文档</a>');
    for (const chunk of chunks) {
      expect(chunk).not.toContain("expandable");
      expect(chunk).not.toContain("```");
      expect(chunk.match(/<pre>/g)?.length ?? 0).toBe(chunk.match(/<\/pre>/g)?.length ?? 0);
      expect(chunk.match(/<code(?: [^>]*)?>/g)?.length ?? 0).toBe(chunk.match(/<\/code>/g)?.length ?? 0);
      expect(chunk.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#39);/g, "x").length).toBeLessThanOrEqual(3500);
    }
    expect(chunks.join("").replace(/<[^>]*>/g, "")).toContain("const value = '&lt;&amp;&gt;';");
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

  it("does not split surrogate pairs when preparing HTML chunks", () => {
    const chunks = formatMarkdownAsTelegramHtmlChunks("😀".repeat(4_000));

    expect(chunks.every((chunk) => chunk.length <= 3_800)).toBe(true);
    expect(chunks.join("")).toBe("😀".repeat(4_000));
  });
});
