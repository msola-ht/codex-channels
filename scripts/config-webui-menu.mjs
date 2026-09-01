import {
  loadGatewaySettings,
  updateGatewaySetting,
} from "./config-management.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";

export async function runWebuiSettings({ environment, output, prompts, writeConfig }) {
  while (true) {
    const settings = loadGatewaySettings(environment);
    const webui = settings.webui;
    const section = await prompts.select({
      message: "选择 WebUI 设置",
      showInstructions: false,
      options: [
        { value: "host", label: "监听地址", hint: `当前：${webui.host}` },
        { value: "port", label: "监听端口", hint: `当前：${webui.port}` },
        {
          value: "token",
          label: "访问令牌",
          hint: webui.tokenConfigured ? "已设置（内容不显示）" : "未设置；绑定 0.0.0.0 时必须设置",
        },
        { value: "back", label: "返回", hint: "返回配置菜单" },
      ],
    });
    if (prompts.isCancel(section) || section === "back") return { action: "back" };
    let input;
    if (section === "host") {
      const selected = await prompts.select({
        message: "监听地址",
        showInstructions: false,
        initialValue: webui.host,
        options: [
          { value: "127.0.0.1", label: "仅本机", hint: "默认，最安全" },
          { value: "::1", label: "仅本机（IPv6 回环）", hint: "IPv6 环境使用" },
          { value: "0.0.0.0", label: "所有网卡", hint: "局域网/公网直连，必须设置令牌" },
          { value: "clear", label: "恢复默认", hint: "回到仅本机" },
        ],
      });
      if (prompts.isCancel(selected)) continue;
      let token;
      if (selected === "0.0.0.0" && !webui.tokenConfigured) {
        token = await prompts.password({ message: "绑定 0.0.0.0 必须设置访问令牌（留空取消）" });
        if (prompts.isCancel(token) || String(token).trim() === "") {
          output.write("未设置访问令牌，监听地址未修改。\n");
          continue;
        }
      }
      input = {
        kind: "webui.host",
        value: selected === "clear" ? null : selected,
        ...(token === undefined ? {} : { token: String(token).trim() }),
      };
    } else if (section === "port") {
      const value = await prompts.text({
        message: "监听端口（1–65535，默认 8787）",
        initialValue: String(webui.port),
      });
      if (prompts.isCancel(value)) continue;
      const port = Number(String(value).trim());
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        output.write("端口必须是 1 到 65535 的整数。\n");
        continue;
      }
      input = { kind: "webui.port", value: port };
    } else if (section === "token") {
      const action = await prompts.select({
        message: "访问令牌",
        showInstructions: false,
        options: [
          {
            value: "set",
            label: webui.tokenConfigured ? "重新设置令牌" : "设置令牌",
            hint: webui.tokenConfigured ? "替换现有令牌" : "绑定 0.0.0.0 时必须设置",
          },
          ...(webui.tokenConfigured
            ? [{ value: "clear", label: "清除令牌", hint: "清除后不能再绑定 0.0.0.0" }]
            : []),
          { value: "back", label: "返回上一级" },
        ],
      });
      if (prompts.isCancel(action) || action === "back") continue;
      if (action === "clear") {
        if (webui.host === "0.0.0.0") {
          output.write("绑定 0.0.0.0 时必须保留访问令牌，请先改回仅本机。\n");
          continue;
        }
        input = { kind: "webui.token", action: "clear" };
      } else if (action === "set") {
        const token = await prompts.password({ message: "输入访问令牌（留空取消）" });
        if (prompts.isCancel(token) || String(token).trim() === "") continue;
        input = { kind: "webui.token", action: "set", value: String(token).trim() };
      } else {
        throw new Error(`未知访问令牌操作：${String(action)}`);
      }
    } else {
      throw new Error(`未知 WebUI 设置：${String(section)}`);
    }
    const result = updateGatewaySetting(input, {
      environment,
      expectedRevision: settings.revision,
      writeConfig,
    });
    output.write(`WebUI 设置已更新：${result.configPath}\n`);
    writeGatewayConfigActivationNotice(
      output,
      environment,
      result.activationResult,
    );
    return { webui: result.value, configPath: result.configPath, activation: result.activation, activationResult: result.activationResult };
  }
}
