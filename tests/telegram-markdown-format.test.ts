import { describe, expect, it } from "vitest";

import { formatMarkdownAsTelegramHtml } from "../src/surfaces/telegram/markdown-format.js";

describe("Telegram Markdown compatibility formatter", () => {
  it("formats common Codex Markdown using traditional Telegram HTML", () => {
    expect(formatMarkdownAsTelegramHtml([
      "# 标题",
      "",
      "- **重点**与`代码`",
      "_中文斜体_与[项目文档](https://example.com/docs?a=1&b=2)",
      "> 引用 <内容>",
      "",
      "| 项目 | 状态 |",
      "| --- | --- |",
      "| 标题 | 正常 |",
      "| 链接 | [可点击](https://example.com/) |",
      "```ts",
      "const value = a < b;",
      "```",
    ].join("\n"))).toBe([
      "<b>标题</b>",
      "",
      "• <b>重点</b>与<code>代码</code>",
      "<i>中文斜体</i>与<a href=\"https://example.com/docs?a=1&amp;b=2\">项目文档</a>",
      "<blockquote>引用 &lt;内容&gt;</blockquote>",
      "",
      "<b>项目 · 状态</b>",
      "• 标题 · 正常",
      "• 链接 · <a href=\"https://example.com/\">可点击</a>",
      "<pre><code class=\"language-ts\">const value = a &lt; b;</code></pre>",
    ].join("\n"));
  });

  it("does not turn unsupported or malformed Markdown destinations into Telegram links", () => {
    expect(formatMarkdownAsTelegramHtml([
      "[本地](file:///tmp/private)",
      "[脚本](javascript:alert(1))",
      "[未闭合](https://example.com",
    ].join("\n"))).toBe([
      "[本地](file:///tmp/private)",
      "[脚本](javascript:alert(1))",
      "[未闭合](https://example.com",
    ].join("\n"));
  });

  it("declines oversized content so the outbox can fall back to plain text", () => {
    expect(formatMarkdownAsTelegramHtml("a".repeat(3_501))).toBeUndefined();
  });

  it("keeps Telegram commands clickable outside code markup", () => {
    expect(formatMarkdownAsTelegramHtml([
      "```text",
      "/status",
      "/goal unknown",
      "/fast status",
      "```",
      "",
      "也可以点击 `/sessions`。",
    ].join("\n"))).toBe([
      "/status",
      "/goal unknown",
      "/fast status",
      "",
      "也可以点击 /sessions。",
    ].join("\n"));
  });

  it("keeps shell and mixed text blocks as code", () => {
    expect(formatMarkdownAsTelegramHtml([
      "```shell",
      "/status",
      "```",
      "```text",
      "/status",
      "npm test",
      "```",
    ].join("\n"))).toBe([
      "<pre><code class=\"language-shell\">/status</code></pre>",
      "<pre><code class=\"language-text\">/status\nnpm test</code></pre>",
    ].join("\n"));
  });
});
