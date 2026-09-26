import { describe, expect, it } from "vitest";

import { formatMarkdownAsTelegramHtml, formatMarkdownAsTelegramHtmlChunks, telegramFormattedHtmlText } from "../src/surfaces/telegram/markdown-format.js";

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


describe("Telegram long Markdown HTML", () => {
  it("preserves formatting tags, code, entities and Unicode across boundaries", () => {
    const text = "# 标题\n\n**" + "粗体<&𠮷".repeat(650) + "**\n\n```ts\n" + "const x = '<&>';\n".repeat(150) + "```";
    const chunks = formatMarkdownAsTelegramHtmlChunks(text)!;
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const stack: string[] = [];
      for (const tag of chunk.match(/<[^>]+>/gu) ?? []) {
        const name = /^<\/?([a-z]+)/u.exec(tag)![1]!;
        if (tag.startsWith("</")) expect(stack.pop()).toBe(name);
        else stack.push(name);
      }
      expect(stack).toEqual([]);
      expect(telegramFormattedHtmlText(chunk).length).toBeLessThanOrEqual(3500);
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/u);
    }
    expect(chunks.join("")).not.toContain("**");
    expect(chunks.join("")).not.toContain("```");
    expect(chunks.map(telegramFormattedHtmlText).join("")).toContain("粗体<&𠮷".repeat(650));
    expect(chunks.map(telegramFormattedHtmlText).join("")).toContain("const x = '<&>';\n".repeat(149));
  });
});
