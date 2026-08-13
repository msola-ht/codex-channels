import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  downloadDeepseekPricingPage,
  parseDeepseekPricingPage,
  runDeepseekPricingProposal,
} from "../scripts/prepare-deepseek-pricing-proposal.mjs";

const sourceUpdatedAt = "2026-08-13T10:49:16.000Z";

describe("DeepSeek pricing proposal", () => {
  it("parses semantic tables independently of table order and nested markup", () => {
    const parsed = parseDeepseekPricingPage(pricingPageFixture(), sourceUpdatedAt);

    expect(parsed).toEqual(JSON.parse(readFileSync(
      join(process.cwd(), "runtime/deepseek-pricing-baseline.json"),
      "utf8",
    )));
  });

  it("reports an unchanged reviewed price baseline", async () => {
    const directory = temporaryDirectory("unchanged");
    const baselinePath = join(directory, "baseline.json");
    const outputDirectory = join(directory, "report");
    writeFileSync(
      baselinePath,
      readFileSync(join(process.cwd(), "runtime/deepseek-pricing-baseline.json")),
    );

    const result = await runDeepseekPricingProposal({
      baselinePath,
      outputDirectory,
      download: async () => ({
        html: pricingPageFixture(),
        sha256: "a".repeat(64),
        etag: "pricing-v1",
        lastModified: sourceUpdatedAt,
      }),
    });

    expect(result).toMatchObject({
      status: "success",
      changed: false,
      scheduleChanged: false,
      changedModels: [],
    });
    expect(readFileSync(join(outputDirectory, "summary.md"), "utf8"))
      .toContain("没有变化");
  });

  it("detects a model price change without treating metadata as a price change", async () => {
    const directory = temporaryDirectory("changed");
    const baselinePath = join(directory, "baseline.json");
    const outputDirectory = join(directory, "report");
    writeFileSync(
      baselinePath,
      readFileSync(join(process.cwd(), "runtime/deepseek-pricing-baseline.json")),
    );

    const result = await runDeepseekPricingProposal({
      baselinePath,
      outputDirectory,
      download: async () => ({
        html: pricingPageFixture().replace("27.0元", "28.0元"),
        sha256: "b".repeat(64),
        etag: "pricing-v2",
        lastModified: "2026-08-14T10:49:16.000Z",
      }),
    });

    expect(result).toMatchObject({
      changed: true,
      scheduleChanged: false,
      changedModels: ["deepseek-v4-pro"],
    });
    expect(existsSync(join(outputDirectory, "candidate-baseline.json"))).toBe(true);
  });

  it("fails closed on missing labels and preserves a failure report", async () => {
    const directory = temporaryDirectory("failure");
    const baselinePath = join(directory, "baseline.json");
    const outputDirectory = join(directory, "report");
    writeFileSync(
      baselinePath,
      readFileSync(join(process.cwd(), "runtime/deepseek-pricing-baseline.json")),
    );

    await expect(runDeepseekPricingProposal({
      baselinePath,
      outputDirectory,
      download: async () => ({
        html: pricingPageFixture().replace("百万tokens输出", "输出价格"),
        sha256: "c".repeat(64),
        etag: null,
        lastModified: sourceUpdatedAt,
      }),
    })).rejects.toThrow("价格表表头无效");

    expect(JSON.parse(readFileSync(join(outputDirectory, "result.json"), "utf8")))
      .toMatchObject({ status: "failure", changed: false });
    expect(existsSync(join(outputDirectory, "candidate-baseline.json"))).toBe(false);
  });

  it("bounds and validates the official HTML download", async () => {
    const fetchImpl = async () => new Response(pricingPageFixture(), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "last-modified": "Thu, 13 Aug 2026 10:49:16 GMT",
        etag: "pricing-v1",
      },
    });

    await expect(downloadDeepseekPricingPage(fetchImpl)).resolves.toMatchObject({
      etag: "pricing-v1",
      lastModified: sourceUpdatedAt,
    });
    await expect(downloadDeepseekPricingPage(async () => new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "last-modified": "Thu, 13 Aug 2026 10:49:16 GMT",
      },
    }))).rejects.toThrow("响应类型不是 HTML");
  });
});

function pricingPageFixture(): string {
  return `<!doctype html><html><body>
    <table>
      <tr><td>模型</td><td>百万tokens输入（缓存命中）</td><td>百万tokens输入（缓存未命中）</td><td>百万tokens输出</td></tr>
      <tr><td rowspan="2">deepseek-v4-flash</td><td>空闲时段</td><td>0.05元</td><td>1.5元</td><td>4.5元</td></tr>
      <tr><td>高峰时段</td><td>0.10元</td><td>3.0元</td><td>9.0元</td></tr>
      <tr><td rowspan="2">deepseek-v4-pro</td><td>空闲时段</td><td>0.15元</td><td>4.5元</td><td>13.5元</td></tr>
      <tr><td>高峰时段</td><td>0.30元</td><td>9.0元</td><td>27.0元</td></tr>
    </table>
    <p>我们将采用峰谷定价。高峰时段为北京时间 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。新价格将于北京时间 2026 年 8 月 17 日 00:00 开始生效。</p>
    <table>
      <tr><td colspan="2"><strong>模型</strong></td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td></tr>
      <tr><td rowspan="3">价格<sup>(1)</sup></td><td>百万tokens输入（缓存命中）</td><td>0.02元</td><td>0.025元</td></tr>
      <tr><td>百万tokens输入（缓存未命中）</td><td>1元</td><td>3元</td></tr>
      <tr><td>百万tokens输出</td><td>2元</td><td>6元</td></tr>
    </table>
  </body></html>`;
}

function temporaryDirectory(suffix: string): string {
  return mkdtempSync(join(tmpdir(), `codexc-deepseek-pricing-${suffix}-`));
}
