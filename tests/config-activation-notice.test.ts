import { describe, expect, it } from "vitest";

import { configActivationResult } from "../scripts/config-activation-result.mjs";
import { writeGatewayConfigActivationNotice } from "../scripts/config-activation-notice.mjs";

describe("配置激活结果文案", () => {
  it("列出时区变更影响的三个服务并说明网关启动方式", () => {
    const activation = configActivationResult("restart-app-server-gateway-webui");
    expect(activation).toEqual({
      status: "restart",
      target: "app-server-gateway-webui",
      commands: [
        "codexc service restart app-server",
        "codexc service restart gateway",
        "codexc service restart webui",
      ],
    });
    const output: string[] = [];
    writeGatewayConfigActivationNotice({ write: (value: string) => output.push(value) }, {}, activation);
    const text = output.join("");
    for (const command of activation.commands) expect(text).toContain(command);
    expect(text).toContain("托管网关会通过配置监听自动重启");
    expect(text).toContain("直接运行的网关需重新执行原启动命令");
  });

  it("按结构化目标输出服务重装命令", () => {
    const output: string[] = [];
    writeGatewayConfigActivationNotice(
      { write: (value: string) => output.push(value) },
      {},
      configActivationResult("reinstall-services"),
    );

    expect(output.join("")).toContain("codexc service install");
  });

  it("为 Gateway 热加载输出公开命令", () => {
    const output: string[] = [];
    writeGatewayConfigActivationNotice(
      { write: (value: string) => output.push(value) },
      {},
      configActivationResult("reload"),
    );

    expect(output.join("")).toContain("codexc service reload");
    expect(output.join("")).not.toContain("codexc service reload gateway");
  });
});
