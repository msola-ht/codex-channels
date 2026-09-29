import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { parseGatewayConfig, validateGatewayConfigDocument, withGatewayConfigLock, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { assertPrivateConfigAccessSync, readPrivateFileSync, securePrivateFileSync } from "../runtime/private-file.mjs";
import { modelRelayConfigDigest, modelRelayConfigSchema } from "../runtime/model-relay-config.mjs";
import { loadConfiguredChatProviderMaterial } from "../runtime/model-provider-runtime.mjs";
import { modelRelayPaths } from "../runtime/model-relay-paths.mjs";
import { queryModelRelayControl } from "../runtime/model-relay-control.mjs";
import { locateUserConfig } from "./runtime-config.mjs";
import { isCommandHelp } from "./cli-help.mjs";

export const modelRelayUsage = `用法：codexc relay <命令>
  status                         查询进程、监听与指标确认状态
  callers                        列出调用方（不显示秘密或哈希）
  issue --caller ID --key ID --provider clp-ID --model ID [--model ID]
  rotate --caller ID             轮换并启用新秘密，保留身份
  disable [--caller ID]           禁用调用方；省略 caller 则禁用服务
  enable                         启用服务配置（安装与启动通过 service）
所有命令支持 -h/--help；新秘密仅在成功保存后输出一次。`;

export function parseModelRelayCommand(args) {
  const [command, ...rest] = args;
  const commands = ["status", "callers", "issue", "rotate", "disable", "enable"];
  if (!commands.includes(command)) throw new Error(modelRelayUsage);
  const allowed = command === "issue" ? ["--caller", "--key", "--provider", "--model"]
    : ["rotate", "disable"].includes(command) ? ["--caller"] : [];
  const options = { models: [] };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!allowed.includes(flag) || !value || value.startsWith("--")) throw new Error(modelRelayUsage);
    if (flag === "--model") options.models.push(value);
    else {
      const key = flag.slice(2);
      if (options[key] !== undefined) throw new Error("Relay 参数不能重复");
      options[key] = value;
    }
  }
  if (command === "issue" && (!options.caller || !options.key || !options.provider || !options.models.length)
    || command === "rotate" && !options.caller) throw new Error(modelRelayUsage);
  return { command, ...options };
}

/** Explicit configuration transaction; service activation occurs only after atomic save. */
export async function manageModelRelay(input, environment = process.env) {
  if (!["status", "callers", "issue", "rotate", "disable", "enable"].includes(input.command)) throw new Error(modelRelayUsage);
  const { configPath } = locateUserConfig(environment);
  const endpoint = modelRelayPaths(configPath).control;
  if (input.command === "status") return { ...await queryModelRelayControl(endpoint, "status"),
    metricsNotice: "指标计数仅覆盖当前进程；accepted 仅表示接收队列确认，unconfirmed 可能已落盘，崩溃后的计数与样本不完整。" };
  assertPrivateConfigAccessSync(configPath);
  if (input.command === "callers") {
    const document = validateGatewayConfigDocument(parseGatewayConfig(readPrivateFileSync(configPath, 1024 * 1024)));
    return { callers: (document.model_relay?.callers ?? []).map(({ caller_id, key_id, credential_generation, enabled, provider, models }) =>
      ({ caller_id, key_id, credential_generation, enabled, provider, models })) };
  }
  let secret;
  const result = withGatewayConfigLock(configPath, () => {
    assertPrivateConfigAccessSync(configPath);
    const content = readPrivateFileSync(configPath, 1024 * 1024);
    const document = parseGatewayConfig(content);
    const validated = validateGatewayConfigDocument(document);
    const config = structuredClone(validated.model_relay ?? modelRelayConfigSchema.parse({}));
    const previous = modelRelayConfigDigest(config);
    if (input.command === "issue") {
      if (config.callers.some(caller => caller.caller_id === input.caller || caller.key_id === input.key)) throw new Error("Relay 身份已存在，包含停用记录；不能重复使用");
      const material = loadConfiguredChatProviderMaterial(input.provider, environment);
      if (input.models.some(model => !material.models.includes(model))) throw new Error("Relay 模型不在账户目录中");
      if (!config.accounts.some(account => account.provider === input.provider)) config.accounts.push({ provider: input.provider, max_concurrency: 4, requests_per_minute: 30, burst: 4 });
      const bytes = randomBytes(32); secret = `cr1.${input.key}.${bytes.toString("base64url")}`;
      config.callers.push({ caller_id: input.caller, key_id: input.key, credential_generation: 1,
        secret_sha256: createHash("sha256").update(bytes).digest("hex"), enabled: true, provider: input.provider, models: input.models,
        max_concurrency: 2, requests_per_minute: 10, burst: 2 });
    } else if (input.command === "rotate" || input.command === "disable" && input.caller) {
      const caller = config.callers.find(value => value.caller_id === input.caller);
      if (!caller) throw new Error("Relay 调用方不存在");
      if (input.command === "disable") caller.enabled = false;
      else {
        if (caller.credential_generation >= Number.MAX_SAFE_INTEGER) throw new Error("Relay 凭据代次已耗尽");
        const bytes = randomBytes(32); secret = `cr1.${caller.key_id}.${bytes.toString("base64url")}`;
        caller.secret_sha256 = createHash("sha256").update(bytes).digest("hex"); caller.credential_generation++; caller.enabled = true;
      }
    } else config.enabled = input.command === "enable";
    document.model_relay = modelRelayConfigSchema.parse(config);
    validateGatewayConfigDocument(document);
    const digest = modelRelayConfigDigest(document.model_relay);
    let backupPath = null;
    if (previous !== digest || validated.model_relay === undefined) {
      backupPath = `${configPath}.relay-${randomUUID()}.bak`;
      const descriptor = openSync(backupPath, "wx", 0o600);
      try { securePrivateFileSync(backupPath); writeFileSync(descriptor, content); fsyncSync(descriptor); }
      finally { closeSync(descriptor); }
      if (readPrivateFileSync(backupPath, 1024 * 1024) !== content) throw new Error("Relay 配置备份校验失败");
      writeGatewayConfig(configPath, document);
    }
    return { digest, backupPath };
  });
  const response = await queryModelRelayControl(endpoint, "apply", result.digest);
  const activation = response.result === "applied" ? "saved_and_applied" : response.result === "not_running" ? "saved_not_running" : "saved_unconfirmed";
  return { activation, backupPath: result.backupPath, ...(secret === undefined ? {} : { key: secret }),
    ...(activation === "saved_unconfirmed" ? { recovery: "生效未确认；需要立即停止入口时执行 codexc service stop model-relay。不会撤销已保存的禁用。" } : {}) };
}

export async function runModelRelayCommand(args) {
  if (!args.length || isCommandHelp(args, [[], ...["status", "callers", "issue", "rotate", "disable", "enable"].map(command => [command])], modelRelayUsage)) { console.log(modelRelayUsage); return; }
  const input = parseModelRelayCommand(args);
  console.log(JSON.stringify(await manageModelRelay(input), null, 2));
}
