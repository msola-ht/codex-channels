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

  it("keeps breathing room inside sections and separates workspace cards", () => {
    expect(formatTelegramPanelChunks([
      "运行环境：",
      "│ macOS · arm64",
      "│ ",
      "│ Node.js v24",
      "",
      "Workspace（2）：",
      "│ 1. Home",
      "│ /Users/example",
      "",
      "│ 2. Project ← 当前",
      "│ /workspace/project",
    ].join("\n"))).toEqual([
      [
        "<b>运行环境：</b>",
        "<blockquote>macOS · arm64\n\nNode.js v24</blockquote>",
        "",
        "<b>Workspace（2）：</b>",
        "<blockquote>1. Home\n/Users/example</blockquote>",
        "",
        "<blockquote>2. Project ← 当前\n/workspace/project</blockquote>",
      ].join("\n"),
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
