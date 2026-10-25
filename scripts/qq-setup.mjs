import { isDeepStrictEqual } from "node:util";
import { dirname } from "node:path";
import { pairQqGroup } from "../runtime/qq-group-pairing.mjs";

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
  pairGroup = pairQqGroup,
} = {}) {
  const prompt = prompter ?? createChannelPrompter(input, output);
  try {
    output.write("\n通讯渠道 · QQ 接入\n\n");
    output.write("单聊仅允许独立名单；群聊须逐群配置成员并同意群内公开输出。启用后普通单聊文字和允许成员的群 @机器人消息会提交 Codex。\n");
    const mode = await prompt.select("选择 QQ 操作", [
      { value: "scan", label: "手机 QQ 扫码连接（推荐）", hint: "获取应用凭据和本次扫码用户 OpenID" },
      { value: "manual", label: "手工填写应用凭据和 OpenID" },
      { value: "groups", label: "配置群及允许成员的公开输出授权", hint: "群内配对识别身份，或手工填写 OpenID" },
      { value: "bot-menu", label: "配置机器人常驻 Codex 菜单", hint: "复用已有凭据；全应用单聊生效，不改本机配置" },
      { value: "back", label: "返回" },
    ]);
    if (mode === "back") return undefined;
    if (mode === "bot-menu") {
      const { runQqMenuSetup } = await import("./qq-menu-setup.mjs");
      return await runQqMenuSetup({ environment, output, prompter: prompt });
    }
    if (mode !== "scan" && mode !== "manual" && mode !== "groups") throw new Error("不支持的 QQ 接入方式");
    const { configPath } = requireUserConfig(environment);
    // 保留读取时的源修订，由现有原子写入器拒绝确认期间的任何并发修改。
    const document = readGatewayConfig(configPath);
    validateGatewayConfigStructureDocument(document);
    const initialDocument = structuredClone(document);
    let appId;
    let appSecret;
    let allowedUserOpenids;
    let groups;
    let enabled;
    if (mode === "groups") {
      if (!document.qq?.app_id || !document.qq.app_secret || !document.qq.allowed_user_openids) {
        throw new Error("请先通过 QQ 扫码或手工方式配置当前应用凭据及单聊允许名单，再配置群授权");
      }
      appId = document.qq.app_id;
      appSecret = document.qq.app_secret;
      allowedUserOpenids = document.qq.allowed_user_openids;
      enabled = document.qq.enabled;
      const edited = await editGroup(prompt, output, document, { input, configPath, pairGroup });
      if (!edited) return undefined;
      groups = edited.groups;
    } else if (mode === "scan") {
      output.write("扫码将通过腾讯官方 Connector 连接机器人；请在手机 QQ 页面确认机器人与授权。\n");
      output.write("此步骤直连 q.qq.com，不使用共享代理；最多等待五分钟，按 Esc/Ctrl+C 取消。\n");
      output.write("最终确认后替换应用凭据和单聊名单，仅授权本次扫码用户单聊；同一 AppID 保留原群授权，变更 AppID 会清除原群授权。扫码不能证明群或群成员身份。\n");
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
    if (mode !== "groups") {
      enabled = await prompt.confirm("保存后启用 QQ 文字渠道（普通文字会提交 Codex）？", false);
      if (initialDocument.qq?.app_id === appId) groups = initialDocument.qq.groups;
    }
    document.qq = {
      enabled,
      app_id: appId,
      app_secret: appSecret,
      allowed_user_openids: allowedUserOpenids,
      ...(groups === undefined ? {} : { groups }),
    };
    validateGatewayConfigStructureDocument(document);
    output.write(mode === "groups" ? "\n准备保存当前应用的群授权（保留凭据、单聊名单和启用状态）：\n"
      : "\n准备保存 QQ 配置（替换凭据和单聊允许名单）：\n");
    output.write(`- 状态：${enabled ? "启用" : "禁用"}\n`);
    output.write(`- 传输：WebSocket 单聊及显式授权群 @消息\n- 应用凭据：${mode === "scan" ? "扫码取得" : mode === "groups" ? "保留现有" : "已填写"}（内容已隐藏，收发尚未验证）\n`);
    output.write(`- 允许用户：${allowedUserOpenids.length} 个（内容已隐藏）\n`);
    if (allowedUserOpenids.length === 0) output.write("- 单聊空名单：拒绝所有单聊用户输入，独立群授权不受此名单影响。\n");
    if (initialDocument.qq?.app_id !== appId && initialDocument.qq?.groups?.length) {
      output.write(`- AppID 变化：清除原应用的 ${initialDocument.qq.groups.length} 个群授权，不继承旧群或成员身份。\n`);
    } else if (mode !== "groups" && groups?.length) {
      output.write(`- AppID 未变：保留已有 ${groups.length} 个群授权；扫码用户身份不增授群权限。\n`);
    }
    writeGroupPreview(output, document.qq.groups ?? []);
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
      writeVerificationSteps(output, enabled, allowedUserOpenids.length, groups?.length ?? 0);
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
      ...(value.groups === undefined ? {} : { groups: value.groups.map(group => ({
        groupOpenId: group.group_openid, allowedMemberOpenIds: group.allowed_member_openids,
        allowPublicOutput: group.allow_public_output,
      })) }),
    } : undefined;
    const changes = classifyQqConfigChanges(runtimeAccount(initialDocument.qq), runtimeAccount(document.qq));
    const activation = changes.some(change => change.restart) ? "restart-gateway"
      : changes.length > 0 ? "reload" : "none";
    if (activation === "none") {
      output.write("QQ 配置已保存，运行配置未变化，无需热加载或重启。\n");
    } else {
      writeGatewayConfigActivationNotice(output, environment, configActivationResult(activation));
    }
    writeVerificationSteps(output, enabled, allowedUserOpenids.length, groups?.length ?? 0);
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

function writeVerificationSteps(output, enabled, allowedUserCount, groupCount) {
  if (!enabled) {
    output.write("QQ 当前禁用；可通过渠道配置启用单聊文字任务。\n");
    return;
  }
  if (allowedUserCount === 0) {
    output.write("QQ 单聊当前没有允许用户；所有单聊输入均拒绝，群成员权限仅由独立群名单决定。\n");
  }
  if (groupCount > 0) output.write("群聊请由配置的成员在对应群 @机器人；每位成员只控制自己的独立会话，全部输出向群内公开。群授权修改须重启 Gateway。\n");
  output.write("下一步：按激活要求启动或重启 Gateway，用 codexc logs gateway -n 100 核对 QQ 连接状态。\n");
  output.write("先发送 /help、/workspace 和 /model 核对，再提交普通文字任务。连接就绪不代表任务送达；重启不恢复旧结果发送资格。\n");
}

function writeGroupPreview(output, groups) {
  output.write(`- 群授权：${groups.length} 个；仅允许成员的 @机器人消息，普通群消息不启用。\n`);
  if (groups.length === 0) return;
  output.write("- 公开范围：每位允许成员独立 Conversation，只能控制自己的会话；任务正文、工具/审批详情、问题、文件和结果均可被全群看到。\n");
  for (const group of groups) {
    output.write(`  群 ${JSON.stringify(group.group_openid)}：允许成员 ${JSON.stringify(group.allowed_member_openids)}；已显式同意公开输出。\n`);
  }
}

async function editGroup(prompt, output, document, { input, configPath, pairGroup }) {
  output.write("群与成员 OpenID 必须来自当前应用，不能用 QQ 号码或单聊扫码身份代替。配对复用已运行的 Gateway 收取群 @消息，不另建机器人连接；识别身份不会自动授权或向群回复。\n");
  const groups = structuredClone(document.qq.groups ?? []);
  writeGroupPreview(output, groups);
  const action = await prompt.select("选择群授权操作", [
    { value: "pair", label: "在群里 @机器人配对（推荐）" },
    { value: "save", label: "添加或替换一个群的完整成员名单" },
    ...(groups.length ? [{ value: "remove", label: "移除一个群的全部授权" }] : []),
    { value: "back", label: "返回" },
  ]);
  if (action === "back") return undefined;
  if (action === "pair") {
    if (document.qq.enabled !== true) throw new Error("请先启用 QQ 并启动 Gateway，再进行群配对。");
    output.write("请先将当前应用的机器人加入目标群。配对有效期五分钟，按 Esc/Ctrl+C 取消；只识别发送配对码的这一位成员。\n");
    let found;
    try {
      found = await withQqSetupCancellation(input, signal => pairGroup({
        configDirectory: dirname(configPath), appId: document.qq.app_id, signal,
        onCode: code => output.write(`\n请由要授权的成员在目标群 @机器人，并发送：\n/qq-pair ${code}\n\n等待群消息；无需手工查找 OpenID。\n`),
      }));
    } catch (error) {
      if (error instanceof ChannelSetupCancelled) throw error;
      const reasons = {
        busy: "已有群配对正在进行，请在原终端完成或取消；遗留配对最多五分钟后过期。",
        expired: "群配对已过期，请重新开始并使用新配对码。",
        cancelled: "群配对等待已取消或超时，请重新开始。",
        closed: "Gateway 群配对入口已关闭，请确认 QQ 已启用并重新启动 Gateway。",
        unavailable: "无法连接群配对入口，请确认同一配置的 QQ 已启用，并更新、启动 Gateway 后重试。",
        cleanup_unconfirmed: "群配对清理结果未确认，未保存授权；请等待最多五分钟使旧码过期后重试。",
        unauthorized: "群配对已失效，请重新开始。",
        invalid_request: "群配对请求不兼容，请更新 CLI 与 Gateway 后重试。",
        invalid_response: "群配对响应无法确认，请更新 CLI 与 Gateway 后重试。",
      };
      throw new Error(Object.hasOwn(reasons, error?.code) ? reasons[error.code] : "群配对未完成，未保存授权；请检查 Gateway 连接状态后重试。", { cause: error });
    }
    const previous = groups.find(group => group.group_openid === found.groupOpenId);
    const members = [...(previous?.allowed_member_openids ?? [])];
    if (!members.includes(found.memberOpenId)) members.push(found.memberOpenId);
    const group = { group_openid: found.groupOpenId, allowed_member_openids: members, allow_public_output: true };
    validateGatewayConfigStructureDocument({ ...document, qq: { ...document.qq, groups: [group] } });
    output.write(`已识别群 ${JSON.stringify(found.groupOpenId)}，发起成员 ${JSON.stringify(found.memberOpenId)}。\n`);
    output.write("配对只证明该成员在此群发送了本次口令，不证明群主或管理员身份；已有群成员授权保留。\n");
    writeGroupPreview(output, [group]);
    if (!await prompt.confirm("确认这是目标群及成员，并同意任务、审批、问题、文件和结果向全群公开？", false)) {
      output.write("未确认群授权，未保存任何配置。\n");
      return undefined;
    }
    const index = groups.findIndex(entry => entry.group_openid === group.group_openid);
    if (index < 0) groups.push(group); else groups[index] = group;
    return { groups };
  }
  if (action === "remove") {
    const groupOpenId = await prompt.select("选择要移除授权的群", groups.map(group => ({
      value: group.group_openid, label: JSON.stringify(group.group_openid),
    })));
    if (!groups.some(group => group.group_openid === groupOpenId)) throw new Error("所选 QQ 群不存在");
    output.write(`将移除群 ${JSON.stringify(groupOpenId)} 的全部授权；重启时解除撤权成员的 Gateway 绑定，保留工作区选择及 App Server 会话。\n`);
    return { groups: groups.filter(group => group.group_openid !== groupOpenId) };
  }
  if (action !== "save") throw new Error("不支持的 QQ 群操作");
  let groupOpenId;
  while (groupOpenId === undefined) {
    const value = await prompt.ask("当前应用的群 OpenID（完整输入，不得含空白）");
    try {
      validateGatewayConfigStructureDocument({ ...document, qq: { enabled: false, groups: [{
        group_openid: value, allowed_member_openids: ["validation-member"], allow_public_output: true,
      }] } });
      groupOpenId = value;
    } catch { output.write("群 OpenID 不能为空、含空白、控制字符或无效 Unicode，且最多 512 UTF-8 字节。\n"); }
  }
  const members = [];
  while (true) {
    const value = await prompt.ask("允许成员 OpenID（每次一个；全部录入后留空结束）");
    if (value === "" && members.length > 0) break;
    try {
      validateGatewayConfigStructureDocument({ ...document, qq: { enabled: false, groups: [{
        group_openid: groupOpenId, allowed_member_openids: [...members, value], allow_public_output: true,
      }] } });
      members.push(value);
    } catch { output.write("成员 OpenID 至少一个、不能重复、含空白、控制字符或无效 Unicode，且每个最多 512 UTF-8 字节。\n"); }
  }
  const group = { group_openid: groupOpenId, allowed_member_openids: members, allow_public_output: true };
  output.write(`将${groups.some(entry => entry.group_openid === groupOpenId) ? "完整替换此群的成员名单" : "新增此群授权"}：\n`);
  writeGroupPreview(output, [group]);
  if (!await prompt.confirm("明确同意以上成员的任务、审批、问题、文件和结果向该群全体成员公开？", false)) {
    output.write("未同意群内公开输出，未保存任何配置。\n");
    return undefined;
  }
  const existing = groups.findIndex(entry => entry.group_openid === groupOpenId);
  if (existing < 0) groups.push(group);
  else {
    const previous = groups[existing];
    if (previous.allowed_member_openids.length !== members.length
      || !previous.allowed_member_openids.every(member => members.includes(member))) groups[existing] = group;
  }
  return { groups };
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
