import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseOpenCodeGoPricingPage,
  runOpenCodeGoPricingProposal,
} from "../scripts/prepare-opencode-go-pricing-proposal.mjs";

describe("OpenCode Go pricing proposal", () => {
  it("maps the official Usage pricing table to endpoint model IDs", () => {
    expect(parseOpenCodeGoPricingPage(pricingPageFixture())).toEqual({
      schemaVersion: 1,
      source: "https://opencode.ai/docs/go/",
      sourceUpdatedAt: "2026-08-14T05:48:32.000Z",
      currency: "USD",
      unit: "per_million_tokens",
      models: {
        "deepseek-v4-flash": {
          endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
          aiSdkPackage: "@ai-sdk/openai-compatible",
          input: 0.14,
          output: 0.28,
          cachedRead: 0.0028,
          cachedWrite: null,
          includedUsageUsd: 60,
        },
        "qwen3.7-plus": {
          endpoint: "https://opencode.ai/zen/go/v1/messages",
          aiSdkPackage: "@ai-sdk/anthropic",
          tiers: [{
            maximumInputTokens: 256_000,
            input: 0.4,
            output: 1.6,
            cachedRead: 0.04,
            cachedWrite: 0.5,
          }, {
            maximumInputTokens: null,
            input: 1.2,
            output: 4.8,
            cachedRead: 0.12,
            cachedWrite: 1.5,
          }],
          includedUsageUsd: 60,
        },
      },
    });
  });

  it("rejects endpoint rows outside the official OpenCode Go API origin", () => {
    expect(() => parseOpenCodeGoPricingPage(
      pricingPageFixture().replace(
        "https://opencode.ai/zen/go/v1/chat/completions",
        "https://example.test/v1/chat/completions",
      ),
    )).toThrow("模型端点无效");
  });

  it("reports price changes and preserves the candidate baseline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-opencode-pricing-"));
    const baselinePath = join(directory, "baseline.json");
    const outputDirectory = join(directory, "report");
    writeFileSync(baselinePath, `${JSON.stringify(
      parseOpenCodeGoPricingPage(pricingPageFixture()),
    )}\n`);

    const result = await runOpenCodeGoPricingProposal({
      baselinePath,
      outputDirectory,
      download: async () => ({
        html: pricingPageFixture().replace("$0.28", "$0.29"),
        sha256: "a".repeat(64),
        etag: null,
        lastModified: null,
      }),
    });

    expect(result).toMatchObject({
      status: "success",
      changed: true,
      changedModels: ["deepseek-v4-flash"],
    });
    expect(readFileSync(join(outputDirectory, "candidate-baseline.json"), "utf8"))
      .toContain('"output": 0.29');
  });
});

function pricingPageFixture(): string {
  return `<!doctype html><html><body>
    <table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Usage</th></tr></thead><tbody>
      <tr><td>Qwen3.7 Plus (≤ 256K tokens)</td><td>$0.40</td><td>$1.60</td><td>$0.04</td><td>$0.50</td><td>$60</td></tr>
      <tr><td>Qwen3.7 Plus (> 256K tokens)</td><td>$1.20</td><td>$4.80</td><td>$0.12</td><td>$1.50</td><td>$60</td></tr>
      <tr><td>DeepSeek V4 Flash</td><td>$0.14</td><td>$0.28</td><td>$0.0028</td><td>-</td><td>$60</td></tr>
    </tbody></table>
    <table><thead><tr><th>Model</th><th>Model ID</th><th>Endpoint</th><th>AI SDK Package</th></tr></thead><tbody>
      <tr><td>Qwen3.7 Plus</td><td>qwen3.7-plus</td><td>https://opencode.ai/zen/go/v1/messages</td><td>@ai-sdk/anthropic</td></tr>
      <tr><td>DeepSeek V4 Flash</td><td>deepseek-v4-flash</td><td>https://opencode.ai/zen/go/v1/chat/completions</td><td>@ai-sdk/openai-compatible</td></tr>
    </tbody></table>
    <footer><time datetime="2026-08-14T05:48:32.000Z">Aug 14, 2026</time></footer>
  </body></html>`;
}
