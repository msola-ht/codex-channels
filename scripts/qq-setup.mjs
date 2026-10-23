import { isDeepStrictEqual } from "node:util";

import {
  GatewayConfigWriteCommittedError,
  classifyQqConfigChanges,
  readGatewayConfig,
  validateGatewayConfigStructureDocument,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { ChannelSetupCancelled, createChannelPrompter } from "./channel-setup-presentation.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

export async function runQqSetup({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  prompter,
} = {}) {
  const prompt = prompter ?? createChannelPrompter(input, output);
  try {
    const { configPath } = requireUserConfig(environment);
    // 保留读取时的源修订，由现有原子写入器拒绝确认期间的任何并发修改。
    const document = readGatewayConfig(configPath);
    validateGatewayConfigStructureDocument(document);
    const initialDocument = structuredClone(document);
    output.write("\n通讯渠道 · QQ 接入\n\n");
    output.write("仅支持手工应用凭据与 WebSocket 单聊；请先在 QQ 开放平台配置机器人。\n");
    output.write("本向导不联网验证凭据、不扫码、不连接 QQ、不发送消息。App Secret 输入隐藏。\n");
    const appId = await readField(prompt, output, "QQ App ID", "app_id", document);
    const appSecret = await readField(prompt, output, "QQ App Secret", "app_secret", document, true);
    let allowedUserOpenids;
    while (!allowedUserOpenids) {
      const entered = await prompt.ask("允许的单聊用户 OpenID（英文逗号分隔；留空拒绝所有用户）");
      const values = entered.trim() === "" ? [] : entered.split(",").map(value => value.trim());
      if (values.some((value) => value.length === 0)) {
        output.write("逗号分隔的 OpenID 不能包含空项；完全留空表示拒绝所有用户。\n");
        continue;
      }
      try {
        validateGatewayConfigStructureDocument({
          ...document,
          qq: { enabled: false, allowed_user_openids: values },
        });
        allowedUserOpenids = values;
      } catch {
        output.write("OpenID 格式无效：不能重复或包含空白、逗号、分号及控制字符。\n");
      }
    }
    const enabled = await prompt.confirm("保存后启用 QQ 消息接收？", false);
    document.qq = {
      enabled,
      app_id: appId,
      app_secret: appSecret,
      allowed_user_openids: allowedUserOpenids,
    };
    validateGatewayConfigStructureDocument(document);
    output.write("\n准备保存 QQ 配置（完整替换此应用的凭据和允许名单）：\n");
    output.write(`- 状态：${enabled ? "启用" : "禁用"}\n`);
    output.write("- 传输：WebSocket 单聊\n- 应用凭据：已填写（内容已隐藏，未联网验证）\n");
    output.write(`- 允许用户：${allowedUserOpenids.length} 个（内容已隐藏）\n`);
    if (allowedUserOpenids.length === 0) output.write("- 空名单：拒绝所有用户输入。\n");
    if (!await prompt.confirm("确认保存以上配置？", false)) {
      output.write("未保存 QQ 配置。\n");
      return undefined;
    }
    // 即使无变化，也先拒绝已过期确认；不把旧快照当成当前状态。
    const current = readGatewayConfig(configPath);
    validateGatewayConfigStructureDocument(current);
    if (!isDeepStrictEqual(current, initialDocument)) {
      throw new Error("配置已变化，请重新开始 QQ 接入并确认。");
    }
    const unchanged = isDeepStrictEqual(current.qq, document.qq);
    if (unchanged) {
      output.write("QQ 配置未变化，未写入文件，无需重启。\n");
      return {
        action: "unchanged", channel: "qq", configured: true, enabled,
        allowedUserCount: allowedUserOpenids.length,
        activation: "none", activationResult: configActivationResult("none"),
      };
    }
    const warnings = [];
    try {
      // 同步提交开始后等待实际保存结果；不把取消解释为已回滚。
      writeGatewayConfig(configPath, document);
    } catch (error) {
      if (!(error instanceof GatewayConfigWriteCommittedError)) throw error;
      warnings.push({ code: "gateway-config-cleanup-failed" });
    }
    output.write(`\nQQ 配置已保存：${configPath}\n`);
    if (warnings.length > 0) output.write("配置已保存，但保存后清理失败；请核对配置与锁状态，勿重复保存。\n");
    output.write("QQ 账号能力尚未验证；运行 codexc doctor 查看只读配置状态。\n");
    const runtimeAccount = value => value?.enabled === true ? {
      appId: value.app_id, appSecret: value.app_secret, allowedUserOpenIds: value.allowed_user_openids,
    } : undefined;
    const changes = classifyQqConfigChanges(runtimeAccount(initialDocument.qq), runtimeAccount(document.qq));
    const activation = changes.some(change => change.restart) ? "restart-gateway" : "reload";
    writeGatewayConfigActivationNotice(output, environment, configActivationResult(activation));
    return {
      action: "configured", channel: "qq", configured: true, enabled, configPath,
      allowedUserCount: allowedUserOpenids.length,
      warnings, activation, activationResult: configActivationResult(activation),
    };
  } catch (error) {
    if (!(error instanceof ChannelSetupCancelled)) throw error;
    output.write("已取消 QQ 接入，未保存配置。\n");
    return undefined;
  } finally {
    prompt.close();
  }
}

async function readField(prompt, output, message, field, document, secret = false) {
  while (true) {
    const value = secret ? await prompt.secret(message) : await prompt.ask(message);
    try {
      validateGatewayConfigStructureDocument({ ...document, qq: { enabled: false, [field]: value } });
      return value;
    } catch {
      output.write(field === "app_id"
        ? "App ID 必须是 QQ 应用的数字标识。\n"
        : "App Secret 不能为空或包含空白、控制字符。\n");
    }
  }
}
