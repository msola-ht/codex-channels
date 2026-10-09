import { colorizeCliText, formatCliStatus } from "../runtime/cli-presentation.mjs";

export function createDoctorReport(checks) {
  const counts = { success: 0, failure: 0, note: 0 };
  for (const check of checks) counts[check.kind] += 1;
  return {
    healthy: counts.failure === 0,
    counts,
    checks: checks.map((check) => ({
      section: check.section,
      kind: check.kind,
      name: check.name,
      detail: check.detail,
      remediation: check.remediation ?? null,
    })),
  };
}

export function renderDoctorText(report) {
  const renderer = createDoctorTextRenderer();
  return "Codex Connect Doctor\n"
    + report.checks.map((check) => renderer.renderCheck(check)).join("")
    + renderer.renderSummary(report);
}

export function createDoctorTextRenderer() {
  let renderedSection;
  return {
    renderCheck(check) {
      if (check.kind === "success") return "";
      const lines = [];
      if (check.section !== renderedSection) {
        renderedSection = check.section;
        lines.push(`\n=== ${renderedSection} ===`);
      }
      lines.push(formatCliStatus(check.kind, check.name, check.detail));
      if (check.remediation) {
        lines.push(formatCliStatus("remediation", check.name, check.remediation));
      }
      return `${lines.join("\n")}\n`;
    },
    renderSummary(report) {
      const { success, failure, note } = report.counts;
      const summary = report.healthy
        ? `诊断通过：${success} 项通过，${note} 项提示。`
        : `诊断发现 ${failure} 项问题：${success} 项通过，${note} 项提示。`;
      return `\n${colorizeCliText(report.healthy ? "success" : "failure", summary)}\n`;
    },
  };
}
