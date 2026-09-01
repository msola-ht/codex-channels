import { describe, expect, it } from "vitest";

import { configActivationResult } from "../scripts/config-activation-result.mjs";
import { writeGatewayConfigActivationNotice } from "../scripts/config-activation-notice.mjs";

describe("配置激活结果文案", () => {
  it("按结构化目标输出数据中心重启提示", () => {
    const output: string[] = [];
    writeGatewayConfigActivationNotice(
      { write: (value: string) => output.push(value) },
      {},
      configActivationResult("restart-center"),
    );

    expect(output.join("")).toContain("数据中心配置将在重启中心服务后生效");
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
