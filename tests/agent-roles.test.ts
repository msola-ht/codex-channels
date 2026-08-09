import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  agentRolesConfigPath,
  listConfiguredAgentRoles,
} from "../runtime/agent-roles.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("configured Codex agent roles", () => {
  it("returns an empty list when config.toml does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-agent-roles-"));
    temporaryDirectories.push(root);

    expect(listConfiguredAgentRoles({ CODEX_HOME: root })).toEqual([]);
  });

  it("lists role tables with a description and skips global [agents] keys", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-agent-roles-"));
    temporaryDirectories.push(root);
    writeFileSync(
      join(root, "config.toml"),
      [
        "[agents]",
        "enabled = true",
        "max_threads = 4",
        "max_depth = 8",
        "default_subagent_model = \"gpt-test\"",
        "",
        "[agents.ds]",
        "description = \"DeepSeek 子代理\"",
        "config_file = \"/tmp/ds.toml\"",
        "",
        "[agents.no-description]",
        "config_file = \"/tmp/role.toml\"",
      ].join("\n"),
    );

    expect(agentRolesConfigPath({ CODEX_HOME: root }))
      .toBe(join(root, "config.toml"));
    expect(listConfiguredAgentRoles({ CODEX_HOME: root })).toEqual([
      { name: "ds", description: "DeepSeek 子代理" },
    ]);
  });

  it("fails closed when config.toml cannot be parsed", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-agent-roles-"));
    temporaryDirectories.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "config.toml"), "{broken", { mode: 0o600 });

    expect(() => listConfiguredAgentRoles({ CODEX_HOME: root }))
      .toThrow("子代理角色配置无法安全读取");
  });
});
