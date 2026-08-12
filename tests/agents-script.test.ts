import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/agents.mjs");

describe("codexc agents script", () => {
  it("enables multi_agent_v2 with a DeepSeek role and disables it again", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-agents-"));
    const environment = { ...process.env, CODEX_HOME: codexHome };
    const configPath = join(codexHome, "config.toml");
    const rolePath = join(codexHome, "codex-connect-ds-subagent.config.toml");
    try {
      writeFileSync(
        join(codexHome, "codex-connect-deepseek.config.toml"),
        'version = 1\nprovider = "deepseek"\nmode = "switching"\n',
        { mode: 0o600 },
      );
      writeFileSync(join(codexHome, "deepseek.config.toml"), providerProfile(codexHome), {
        mode: 0o600,
      });
      writeFileSync(
        join(codexHome, "deepseek.models.json"),
        '{"models":[{"slug":"deepseek-v4-flash"}]}\n',
        { mode: 0o600 },
      );
      writeFileSync(configPath, "model = \"gpt-5.6-sol\"\n", { mode: 0o600 });
      const originalConfigInode = statSync(configPath).ino;

      const enabled = spawnSync(process.execPath, [scriptPath, "enable-deepseek"], {
        env: environment,
        encoding: "utf8",
      });
      expect(enabled.status, enabled.stderr).toBe(0);
      expect(enabled.stdout).toContain("已启用 multi_agent_v2");
      const enabledConfig = readFileSync(configPath, "utf8");
      expect(statSync(configPath).ino).not.toBe(originalConfigInode);
      expect(enabledConfig).toContain("model = \"gpt-5.6-sol\"");
      expect(enabledConfig).toContain("[features]");
      expect(enabledConfig).toContain("multi_agent_v2 = true");
      expect(enabledConfig).toContain("[agents.ds]");
      expect(enabledConfig).toContain(
        'description = "DeepSeek 单次子代理；仅处理当前用户消息中的完整任务，必须使用 fork_turns=1，不能接收后续消息"',
      );
      expect(enabledConfig).toContain(`config_file = ${JSON.stringify(rolePath)}`);
      expect(enabledConfig).toContain('nickname_candidates = ["DeepSeek"]');
      expect(existsSync(rolePath)).toBe(true);
      expect(readFileSync(rolePath, "utf8")).not.toContain("sk-test-secret");

      const status = spawnSync(process.execPath, [scriptPath, "status"], {
        env: environment,
        encoding: "utf8",
      });
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain("multi_agent_v2：已启用");
      expect(status.stdout).toContain("DS 子代理角色：已配置");

      const disabled = spawnSync(process.execPath, [scriptPath, "disable-deepseek"], {
        env: environment,
        encoding: "utf8",
      });
      expect(disabled.status, disabled.stderr).toBe(0);
      const disabledConfig = readFileSync(configPath, "utf8");
      expect(disabledConfig).not.toContain("[agents.ds]");
      expect(disabledConfig).toContain("multi_agent_v2 = false");
      expect(disabledConfig).toContain("model = \"gpt-5.6-sol\"");
      expect(existsSync(rolePath)).toBe(false);

      const disabledStatus = spawnSync(process.execPath, [scriptPath, "status"], {
        env: environment,
        encoding: "utf8",
      });
      expect(disabledStatus.status, disabledStatus.stderr).toBe(0);
      expect(disabledStatus.stdout).toContain("multi_agent_v2：未启用");
      expect(disabledStatus.stdout).toContain("DS 子代理角色：未配置");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("turns an existing multi_agent_v2 feature table back on and off", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-agents-table-"));
    const environment = { ...process.env, CODEX_HOME: codexHome };
    const configPath = join(codexHome, "config.toml");
    try {
      writeFileSync(
        join(codexHome, "codex-connect-deepseek.config.toml"),
        'version = 1\nprovider = "deepseek"\nmode = "switching"\n',
        { mode: 0o600 },
      );
      writeFileSync(join(codexHome, "deepseek.config.toml"), providerProfile(codexHome), {
        mode: 0o600,
      });
      writeFileSync(
        join(codexHome, "deepseek.models.json"),
        '{"models":[{"slug":"deepseek-v4-flash"}]}\n',
        { mode: 0o600 },
      );
      writeFileSync(
        configPath,
        "[features.multi_agent_v2]\nenabled = false\n",
        { mode: 0o600 },
      );

      const enabled = spawnSync(process.execPath, [scriptPath, "enable-deepseek"], {
        env: environment,
        encoding: "utf8",
      });
      expect(enabled.status, enabled.stderr).toBe(0);
      const enabledConfig = readFileSync(configPath, "utf8");
      expect(enabledConfig).toContain("[features.multi_agent_v2]");
      expect(enabledConfig).toContain("enabled = true");

      const disabled = spawnSync(process.execPath, [scriptPath, "disable-deepseek"], {
        env: environment,
        encoding: "utf8",
      });
      expect(disabled.status, disabled.stderr).toBe(0);
      expect(readFileSync(configPath, "utf8")).toContain("enabled = false");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("replaces existing feature keys instead of duplicating them", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-agents-inline-"));
    const environment = { ...process.env, CODEX_HOME: codexHome };
    const configPath = join(codexHome, "config.toml");
    try {
      writeFileSync(
        join(codexHome, "codex-connect-deepseek.config.toml"),
        'version = 1\nprovider = "deepseek"\nmode = "switching"\n',
        { mode: 0o600 },
      );
      writeFileSync(join(codexHome, "deepseek.config.toml"), providerProfile(codexHome), {
        mode: 0o600,
      });
      writeFileSync(
        join(codexHome, "deepseek.models.json"),
        '{"models":[{"slug":"deepseek-v4-flash"}]}\n',
        { mode: 0o600 },
      );
      writeFileSync(
        configPath,
        "[features]\nmulti_agent_v2 = false\nother_feature = true\n",
        { mode: 0o600 },
      );

      const enabled = spawnSync(process.execPath, [scriptPath, "enable-deepseek"], {
        env: environment,
        encoding: "utf8",
      });
      expect(enabled.status, enabled.stderr).toBe(0);
      const enabledConfig = readFileSync(configPath, "utf8");
      expect(enabledConfig).toContain("multi_agent_v2 = true");
      expect(enabledConfig.match(/multi_agent_v2/u)).toHaveLength(1);
      expect(enabledConfig).toContain("other_feature = true");

      const disabled = spawnSync(process.execPath, [scriptPath, "disable-deepseek"], {
        env: environment,
        encoding: "utf8",
      });
      expect(disabled.status, disabled.stderr).toBe(0);
      const disabledConfig = readFileSync(configPath, "utf8");
      expect(disabledConfig).toContain("multi_agent_v2 = false");
      expect(disabledConfig.match(/multi_agent_v2/u)).toHaveLength(1);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

function providerProfile(codexHome: string): string {
  return [
    'model = "deepseek-v4-flash"',
    'model_provider = "deepseek"',
    'model_reasoning_effort = "high"',
    `model_catalog_json = ${JSON.stringify(join(codexHome, "deepseek.models.json"))}`,
    "model_auto_compact_token_limit = 629146",
    "model_auto_compact_token_limit_scope = \"total\"",
    "[model_providers.deepseek]",
    'name = "deepseek"',
    'base_url = "https://api.deepseek.com/"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    'experimental_bearer_token = "sk-test-secret"',
    "",
  ].join("\n");
}
