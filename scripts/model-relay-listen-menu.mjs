import * as clackPrompts from "@clack/prompts";
import { isRelayListenHost } from "../runtime/model-relay-listen-host.mjs";
import { manageModelRelay, readRelayListener } from "./model-relay-management.mjs";

export async function runRelayListenMenu({ environment = process.env, output = process.stdout, prompts = clackPrompts } = {}) {
  const current = readRelayListener(environment);
  const mode = await prompts.select({ message: `模型转发监听（当前 ${current.enabled ? "启用" : "关闭"}，${current.host}:${current.port}）`,
    showInstructions: false, initialValue: !current.enabled ? "disabled" : current.host === "0.0.0.0" ? "lan" : ["127.0.0.1", "::1"].includes(current.host) ? "local" : "custom",
    options: [
      { value: "disabled", label: "关闭模型转发", hint: "停止接收请求，保留 Key 和监听地址" },
      { value: "local", label: "开启：仅本机", hint: "127.0.0.1" },
      { value: "lan", label: "开启：局域网", hint: "0.0.0.0，所有 IPv4 网卡；防火墙应仅允许内网" },
      { value: "custom", label: "开启：指定内网 IP", hint: "绑定服务器的一张 IPv4 内网网卡" },
      { value: "back", label: "返回" },
    ] });
  if (prompts.isCancel(mode) || mode === "back") return { action: "back" };
  if (!["disabled", "local", "lan", "custom"].includes(mode)) throw new Error("未知 Relay 监听选项");
  let host = mode === "disabled" ? current.host : mode === "lan" ? "0.0.0.0" : "127.0.0.1";
  if (mode === "custom") {
    const valid = value => isRelayListenHost(value) && !["127.0.0.1", "::1", "0.0.0.0"].includes(value);
    const value = await prompts.text({ message: "服务器的 IPv4 内网地址", initialValue: valid(current.host) ? current.host : "",
      validate: value => valid(value) ? undefined : "请输入 10/8、172.16/12 或 192.168/16 范围的 IPv4 地址" });
    if (prompts.isCancel(value)) return { action: "back" };
    if (!valid(value)) throw new Error("无效的 IPv4 内网地址");
    host = value;
  }
  const enabled = mode !== "disabled";
  if (current.enabled === enabled && current.host === host) { output.write("监听设置未变化。\n"); return { action: "unchanged" }; }
  const confirmed = await prompts.confirm({ message: `${enabled ? `启用 ${host}:${current.port}` : "关闭模型转发"}？保存将取消旧请求，保留全部 Key。${enabled && mode !== "local" ? "HTTP 会传输 Key 和正文；请仅在可信内网使用并限制防火墙来源。" : ""}`, initialValue: false });
  if (prompts.isCancel(confirmed) || confirmed !== true) return { action: "back" };
  const result = await manageModelRelay({ command: "listen", host, enabled, models: [] }, environment, { expectedConfigRevision: current.revision });
  output.write(result.activation === "saved_and_applied" ? "监听配置已保存并生效。\n" : result.activation === "saved_not_running"
    ? `配置已保存，Relay 未运行。${enabled ? "已安装服务可运行 codexc start relay。" : ""}\n`
    : "配置已保存，但生效未确认；请运行 codexc relay status 核对。需要立即停止入口时运行 codexc stop relay。\n");
  if (result.cleanupStatus === "failed") output.write("配置已保存，但配置锁清理失败；请先核查锁状态，勿重复操作。\n");
  if (enabled) output.write(host === "0.0.0.0" ? `客户端地址：http://服务器内网IP:${current.port}/v1（不要填写 0.0.0.0）\n`
    : `客户端地址：http://${host === "::1" ? "[::1]" : host}:${current.port}/v1\n`);
  return result;
}
