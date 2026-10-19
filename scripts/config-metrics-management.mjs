import { invalidSetting } from "./config-management-error.mjs";

/** document carries Schema defaults, or the fully validated metrics mutation. */
export function projectMetricsSettings(document) {
  const storage = document.metrics.storage;
  return {
    storage: {
      retentionDays: storage.retention_days,
      maxRows: storage.max_rows,
    },
  };
}

export function applyMetricsSetting(document, input) {
  if (!String(input.kind).startsWith("metrics.")) return undefined;
  if (input.kind !== "metrics.storage") {
    throw invalidSetting("kind", "unknown-setting", `未知指标设置：${String(input.kind)}`);
  }
  const metrics = { ...table(document.metrics) };
  metrics.storage = {
    retention_days: integer(input.retentionDays, 1, 3_650, "retentionDays", "指标保留天数"),
    max_rows: integer(input.maxRows, 1_000, 10_000_000, "maxRows", "指标最大行数"),
  };
  document.metrics = metrics;
  return {
    value: projectMetricsSettings(document),
    activation: "restart-gateway",
    backupRequired: false,
  };
}

function integer(value, minimum, maximum, field, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidSetting(field, "invalid-integer", `${label}必须为 ${minimum}–${maximum} 之间的整数`);
  }
  return value;
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
