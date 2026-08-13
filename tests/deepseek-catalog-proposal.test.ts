import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeDeepseekCatalog,
  runDeepseekCatalogProposal,
} from "../scripts/prepare-deepseek-catalog-proposal.mjs";

describe("DeepSeek catalog proposal", () => {
  it("keeps inspection read-only and isolates draft PR write permissions", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/deepseek-catalog-proposal.yml"),
      "utf8",
    );
    const proposalStart = workflow.indexOf("\n  propose:");
    expect(proposalStart).toBeGreaterThan(0);
    const inspection = workflow.slice(0, proposalStart);
    const proposal = workflow.slice(proposalStart);

    expect(inspection).toContain("permissions:\n  contents: read");
    expect(inspection).not.toContain("contents: write");
    expect(inspection).toContain("persist-credentials: false");
    expect(proposal).toContain("contents: write\n      pull-requests: write");
    expect(proposal).toContain("gh pr create\n          --draft");
    expect(workflow).not.toContain("gh pr merge");
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("service restart");
  });

  it("reports an unchanged normalized official catalog", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-deepseek-proposal-"));
    const baselinePath = join(directory, "baseline.json");
    const outputDirectory = join(directory, "report");
    const catalog = fixtureCatalog();
    writeFileSync(baselinePath, `${JSON.stringify(normalizeDeepseekCatalog(catalog))}\n`);

    const result = await runDeepseekCatalogProposal({
      baselinePath,
      outputDirectory,
      download: async () => ({ catalog, sha256: "a".repeat(64) }),
    });

    expect(result).toMatchObject({
      status: "success",
      changed: false,
      added: [],
      removed: [],
      modified: [],
    });
    expect(readFileSync(join(outputDirectory, "summary.md"), "utf8"))
      .toContain("没有变化");
  });

  it("detects changes outside the displayed review fields by full model digest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-deepseek-proposal-change-"));
    const baselinePath = join(directory, "baseline.json");
    const outputDirectory = join(directory, "report");
    const catalog = fixtureCatalog();
    writeFileSync(baselinePath, `${JSON.stringify(normalizeDeepseekCatalog(catalog))}\n`);
    const changedCatalog = structuredClone(catalog);
    Object.assign(changedCatalog.models[0]!, { upstream_internal_parameter: true });

    const result = await runDeepseekCatalogProposal({
      baselinePath,
      outputDirectory,
      download: async () => ({ catalog: changedCatalog, sha256: "b".repeat(64) }),
    });

    expect(result).toMatchObject({
      status: "success",
      changed: true,
      modified: ["deepseek-v4-pro"],
    });
    expect(existsSync(join(outputDirectory, "candidate-baseline.json"))).toBe(true);
  });

  it("keeps a failure report when the official download cannot be resolved", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-deepseek-proposal-failure-"));
    const baselinePath = join(directory, "baseline.json");
    const outputDirectory = join(directory, "report");
    writeFileSync(
      baselinePath,
      `${JSON.stringify(normalizeDeepseekCatalog(fixtureCatalog()))}\n`,
    );

    await expect(runDeepseekCatalogProposal({
      baselinePath,
      outputDirectory,
      download: async () => { throw new Error("官方目录网络请求失败"); },
    })).rejects.toThrow("官方目录网络请求失败");

    expect(JSON.parse(readFileSync(join(outputDirectory, "result.json"), "utf8")))
      .toMatchObject({ status: "failure", changed: false });
    expect(readFileSync(join(outputDirectory, "summary.md"), "utf8"))
      .toContain("未创建候选基线或 Draft PR");
    expect(existsSync(join(outputDirectory, "candidate-baseline.json"))).toBe(false);
  });
});

function fixtureCatalog() {
  return {
    models: [{
      slug: "deepseek-v4-pro",
      display_name: "DeepSeek-V4-Pro",
      description: "Most capable frontier agentic coding model.",
      context_window: 1_048_576,
      max_context_window: 1_048_576,
      effective_context_window_percent: 95,
      input_modalities: ["text"],
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "high", description: "Deep" },
      ],
      visibility: "list",
      minimal_client_version: "0.144.0",
      supported_in_api: true,
      supports_search_tool: true,
      supports_parallel_tool_calls: true,
      multi_agent_version: "v2",
    }],
  };
}
