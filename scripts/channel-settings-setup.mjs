import { ChannelSetupCancelled, createChannelPrompter } from "./channel-setup-presentation.mjs";
import { loadGatewaySettings, updateGatewaySetting } from "./config-management.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";

export async function runChannelSettingsSetup({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  prompter,
} = {}) {
  const prompt = prompter ?? createChannelPrompter(input, output);
  try {
    const settings = loadGatewaySettings(environment);
    if (settings.channels.length === 0) {
      output.write("尚未配置通讯渠道，请先选择 Telegram、飞书、微信或 QQ 完成接入。\n");
      return { action: "back" };
    }
    const channel = await prompt.select("启用／停用通讯渠道（配置状态）", [
      ...settings.channels.map(entry => ({
        value: entry.id,
        label: `${entry.displayName} · ${entry.enabled ? "已启用" : "未启用"}`,
      })),
      { value: "back", label: "返回" },
    ]);
    if (channel === "back") return { action: "back" };
    const state = settings.channels.find(entry => entry.id === channel);
    if (!state) throw new Error("未知通讯渠道");
    const value = !state.enabled;
    output.write(`${state.displayName}：${state.enabled ? "已启用 → 停用" : "未启用 → 启用"}\n`
      + "保留已有凭据和授权名单；仅改变该渠道的消息收发开关。\n"
      + "需要重建 Gateway 连接，会短暂中断其他渠道连接；不会停止 App Server。\n");
    if (channel === "telegram" && value) output.write("恢复 Telegram 后可能收到并处理平台保留的积压消息。\n");
    if (!await prompt.confirm(`确认${value ? "启用" : "停用"} ${state.displayName}？`, false)) {
      return { action: "back" };
    }
    const result = updateGatewaySetting({ kind: "channel.enabled", channel, value }, {
      environment, expectedRevision: settings.revision,
    });
    writeGatewayConfigActivationNotice(output, environment, result.activationResult);
    return { ...result, action: "configured", channel };
  } catch (error) {
    if (error instanceof ChannelSetupCancelled) return { action: "back" };
    throw error;
  } finally {
    prompt.close();
  }
}
