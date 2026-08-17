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
      schemaVersion: 2,
      source: "https://opencode.ai/docs/go/",
      sourceUpdatedAt: "2026-08-14T05:48:32.000Z",
      currency: "USD",
      unit: "per_million_tokens",
      timezone: "UTC",
      peakHours: ["01:00-04:00", "06:00-10:00"],
      models: {
        "deepseek-v4-flash": {
          endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
          aiSdkPackage: "@ai-sdk/openai-compatible",
          peakOffPeak: {
            offPeak: {
              input: 0.22,
              output: 0.66,
              cachedRead: 0.007,
              cachedWrite: null,
            },
            peak: {
              input: 0.44,
              output: 1.32,
              cachedRead: 0.014,
              cachedWrite: null,
            },
          },
          includedUsageUsd: 15,
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

  it("fails closed when Peak/Off-Peak rows are incomplete", () => {
    expect(() => parseOpenCodeGoPricingPage(
      pricingPageFixture().replace(
        "<tr><td>DeepSeek V4 Flash (Peak)</td><td>$0.44</td><td>$1.32</td><td>$0.014</td><td>-</td><td>$15</td></tr>",
        "",
      ),
    )).toThrow("缺少完整峰谷档位");
  });

  it("fails closed when the official Peak hour description is missing", () => {
    expect(() => parseOpenCodeGoPricingPage(
      pricingPageFixture().replace(
        "<p><strong>DeepSeek V4 Flash / Pro:</strong> Peak hours are 01:00-04:00 and 06:00-10:00 UTC.</p>",
        "",
      ),
    )).toThrow("缺少 Peak 时段说明");
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
        html: pricingPageFixture().replace("$0.66", "$0.67"),
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
      .toContain('"output": 0.67');
  });
});

function pricingPageFixture(): string {
  return `<!doctype html><html><body>
    <table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Usage</th></tr></thead><tbody>
      <tr><td>Qwen3.7 Plus (≤ 256K tokens)</td><td>$0.40</td><td>$1.60</td><td>$0.04</td><td>$0.50</td><td>$60</td></tr>
      <tr><td>Qwen3.7 Plus (> 256K tokens)</td><td>$1.20</td><td>$4.80</td><td>$0.12</td><td>$1.50</td><td>$60</td></tr>
      <tr><td>DeepSeek V4 Flash (Off-Peak)</td><td>$0.22</td><td>$0.66</td><td>$0.007</td><td>-</td><td>$15</td></tr>
      <tr><td>DeepSeek V4 Flash (Peak)</td><td>$0.44</td><td>$1.32</td><td>$0.014</td><td>-</td><td>$15</td></tr>
    </tbody></table>
    <table><thead><tr><th>Model</th><th>Model ID</th><th>Endpoint</th><th>AI SDK Package</th></tr></thead><tbody>
      <tr><td>Qwen3.7 Plus</td><td>qwen3.7-plus</td><td>https://opencode.ai/zen/go/v1/messages</td><td>@ai-sdk/anthropic</td></tr>
      <tr><td>DeepSeek V4 Flash</td><td>deepseek-v4-flash</td><td>https://opencode.ai/zen/go/v1/chat/completions</td><td>@ai-sdk/openai-compatible</td></tr>
    </tbody></table>
    <p><strong>DeepSeek V4 Flash / Pro:</strong> Peak hours are 01:00-04:00 and 06:00-10:00 UTC.</p>
    <footer><time datetime="2026-08-14T05:48:32.000Z">Aug 14, 2026</time></footer>
  </body></html>`;
}
