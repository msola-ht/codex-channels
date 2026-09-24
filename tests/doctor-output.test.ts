import { describe, expect, it } from "vitest";

import { createDoctorReport, renderDoctorText } from "../scripts/doctor-output.mjs";

describe("Doctor output", () => {
  it("counts all checks while hiding successful sections from text output", () => {
    const report = createDoctorReport([
      { section: "基础环境", kind: "success", name: "Node.js", detail: "版本符合要求" },
      { section: "网络与代理", kind: "note", name: "代理", detail: "未配置" },
      { section: "通讯渠道", kind: "failure", name: "渠道", detail: "未配置", remediation: "运行 codexc setup" },
    ]);
    expect(report.healthy).toBe(false);
    expect(report.counts).toEqual({ success: 1, failure: 1, note: 1 });
    expect(report.checks[0]?.remediation).toBeNull();
    const text = renderDoctorText(report);
    expect(text).not.toContain("=== 基础环境 ===");
    expect(text.indexOf("=== 网络与代理 ===")).toBeLessThan(text.indexOf("=== 通讯渠道 ==="));
    expect(text).toContain("运行 codexc setup");
    expect(text).toContain("诊断发现 1 项问题：1 项通过，1 项提示。");
  });

  it("keeps JSON fields explicit and renders a healthy summary", () => {
    const check = {
      section: "基础环境",
      kind: "success" as const,
      name: "Node.js",
      detail: "版本符合要求",
      internal: "must-not-be-serialized",
    };
    const report = createDoctorReport([check]);
    expect(report).toEqual({
      healthy: true,
      counts: { success: 1, failure: 0, note: 0 },
      checks: [{ section: check.section, kind: check.kind, name: check.name, detail: check.detail, remediation: null }],
    });
    expect(renderDoctorText(report)).toContain("诊断通过：1 项通过，0 项提示。");
    expect(JSON.stringify(report)).not.toContain(check.internal);
  });
});
