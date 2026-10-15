import { spawn } from "node:child_process";

import * as clackPrompts from "@clack/prompts";

import { codexProcessInvocation } from "../runtime/owned-process.mjs";
import {
  ForwardedChildSignalError,
  installProcessSignalHandlers,
  registerChildProcessGroup,
  signalChildProcesses,
  terminateChildProcess,
} from "../runtime/process-lifecycle.mjs";
import { createCodexUserConfigClient, resolveCodexUserConfigBinary } from "./codex-user-config.mjs";
import { applyPrimaryProviderSwitch, previewPrimaryProviderSwitch } from "./primary-provider-management.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { withCliProgress } from "./cli-operation-progress.mjs";

async function defaultRunLogin({ codexBinary, environment, input, output }) {
  const invocation = codexProcessInvocation(
    codexBinary,
    ["login", "--device-auth"],
    environment,
  );
  const child = spawn(invocation.file, invocation.args, {
    stdio: [input, "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: environment,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (process.platform !== "win32") registerChildProcessGroup(child);
  let failure;
  let forwardedSignal;
  let termination;
  const stopChild = () => {
    termination ??= terminateChildProcess(child);
    void termination.catch(() => undefined);
  };
  const forwardOutput = (text) => {
    if (failure !== undefined) return;
    try { output.write(text); }
    catch (error) { failure = error; stopChild(); }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", forwardOutput);
  child.stderr.on("data", forwardOutput);
  const forwardSignal = (signal) => {
    forwardedSignal ??= signal;
    try { signalChildProcesses([child], signal); }
    catch (error) { failure ??= error; }
    stopChild();
  };
  const removeSignalHandlers = installProcessSignalHandlers({
    SIGINT: () => forwardSignal("SIGINT"),
    SIGTERM: () => forwardSignal("SIGTERM"),
  });
  try {
    const result = await new Promise((resolveExit) => {
      child.once("error", (error) => { failure ??= error; });
      child.once("close", (status, signal) => resolveExit({ status, signal }));
    });
    if (termination !== undefined) await termination;
    if (failure !== undefined) throw failure;
    if (forwardedSignal || result.signal) {
      throw new ForwardedChildSignalError(forwardedSignal || result.signal);
    }
    if (result.status !== 0) {
      throw new Error(`codex login 未成功完成（退出码 ${result.status ?? "未知"}）`);
    }
  } finally {
    removeSignalHandlers();
    child.stdout.off("data", forwardOutput);
    child.stderr.off("data", forwardOutput);
  }
}

export async function runOfficialLoginSetup({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  prompts = clackPrompts,
  createClient = createCodexUserConfigClient,
  runLogin = defaultRunLogin,
} = {}) {
  const preview = await withCliProgress("读取官方登录模式切换预览", () => previewPrimaryProviderSwitch(
    { providerId: "openai" },
    { environment, createClient },
  ), { output, delayMs: 150, handleSignals: false });
  const candidates = preview.effects.candidateIdsToBackup;

  output.write("\nCodex Connect 官方登录模式 Setup\n\n");
  const notices = [
    ...(candidates.length > 0
      ? [`备份并停用自定义候选：${candidates.join("、")}（可用 codexc provider switch 切回）`]
      : []),
    ...(preview.effects.removesTopLevelBaseUrl ? ["移除顶层 openai_base_url"] : []),
    ...(preview.effects.clearsCustomModel ? ["清除第三方默认模型及对应模型设置"] : []),
  ];
  output.write(
    notices.length === 0
      ? "当前已是官方 OpenAI 模式，将直接运行 codex login --device-auth。\n"
      : `将执行：${notices.join("；")}。\n`,
  );

  const confirmed = await prompts.confirm({
    message: "切换到官方 OpenAI 模式并运行 codex login --device-auth？",
    initialValue: true,
  });
  if (prompts.isCancel(confirmed) || confirmed !== true) {
    output.write("已取消，未修改配置。\n");
    return undefined;
  }
  output.write("将运行 codex login --device-auth；打开终端显示的链接并输入验证码完成登录。\n");

  await runLogin({
    codexBinary: resolveCodexUserConfigBinary(environment),
    environment,
    input,
    output,
  });

  const result = await withCliProgress("保存官方 OpenAI 模式", () => applyPrimaryProviderSwitch(
    { providerId: "openai" },
    { environment, createClient, switchPreview: preview },
  ), { output, delayMs: 150, handleSignals: false });
  const backedUp = result.effects.backedUpProviderIds;
  output.write(
    backedUp.length === 0
      ? "已恢复官方 OpenAI 模式。\n"
      : `已恢复官方 OpenAI 模式（自定义候选已备份：${backedUp.join("、")}）。\n`,
  );
  writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-all"));
  output.write("旧会话仍使用创建时的 Provider，请用 /new 创建新会话。\n");
  return {
    mode: "official",
    activation: "restart-all",
    activationResult: configActivationResult("restart-all"),
  };
}
