import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cli, forEachWithConcurrency, mkdtempSync, runCliProcess } from "./codexc-cli-test-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("codexc CLI", { timeout: 15_000 }, () => {
  it.each([
    [[], "交互终端无参数时打开主菜单"],
    [["service"], "codexc service [命令]"],
    [["sessions"], "交互归档请运行 codexc cleanup"],
    [["metrics"], "交互清理和重置请用 codexc cleanup"],
  ] as const)("shows help without prompting or requiring config for %j", (args, expected) => {
    const root = mkdtempSync(join(tmpdir(), "codexc-menu-no-tty-"));
    temporaryDirectories.push(root);
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: join(root, "missing.toml") },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expected);
    expect(result.stderr).toBe("");
  });


  it.each([{ args: [] }, { args: ["--json"] }])("rejects noninteractive setup $args before initializing user data", ({ args }) => {
    const root = mkdtempSync(join(tmpdir(), "codexc-setup-no-tty-"));
    temporaryDirectories.push(root);
    const home = join(root, "uninitialized");
    const result = spawnSync(process.execPath, [cli, "setup", ...args], {
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, CODEX_CONNECT_HOME: home, CODEX_CONNECT_CONFIG_FILE: "" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("交互终端");
    expect(existsSync(home)).toBe(false);
    if (args.length > 0) expect(JSON.parse(result.stdout)).toMatchObject({ event: "error" });
  });

  it("validates command syntax before requiring user configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-syntax-"));
    temporaryDirectories.push(root);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: join(root, "missing"),
      CODEX_CONNECT_CONFIG_FILE: "",
    };

    const cases = [
      [["work", "remove"], "用法：codexc work remove"],
      [["work", "add", "--unknown"], "未知参数：--unknown"],
      [["work", "add", "--id", "--prune-missing"], "--id 缺少值"],
      [["work", "add", "--name", "-Project", "--unknown"], "未知参数：--unknown"],
      [["work", "unknown"], "用法：codexc work"],
      [["state", "upgrade"], "未知命令：state"],
      [["rules", "init"], "未知命令：rules"],
      [["rules", "check"], "未知命令：rules"],
      [["rules", "--help"], "未知命令：rules"],
      [["metrics", "upgrade"], "用法：codexc metrics"],
      [["remote", "--workspace"], "用法：codexc remote"],
      [["remote", "--workspace", "--profile", "ds-test"], "用法：codexc remote"],
      [["config", "--json", "unexpected"], "用法：codexc config [--json]"],
      [["doctor", "--json", "unexpected"], "用法：codexc doctor [--json]"],
      [["service", "status", "--json", "gateway"], "用法：codexc service status"],
      [["service", "status", "gateway", "--json", "unexpected"], "用法：codexc service status"],
      [["metrics", "status", "--json", "unexpected"], "用法：codexc metrics status"],
      [["webui", "--unknown"], "未知参数：--unknown"],
      [["webui", "--help", "unexpected"], "用法：codexc webui"],
      [["webui", "--host", "invalid"], "WebUI host 只允许"],
      [["webui", "--token", "--unknown"], "不得通过命令行传入"],
      [["webui", "--token", "-token", "--host", "invalid"], "不得通过命令行传入"],
      [["channel", "send-image", "--unknown"], "未知参数：--unknown"],
      [["channel", "send-image", "--help", "unexpected"], "用法：codexc channel send-image"],
      [["channel", "send-image", "relative.png"], "图片路径必须是绝对路径"],
      [["channel", "send-image", join(root, "image.png"), "--thread", "--unknown"], "--thread 缺少值"],
      [["metrics", "report", "--unknown"], "未知参数：--unknown"],
      [["metrics", "report", "--help", "unexpected"], "用法：codexc metrics report"],
      [["metrics", "report", "--range", "invalid"], "--range 只支持"],
      [["metrics", "report", "--group", "invalid"], "--group 只支持"],
      [["metrics", "cleanup", "--before", "invalid"], "日期必须使用 YYYY-MM-DD 格式"],
      [["traffic", "--unknown"], "未知参数：--unknown"],
      [["traffic", "--list", "--all"], "--list 与 --all 不能同时使用"],
      [["traffic", "--exchange", "abc"], "--exchange 需要正整数值"],
      [["traffic", "--dir"], "--dir 缺少值"],
      [["traffic", "cleanup", "--all"], "未知清理参数：--all"],
    ] as const;
    await forEachWithConcurrency(cases, 8, async ([args, expected]) => {
      const result = await runCliProcess(args, {
        cwd: root,
        env: environment,
      });
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(expected);
      expect(result.stderr).not.toContain("尚未初始化");
    });
  }, 15_000);


});
