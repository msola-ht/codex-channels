import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  loadGatewaySettings,
  updateGatewaySetting,
} from "./config-management.mjs";

export const loggingLevels = Object.freeze([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]);

export function writeLoggingLevel({
  environment = process.env,
  expectedRevision,
  output = process.stdout,
  writeConfig = writeGatewayConfig,
  level,
  message = `日志等级已设为 ${level}`,
}) {
  if (!loggingLevels.includes(level)) {
    throw new Error(`未知日志等级：${String(level)}`);
  }
  const result = updateGatewaySetting({
    kind: "advanced.logging-level",
    value: level,
  }, {
    environment,
    expectedRevision: expectedRevision ?? loadGatewaySettings(environment).revision,
    writeConfig,
  });
  output.write(`${message}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return {
    level,
    configPath: result.configPath,
    activation: result.activation,
    activationResult: result.activationResult,
  };
}
