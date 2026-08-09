import { describe, expect, it } from "vitest";

import {
  colorizeCliText,
  formatCliMessage,
  formatCliStatus,
  writeCliMessage,
} from "../runtime/cli-presentation.mjs";

describe("CLI presentation", () => {
  it("uses distinct colors for success, failure, notes and remediation", () => {
    const options = { stream: { isTTY: true }, environment: {} };
    expect(colorizeCliText("success", "ok", options)).toContain("\u001b[32m");
    expect(colorizeCliText("failure", "error", options)).toContain("\u001b[31m");
    expect(colorizeCliText("note", "note", options)).toContain("\u001b[33m");
    expect(colorizeCliText("remediation", "fix", options)).toContain("\u001b[36m");
  });

  it("keeps redirected and NO_COLOR output plain", () => {
    expect(formatCliStatus("failure", "配置", "无效", {
      stream: { isTTY: false },
      environment: {},
    })).toBe("[失败] 配置：无效");
    expect(colorizeCliText("success", "ok", {
      stream: { isTTY: true },
      environment: { NO_COLOR: "1" },
    })).toBe("ok");
    expect(formatCliMessage("success", "Gateway 已启动。", {
      stream: { isTTY: false },
      environment: {},
    })).toBe("[成功] Gateway 已启动。");
  });

  it("routes failures to stderr and other statuses to stdout", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const streams = {
      stdout: { isTTY: false, write: (value: string) => stdout.push(value) },
      stderr: { isTTY: false, write: (value: string) => stderr.push(value) },
      environment: {},
    };
    writeCliMessage("success", "完成。", streams);
    writeCliMessage("failure", "出错。", streams);
    expect(stdout).toEqual(["[成功] 完成。\n"]);
    expect(stderr).toEqual(["[失败] 出错。\n"]);
  });

  it("allows a warning-style note to be written explicitly to stderr", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    writeCliMessage("note", "警告：服务未停止。", {
      stdout: { isTTY: false, write: (value: string) => stdout.push(value) },
      stderr: { isTTY: false, write: (value: string) => stderr.push(value) },
      environment: {},
      destination: "stderr",
    });
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["[提示] 警告：服务未停止。\n"]);
  });
});
