import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  loadGatewaySettings,
  updateGatewaySetting,
} from "./config-management.mjs";

export async function runMetricsSettings({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const settings = loadGatewaySettings(environment);
  const storage = settings.metrics.storage;
  const retentionDays = await prompts.text({
    message: "本地指标保留天数（1–3650）",
    initialValue: String(storage.retentionDays),
    validate: (value) => boundedIntegerMessage(value, 1, 3_650),
  });
  if (prompts.isCancel(retentionDays)) return { action: "back" };
  const maxRows = await prompts.text({
    message: "本地指标最大行数（1000–10000000）",
    initialValue: String(storage.maxRows),
    validate: (value) => boundedIntegerMessage(value, 1_000, 10_000_000),
  });
  if (prompts.isCancel(maxRows)) return { action: "back" };
  const next = { retentionDays: Number(retentionDays), maxRows: Number(maxRows) };
  if (
    boundedIntegerMessage(next.retentionDays, 1, 3_650) !== undefined
    || boundedIntegerMessage(next.maxRows, 1_000, 10_000_000) !== undefined
  ) {
    throw new Error("本地指标保留策略无效");
  }
  const result = updateGatewaySetting({ kind: "metrics.storage", ...next }, {
    environment,
    expectedRevision: settings.revision,
    writeConfig,
  });
  output.write(`本地指标保留策略已更新：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  output.write("需要立即清理时运行 codexc metrics cleanup。\n");
  return {
    storage: { retention_days: next.retentionDays, max_rows: next.maxRows },
    configPath: result.configPath,
    activation: result.activation,
    activationResult: result.activationResult,
  };
}

function boundedIntegerMessage(value, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? undefined
    : `请输入 ${minimum}–${maximum} 之间的整数`;
}
