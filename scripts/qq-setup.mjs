import { isDeepStrictEqual } from "node:util";

import {
  GatewayConfigWriteCommittedError,
  classifyQqConfigChanges,
  readGatewayConfig,
  validateGatewayConfigStructureDocument,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { ChannelSetupCancelled, createChannelPrompter, renderTerminalQRCode } from "./channel-setup-presentation.mjs";
import { registerQqApplication } from "./qq-registration.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

export async function runQqSetup({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  prompter,
  registerApplication = registerQqApplication,
  renderQRCode = renderTerminalQRCode,
} = {}) {
  const prompt = prompter ?? createChannelPrompter(input, output);
  try {
    output.write("\n通讯渠道 · QQ 接入\n\n");
    output.write("单聊仅允许独立名单；启用后允许用户的普通单聊文字会提交 Codex。QQ 仅支持单聊。\n");
    const mode = await prompt.select("选择 QQ 操作", [
      { value: "scan", label: "手机 QQ 扫码连接（推荐）", hint: "获取应用凭据和本次扫码用户 OpenID" },
      { value: "manual", label: "手工填写应用凭据和 OpenID" },
      { value: "bot-menu", label: "配置机器人常驻 Codex 菜单", hint: "复用已有凭据；全应用单聊生效，不改本机配置" },
      { value: "back", label: "返回" },
    ]);
    if (mode === "back") return undefined;
    if (mode === "bot-menu") {
      const { runQqMenuSetup } = await import("./qq-menu-setup.mjs");
      return await runQqMenuSetup({ environment, output, prompter: prompt });
    }
    if (mode !== "scan" && mode !== "manual") throw new Error("不支持的 QQ 接入方式");
    const { configPath } = requireUserConfig(environment);
    // 保留读取时的源修订，由现有原子写入器拒绝确认期间的任何并发修改。
    const document = readGatewayConfig(configPath);
    validateGatewayConfigStructureDocument(document);
    const initialDocument = structuredClone(document);
    let appId;
    let appSecret;
    let allowedUserOpenids;
    let enabled;
    if (mode === "scan") {
      output.write("扫码将通过腾讯官方 Connector 连接机器人；请在手机 QQ 页面确认机器人与授权。\n");
      output.write("此步骤直连 q.qq.com，不使用共享代理；最多等待五分钟，按 Esc/Ctrl+C 取消。\n");
      output.write("最终确认后替换应用凭据和单聊名单，仅授权本次扫码用户单聊。\n");
      output.write("取消本地保存不会撤销手机端已完成的授权。扫码完成不代表消息收发已验证。\n");
      if (!await prompt.confirm("开始 QQ 扫码连接？", true)) return undefined;
      const result = await scanQq({ input, output, registerApplication, renderQRCode });
      appId = result.appId;
      appSecret = result.appSecret;
      allowedUserOpenids = [result.userOpenid];
      validateGatewayConfigStructureDocument({ ...document, qq: {
        enabled: true, app_id: appId, app_secret: appSecret, allowed_user_openids: allowedUserOpenids,
      } });
      output.write("QQ 扫码已完成，已取得应用凭据与扫码用户身份（内容不回显）。\n");
    } else {
      output.write("手工方式不联网验证凭据；App Secret 输入隐藏。OpenID 不是 QQ 号码。\n");
      appId = await readField(prompt, output, "QQ App ID", "app_id", document);
      appSecret = await readField(prompt, output, "QQ App Secret", "app_secret", document, true);
    }
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
    enabled = await prompt.confirm("保存后启用 QQ 单聊文字渠道（普通文字会提交 Codex）？", false);
    document.qq = {
      enabled,
      app_id: appId,
      app_secret: appSecret,
      allowed_user_openids: allowedUserOpenids,
    };
    validateGatewayConfigStructureDocument(document);
    output.write("\n准备保存 QQ 配置（替换凭据和单聊允许名单）：\n");
    output.write(`- 状态：${enabled ? "启用" : "禁用"}\n`);
    output.write(`- 传输：WebSocket 单聊\n- 应用凭据：${mode === "scan" ? "扫码取得" : "已填写"}（内容已隐藏，收发尚未验证）\n`);
    output.write(`- 允许用户：${allowedUserOpenids.length} 个（内容已隐藏）\n`);
    if (allowedUserOpenids.length === 0) output.write("- 单聊空名单：拒绝所有单聊用户输入。\n");
    if (!await prompt.confirm("确认保存以上配置？", false)) {
      output.write("未保存 QQ 配置。\n");
      return undefined;
    }
    // 即使无变化，也先拒绝已过期确认；不把旧快照当成当前状态。
    // 与初始快照使用相同表示；TOML 解析器的空原型对象不是配置内容变化。
    // 实际写入仍使用 document 保留的源修订，由原子写入器检查文件变化。
    const current = structuredClone(readGatewayConfig(configPath));
    validateGatewayConfigStructureDocument(current);
    if (!isDeepStrictEqual(current, initialDocument)) {
      throw new Error("配置已变化，请重新开始 QQ 接入并确认。");
    }
    const unchanged = isDeepStrictEqual(current.qq, document.qq);
    if (unchanged) {
      output.write("QQ 配置未变化，未写入文件，无需重启。\n");
      writeVerificationSteps(output, enabled, allowedUserOpenids.length);
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
    const activation = changes.some(change => change.restart) ? "restart-gateway"
      : changes.length > 0 ? "reload" : "none";
    if (activation === "none") {
      output.write("QQ 配置已保存，运行配置未变化，无需热加载或重启。\n");
    } else {
      writeGatewayConfigActivationNotice(output, environment, configActivationResult(activation));
    }
    writeVerificationSteps(output, enabled, allowedUserOpenids.length);
    return {
      action: "configured", channel: "qq", configured: true, enabled, configPath,
      allowedUserCount: allowedUserOpenids.length,
      warnings, activation, activationResult: configActivationResult(activation),
    };
  } catch (error) {
    if (!(error instanceof ChannelSetupCancelled)) throw error;
    output.write("已取消 QQ 操作；已完成的手机授权或远程变更不会自动撤销。\n");
    return undefined;
  } finally {
    prompt.close();
  }
}

function writeVerificationSteps(output, enabled, allowedUserCount) {
  if (!enabled) {
    output.write("QQ 当前禁用；可通过渠道配置启用单聊文字任务。\n");
    return;
  }
  if (allowedUserCount === 0) {
    output.write("QQ 单聊当前没有允许用户；所有单聊输入均拒绝。\n");
  }
  output.write("下一步：按激活要求启动或重启 Gateway，用 codexc logs gateway -n 100 核对 QQ 连接状态。\n");
  output.write("先发送 /help、/workspace 和 /model 核对，再提交普通文字任务。连接就绪不代表任务送达；重启不恢复旧结果发送资格。\n");
}

async function scanQq({ input, output, registerApplication, renderQRCode }) {
  let renderError;
  try { return await withQqSetupCancellation(input, async (signal, cancel) => {
    const result = await registerApplication({
      signal,
      onQRCodeReady: url => {
        signal.throwIfAborted();
        output.write("\n请使用手机 QQ 扫描二维码，并在手机上完成连接：\n\n");
        try { renderQRCode(url, output); }
        catch (error) { renderError = error; cancel(); }
      },
      onQrExpired: () => output.write("二维码已过期，正在获取新的二维码。\n"),
    });
    signal.throwIfAborted();
    return result;
  }); } catch (error) {
    if (error?.code === "shutdown-failed") throw error;
    if (renderError) throw renderError;
    throw error;
  }
}

async function withQqSetupCancellation(input, run) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const wasRaw = input.isRaw === true;
  const wasPaused = input.isPaused?.() === true;
  const onData = chunk => {
    const value = chunk.toString();
    if (value.includes("\u0003") || value.includes("\u001b")) cancel();
  };
  process.once("SIGINT", cancel);
  try {
    if (input.isTTY && input.setRawMode) {
      input.setRawMode(true);
      input.on("data", onData);
      input.resume();
    }
    const result = await run(controller.signal, cancel);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (error?.code === "shutdown-failed" || error?.code === "cleanup_unconfirmed") throw error;
    if (controller.signal.aborted) throw new ChannelSetupCancelled();
    throw error;
  } finally {
    controller.abort();
    process.removeListener("SIGINT", cancel);
    input.removeListener("data", onData);
    if (input.isTTY && input.setRawMode) input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
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
