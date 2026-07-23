import { describe, expect, it } from "vitest";

import { formatMarkdownAsTelegramHtml } from "../src/surfaces/telegram/markdown-format.js";

describe("Telegram Markdown compatibility formatter", () => {
  it("formats common Codex Markdown using traditional Telegram HTML", () => {
    expect(formatMarkdownAsTelegramHtml([
      "# 标题",
      "",
      "- **重点**与`代码`",
      "> 引用 <内容>",
      "```ts",
      "const value = a < b;",
      "```",
    ].join("\n"))).toBe([
      "<b>标题</b>",
      "",
      "• <b>重点</b>与<code>代码</code>",
      "<blockquote>引用 &lt;内容&gt;</blockquote>",
      "<pre><code class=\"language-ts\">const value = a &lt; b;</code></pre>",
    ].join("\n"));
  });

  it("declines oversized content so the outbox can fall back to plain text", () => {
    expect(formatMarkdownAsTelegramHtml("a".repeat(3_501))).toBeUndefined();
  });
});
