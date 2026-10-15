export const metricsExportMaximumBytes = 64 * 1024 * 1024;
export const metricsExportChunkBytes = 64 * 1024;
export const metricsExportTimeoutMs = 120_000;
export const metricsExportInitializationMs = 15_000;
export const metricsExportShutdownMs = 5_000;
export const metricsExportMaximumConcurrent = 2;

const messages = {
  metrics_export_capacity: "指标导出超过 64 MiB，请缩小时间范围或增加筛选后重试",
  metrics_export_busy: "指标导出任务已达并发上限，请稍后重试",
  metrics_export_timeout: "指标导出超时，请缩小时间范围或增加筛选后重试",
  metrics_export_unavailable: "指标导出读取失败，请检查数据库状态",
  metrics_export_cancelled: "指标导出已取消",
  metrics_database_unavailable: "指标数据库尚未创建",
  metrics_database_incompatible: "指标数据库版本或结构不兼容；请核对数据库版本及备份，勿删除数据库",
};

export class MetricsExportError extends Error {
  constructor(code) {
    super(messages[code] ?? messages.metrics_export_unavailable);
    this.code = Object.hasOwn(messages, code) ? code : "metrics_export_unavailable";
  }
}
