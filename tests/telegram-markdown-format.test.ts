import { describe, expect, it } from "vitest";

import { formatMarkdownAsTelegramHtml, formatMarkdownAsTelegramHtmlChunks } from "../src/surfaces/telegram/markdown-format.js";

describe("Telegram Markdown compatibility formatter", () => {
  it("preserves code blocks and links when excluding the reserved bold heading", () => {
    expect(formatMarkdownAsTelegramHtml("```text\nCodex 交互回复\nexample\n```"))
      .toBe('<pre><code class="language-text">Codex 交互回复\nexample</code></pre>');
    expect(formatMarkdownAsTelegramHtml("**[Codex 交互回复](https://example.com)**\n\n正文"))
      .toBe('<a href="https://example.com">Codex 交互回复</a>\n\n正文');
  });

  it.each(["## Codex 交互回复", "**Codex 交互回复**", "# **Codex 交互回复**"])("reserves the interaction marker when formatting %s", (heading) => {
    expect(formatMarkdownAsTelegramHtml(`${heading}\n\n普通回答`)).toBe("Codex 交互回复\n\n普通回答");
  });

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

  it("renders local file references compactly while preserving line numbers and web links", () => {
    const markdown = [
      "[sqlite-store.ts:76](/root/project/src/sqlite-store.ts:76)",
      "[report.md](</root/My Project/report.md:3>)",
      "[unsafe.ts](/root/a<b>.ts:9)",
      "[文档](https://example.com/docs)",
      "`[example.ts](/root/example.ts:1)`",
    ].join("\n");
    expect(formatMarkdownAsTelegramHtml(markdown)).toBe([
      "<code>sqlite-store.ts:76</code>",
      "<code>report.md:3</code>",
      "<code>a&lt;b&gt;.ts:9</code>",
      '<a href="https://example.com/docs">文档</a>',
      "<code>[example.ts](/root/example.ts:1)</code>",
    ].join("\n"));
    const long = formatMarkdownAsTelegramHtmlChunks(
      "- [sqlite-store.ts:76](/root/project/src/sqlite-store.ts:76)\n".repeat(300),
    );
    expect(long.length).toBeGreaterThan(1);
    expect(long.join("")).toContain("<code>sqlite-store.ts:76</code>");
    expect(long.join("")).not.toContain("/root/");
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

  it("consumes Markdown backslash escapes without changing code or paths", () => {
    expect(formatMarkdownAsTelegramHtml([
      "DESKTOP\\_TO\\_CHANNEL\\_OK",
      "\\*literal\\*",
      String.raw`C:\Users\heforge`,
      "`DESKTOP\\_TO\\_CHANNEL\\_OK`",
      "```text",
      "DESKTOP\\_TO\\_CHANNEL\\_OK",
      "```",
    ].join("\n"))).toBe([
      "DESKTOP_TO_CHANNEL_OK",
      "*literal*",
      String.raw`C:\Users\heforge`,
      "<code>DESKTOP\\_TO\\_CHANNEL\\_OK</code>",
      "<pre><code class=\"language-text\">DESKTOP\\_TO\\_CHANNEL\\_OK</code></pre>",
    ].join("\n"));
  });
});
