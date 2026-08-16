import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("OpenCode Go pricing proposal workflow", () => {
  it("keeps inspection read-only and draft proposal writes isolated", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/opencode-go-pricing-proposal.yml"),
      "utf8",
    );
    const proposalStart = workflow.indexOf("\n  propose:");
    const inspection = workflow.slice(0, proposalStart);
    const proposal = workflow.slice(proposalStart);

    expect(proposalStart).toBeGreaterThan(0);
    expect(inspection).toContain("permissions:\n  contents: read");
    expect(inspection).not.toContain("contents: write");
    expect(inspection).toContain("persist-credentials: false");
    expect(inspection).toContain("prepare-opencode-go-pricing-proposal.mjs");
    expect(proposal).toContain("contents: write\n      pull-requests: write");
    expect(proposal).toContain("gh pr create\n          --draft");
    expect(workflow).not.toContain("gh pr merge");
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("service restart");
  });
});
