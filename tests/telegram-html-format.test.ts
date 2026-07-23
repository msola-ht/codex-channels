import { describe, expect, it } from "vitest";

import {
  escapeTelegramHtml,
  formatTelegramDiffChunks,
  formatTelegramPanelChunks,
} from "../src/surfaces/telegram/html-format.js";

describe("Telegram HTML formatter", () => {
  it("formats panels while escaping dynamic values", () => {
    expect(formatTelegramPanelChunks([
      "Codex 状态",
      "Workspace：main <unsafe>",
      "切换：/workspace <序号>",
      "- 可用项目",
      "  /Users/example/project",
    ].join("\n"))).toEqual([
      [
        "<b>Codex 状态</b>",
        "<b>Workspace：</b>main &lt;unsafe&gt;",
        "<b>切换：</b><code>/workspace &lt;序号&gt;</code>",
        "• 可用项目",
        "<code>/Users/example/project</code>",
      ].join("\n"),
    ]);
  });

  it("renders mirrored CLI input as one escaped blockquote", () => {
    expect(formatTelegramPanelChunks("CLI 输入\n\n│ echo <token>\n│ git status")).toEqual([
      "<b>CLI 输入</b>\n\n<blockquote>echo &lt;token&gt;\ngit status</blockquote>",
    ]);
  });

  it("preserves diff markers inside preformatted blocks", () => {
    expect(formatTelegramDiffChunks("Turn Diff · turn-1\n\n-old <value>\n+new & value")).toEqual([
      "<b>Turn Diff · turn-1</b>\n\n<pre>-old &lt;value&gt;\n+new &amp; value</pre>",
    ]);
  });

  it("escapes all Telegram HTML metacharacters", () => {
    expect(escapeTelegramHtml("<tag attr=\"x\"> & value"))
      .toBe("&lt;tag attr=&quot;x&quot;&gt; &amp; value");
  });
});
