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
  let sectionFailures = 0;
  function finishSection() {
    if (!renderedSection) return "";
    return `阶段完成（${renderedSection}）：${sectionFailures > 0 ? `发现 ${sectionFailures} 项问题` : "未发现失败项"}。\n`;
  }
  function renderSection(section) {
    if (section === renderedSection) return "";
    const previous = finishSection();
    renderedSection = section;
    sectionFailures = 0;
    return `${previous}\n=== ${section} ===\n正在检查：${section}\n`;
  }
  return {
    renderSection,
    renderCheck(check) {
      const heading = renderSection(check.section);
      if (check.kind === "failure") sectionFailures += 1;
      if (check.kind === "success") return heading;
      const lines = [];
      lines.push(formatCliStatus(check.kind, check.name, check.detail));
      if (check.remediation) {
        lines.push(formatCliStatus("remediation", check.name, check.remediation));
      }
      return `${heading}${lines.join("\n")}\n`;
    },
    renderSummary(report) {
      const { success, failure, note } = report.counts;
      const summary = report.healthy
        ? `诊断通过：${success} 项通过，${note} 项提示。`
        : `诊断发现 ${failure} 项问题：${success} 项通过，${note} 项提示。`;
      return `${finishSection()}\n${colorizeCliText(report.healthy ? "success" : "failure", summary)}\n`;
    },
  };
}
