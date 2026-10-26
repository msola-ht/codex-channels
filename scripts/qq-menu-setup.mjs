import { isDeepStrictEqual } from "node:util";

import { readCodexProxySettings } from "../runtime/codex-proxy-env.mjs";
import { readGatewayConfig, validateGatewayConfigStructureDocument } from "../runtime/gateway-config.mjs";
import { resolveProxyEnvironment } from "../runtime/network-proxy.mjs";
import { ChannelSetupCancelled } from "./channel-setup-presentation.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

class QqMenuSetupError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/** Explicit remote-menu transaction. Does not change TOML, open WebSocket or restart services. */
export async function runQqMenuSetup({ environment = process.env, output = process.stdout, prompter }) {
  const lifetime = new AbortController();
  const cancel = () => lifetime.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let network;
  let client;
  let surface;
  let operation = "configuration";
  let writeStarted = false;
  let failure;
  let localFailure;
  let cleanupFailure;
  const execute = async () => {
    try {
      const { configPath } = requireUserConfig(environment, { readOnly: true });
      operation = "load-modules";
      const [{ createQqNetwork }, { loadQqSurface }] = await Promise.all([
        import("../dist/bootstrap/qq-network.js"),
        import("../dist/surfaces/index.js"),
      ]);
      surface = await loadQqSurface();
      const readLocal = () => {
        if (requireUserConfig(environment, { readOnly: true }).configPath !== configPath) {
          throw new QqMenuSetupError("stale-configuration");
        }
        const raw = validateGatewayConfigStructureDocument(readGatewayConfig(configPath));
        if (!raw.qq?.app_id || !raw.qq?.app_secret) throw new QqMenuSetupError("credentials-missing");
        // Menu management also works before any channel is enabled. Resolve the
        // shared proxy without requiring a startable Gateway or usable Workspace.
        const proxy = resolveProxyEnvironment(readCodexProxySettings(environment), environment);
        return { appId: raw.qq.app_id, appSecret: raw.qq.app_secret, networkProxy: {
          ...(proxy.HTTP_PROXY ? { http: proxy.HTTP_PROXY } : {}),
          ...(proxy.HTTPS_PROXY ? { https: proxy.HTTPS_PROXY } : {}),
          ...(proxy.ALL_PROXY ? { all: proxy.ALL_PROXY } : {}),
          ...(proxy.NO_PROXY ? { no: proxy.NO_PROXY } : {}),
        } };
      };
      operation = "configuration";
      const local = readLocal();
      const beforeSend = () => {
        lifetime.signal.throwIfAborted();
        try {
          if (!isDeepStrictEqual(readLocal(), local)) throw new QqMenuSetupError("stale-configuration");
        } catch (error) {
          // The protocol deliberately normalizes unknown guard failures. Retain only our local reason.
          localFailure = error instanceof QqMenuSetupError ? error.reason : "configuration-unavailable";
          throw new QqMenuSetupError(localFailure);
        }
        return undefined;
      };
      network = createQqNetwork(local.networkProxy);
      client = new surface.QqProtocolClient({
        appId: local.appId, appSecret: local.appSecret, fetchImpl: network.fetchImpl,
      });
      const context = { signal: lifetime.signal, beforeSend };
      operation = "get-menu";
      const initial = surface.parseQqBotMenuSnapshot(await client.getBotMenu(context));
      const plan = surface.planQqCodexBotMenu(initial);
      if (plan.action === "unchanged") {
        beforeSend();
        output.write("QQ 单聊常驻菜单已有相同 Codex 项（填入 /help）；未写入远程菜单，无需重启。\n");
        return result("unchanged");
      }
      operation = "confirmation";
      output.write("\n准备为当前凭据所属 QQ 机器人配置全局常驻菜单：\n");
      output.write(`- 目标 QQ App ID：${local.appId}\n`);
      output.write("- 仅用于单聊，对该应用的所有用户展示；菜单展示不按本机允许名单区分，命令执行仍检查允许名单。\n");
      output.write("- 新增 Codex 按钮，点击只将 /help 填入输入框，由用户自行发送。\n");
      output.write(`- 当前版本：${initial.version === undefined ? "未配置（平台未返回版本）" : initial.version}\n`);
      const existingItems = initial.menu?.items ?? [];
      output.write(`- 保留既有菜单：${existingItems.length} 项，顺序及所有内容保持原样。\n`);
      for (const entry of existingItems) output.write(`  ${JSON.stringify(entry.name)}（${entry.type}）\n`);
      output.write('- 在末尾新增：Codex（send_message，填入 "/help"）\n');
      output.write("此接口完全替换菜单；提交内容保留所有既有菜单及子菜单，不回显私人链接或消息正文。不写 TOML，不重启 Gateway。\n");
      output.write("平台没有条件写入/CAS：确认后会复核版本和完整内容，但复核与写入之间仍有并发覆盖窗口。\n");
      output.write("请避免同时在其他终端或平台后台修改菜单；不确定写入不会自动重试或回滚。\n");
      if (!await prompter.confirm("确认保存以上 QQ 全局菜单？", false, { signal: lifetime.signal })) {
        output.write("未写入 QQ 全局菜单。\n");
        return undefined;
      }
      beforeSend();
      operation = "recheck-menu";
      const current = surface.parseQqBotMenuSnapshot(await client.getBotMenu(context));
      if (!surface.sameQqBotMenuSnapshot(initial, current)) throw new QqMenuSetupError("stale-menu");
      beforeSend();
      operation = "put-menu";
      writeStarted = true;
      const saved = await client.putBotMenu(plan.menu, context);
      operation = "readback-menu";
      const readback = surface.parseQqBotMenuSnapshot(await client.getBotMenu(context));
      if (readback.version !== saved.version || !surface.matchesQqBotMenuPlan(readback.menu, plan.menu)) {
        throw new QqMenuSetupError("readback-mismatch");
      }
      beforeSend();
      output.write("QQ 全局菜单已保存并回读确认；Codex 按钮仅填入 /help，无需重启 Gateway。\n");
      output.write("请在手机 QQ 单聊确认按钮显示，点击后自行发送 /help；回读成功不代表客户端显示已验收。\n");
      return result("configured");
    } catch (error) {
      if (!writeStarted && (error instanceof ChannelSetupCancelled || lifetime.signal.aborted)) {
        output.write("已取消 QQ 菜单操作，未开始写入远程菜单。\n");
        return undefined;
      }
      const detail = { operation, reason: "unavailable" };
      if (localFailure) {
        detail.reason = localFailure;
      } else if (error instanceof QqMenuSetupError || (surface && error instanceof surface.QqBotMenuError)) {
        detail.reason = error.reason;
      } else if (surface && error instanceof surface.QqProtocolError) {
        detail.operation = error.operation;
        detail.reason = error.reason;
        if (error.httpStatus !== undefined) detail.httpStatus = error.httpStatus;
        if (error.bizCode !== undefined) detail.bizCode = error.bizCode;
      } else if (lifetime.signal.aborted) {
        detail.reason = "cancelled";
      }
      if (writeStarted) {
        output.write("QQ 菜单写入已开始，但保存结果尚未确认。请重新读取并人工核对；不会自动重试或回滚。\n");
      } else {
        output.write("QQ 菜单操作失败，未开始写入远程菜单。\n");
      }
      failure = new Error(`QQ 菜单操作失败：${JSON.stringify(detail)}`);
      throw failure;
    }
  };
  let outcome;
  try {
    outcome = await execute();
  } catch (error) {
    failure = error;
  } finally {
    lifetime.abort();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => client?.close()),
      Promise.resolve().then(() => network?.close()),
    ]);
    if (cleanup.some(value => value.status === "rejected")) {
      const message = 'QQ 菜单资源关闭未确认：{"operation":"cleanup","reason":"close-failed"}';
      output.write(`${message}\n`);
      cleanupFailure = new Error(message);
    }
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return outcome;
}

function result(action) {
  return { action, channel: "qq", resource: "bot-menu", activation: "none", activationResult: configActivationResult("none") };
}
