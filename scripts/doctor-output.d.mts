export interface DoctorCheck {
  section: string;
  kind: "success" | "failure" | "note";
  name: string;
  detail: string;
  remediation?: string | null;
}

export interface DoctorReport {
  healthy: boolean;
  counts: Record<DoctorCheck["kind"], number>;
  checks: Array<DoctorCheck & { remediation: string | null }>;
}

export function createDoctorReport(checks: readonly DoctorCheck[]): DoctorReport;
export function renderDoctorText(report: DoctorReport): string;
