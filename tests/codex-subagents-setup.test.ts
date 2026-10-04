import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCodexSubagentsSetup } from "../scripts/codex-subagents-setup.mjs";
import type { CodexUserConfigValue } from "../scripts/codex-user-config.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(action: string, config: Record<string, CodexUserConfigValue | undefined> = {}) {
  const home = await mkdtemp(join(tmpdir(), "codexc-sa-"));
  directories.push(home);
  const agentsPath = join(home, "AGENTS.md");
  const configPath = join(home, "config.toml");
  const output: string[] = [];
  const write = vi.fn(async () => undefined);
  const client = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    readUserConfigSnapshot: vi.fn(async () => ({ config, version: "sha256:preview" })),
    writeUserConfigEdits: write,
  };
  const createClient = vi.fn(async () => client);
  const prompts = {
    select: vi.fn(async () => action),
    confirm: vi.fn(async () => true),
    isCancel: (value: unknown) => typeof value === "symbol",
  };
  const run = () => runCodexSubagentsSetup({
    environment: { CODEX_HOME: home }, output: { write: (value: string) => output.push(value) }, prompts, createClient,
  });
  return { home, agentsPath, configPath, output, client, createClient, prompts, run };
}

describe("optional Codex subagent setup", () => {
  it.each(["back", "rules", "config", "both"])("never writes when choice or confirmation cancels: %s", async (action) => {
    const f = await fixture(action);
    f.prompts.confirm.mockResolvedValue(false);
    await expect(f.run()).resolves.toEqual({ action: "back" });
    expect(f.client.writeUserConfigEdits).not.toHaveBeenCalled();
    await expect(readFile(f.agentsPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.prompts.select).toHaveBeenCalledWith(expect.objectContaining({ initialValue: "back" }));
    if (action !== "back") expect(f.prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
  });

  it("writes rules alone without launching an App Server or touching configuration", async () => {
    const f = await fixture("rules");
    await writeFile(f.agentsPath, "# Global\n\nKeep this.\n");
    await writeFile(f.configPath, "model = \"unchanged\"\n");
    await expect(f.run()).resolves.toMatchObject({ action: "saved", activationResult: { status: "next-thread" } });
    const written = await readFile(f.agentsPath, "utf8");
    expect(written).toMatch(/^# Global\n\nKeep this\.\n\n<!-- codexc:subagents:start -->/u);
    expect(written).toContain('fork_turns="none"');
    expect(written).toContain("gpt-6-luna/high");
    expect(written).toContain("gpt-6.1-sol/high");
    expect(written).toContain("gpt-6-astra/high");
    expect(f.createClient).not.toHaveBeenCalled();
    expect(await readFile(f.configPath, "utf8")).toBe('model = "unchanged"\n');
    expect(f.output.join("")).toContain(f.configPath);
    expect(f.output.join("")).toContain(f.agentsPath);
  });

  it("updates only its managed block and preserves surrounding sections", async () => {
    const f = await fixture("rules");
    await writeFile(f.agentsPath, "Before\n<!-- codexc:subagents:start -->\n## Subagents\nOld rule\n<!-- codexc:subagents:end -->\nAfter\n");
    await f.run();
    const first = await readFile(f.agentsPath, "utf8");
    expect(first).toMatch(/^Before\n/u);
    expect(first).toMatch(/\nAfter\n$/u);
    expect(first).not.toContain("Old rule");
    await f.run();
    expect(await readFile(f.agentsPath, "utf8")).toBe(first);
  });

  it("writes configuration alone as four exact edits protected by the displayed revision", async () => {
    const f = await fixture("config", { features: { multi_agent_v2: { tool_namespace: "team", max_wait_timeout_ms: 1_000_000 } }, agents: { custom: { description: "keep" } } });
    await writeFile(f.agentsPath, "## Subagents\nUnmanaged rules\n");
    await f.run();
    expect(f.client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "features.multi_agent_v2.enabled", value: true },
      { keyPath: "features.multi_agent_v2.default_wait_timeout_ms", value: 600_000 },
      { keyPath: "agents.default_subagent_model", value: "gpt-6.1-sol" },
      { keyPath: "agents.default_subagent_reasoning_effort", value: "high" },
    ], { expectedVersion: "sha256:preview" });
    expect(f.client.close).toHaveBeenCalledTimes(2);
    expect(await readFile(f.agentsPath, "utf8")).toBe("## Subagents\nUnmanaged rules\n");
    expect(f.output.join("")).toContain("不会验证账户或 Provider 可用性");
  });

  it("saves both selected files after one explicit confirmation", async () => {
    const f = await fixture("both");
    f.client.writeUserConfigEdits.mockImplementation(async () => {
      await expect(readFile(f.agentsPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
    await expect(f.run()).resolves.toMatchObject({ action: "saved" });
    expect(f.prompts.confirm).toHaveBeenCalledOnce();
    expect(f.client.writeUserConfigEdits).toHaveBeenCalledOnce();
    expect(await readFile(f.agentsPath, "utf8")).toContain("<!-- codexc:subagents:end -->");
    expect(f.output.join("")).toContain("无法保证跨文件原子提交");
    expect(f.output.join("")).toContain("已保存子代理配置");
    expect(f.output.join("")).toContain("已保存子代理规则");
  });

  it.each([
    { features: { multi_agent_v2: true } },
    { features: { multi_agent_v2: { max_wait_timeout_ms: 30_000 } } },
    { features: { multi_agent_v2: { min_wait_timeout_ms: 700_000 } } },
  ])("rejects incompatible feature shape or wait constraints", async (config) => {
    const f = await fixture("both", config);
    await expect(f.run()).rejects.toThrow(/人工/u);
    expect(f.prompts.confirm).not.toHaveBeenCalled();
    expect(f.client.writeUserConfigEdits).not.toHaveBeenCalled();
    await expect(readFile(f.agentsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "## Subagents\nExisting\n", "## subagents ##\nExisting\n",
    "<!-- codexc:subagents:start -->\nMissing end\n",
    "```markdown\n<!-- codexc:subagents:start -->\n## Subagents\n<!-- codexc:subagents:end -->\n```\n",
  ])("rejects unmanaged sections and malformed managed markers", async (text) => {
    const f = await fixture("both");
    await writeFile(f.agentsPath, text);
    await expect(f.run()).rejects.toThrow(/人工/u);
    expect(await readFile(f.agentsPath, "utf8")).toBe(text);
    expect(f.client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("ignores a Subagents heading in a fenced example", async () => {
    const f = await fixture("rules");
    const original = "# Examples\n```markdown\n## Subagents\n```\n";
    await writeFile(f.agentsPath, original);
    await f.run();
    expect(await readFile(f.agentsPath, "utf8")).toMatch(/^# Examples\n```markdown\n## Subagents\n```\n/u);
  });

  it.each(["AGENTS.md", "config.toml"])("rejects a symlink target for %s", async (filename) => {
    const f = await fixture("both");
    const target = join(f.home, "untouched");
    await writeFile(target, "original\n");
    await symlink(target, join(f.home, filename));
    await expect(f.run()).rejects.toThrow(/符号链接/u);
    expect(f.client.writeUserConfigEdits).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe("original\n");
  });

  it("does not overwrite rules changed during confirmation", async () => {
    const f = await fixture("both");
    await writeFile(f.agentsPath, "original\n");
    f.prompts.confirm.mockImplementation(async () => { await writeFile(f.agentsPath, "concurrent edit\n"); return true; });
    await expect(f.run()).rejects.toThrow(/预览后变化/u);
    expect(f.client.writeUserConfigEdits).not.toHaveBeenCalled();
    expect(await readFile(f.agentsPath, "utf8")).toBe("concurrent edit\n");
  });

  it("stops after a stale config revision and closes both clients", async () => {
    const f = await fixture("both");
    f.client.writeUserConfigEdits.mockRejectedValue(new Error("revision conflict"));
    await expect(f.run()).rejects.toThrow("revision conflict");
    await expect(readFile(f.agentsPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.client.close).toHaveBeenCalledTimes(2);
    expect(f.output.join("")).not.toContain("已保存子代理规则");
  });

  it("reports partial success when rules change while config is being committed", async () => {
    const f = await fixture("both");
    await writeFile(f.agentsPath, "original\n");
    f.client.writeUserConfigEdits.mockImplementation(async () => { await writeFile(f.agentsPath, "concurrent\n"); });
    await expect(f.run()).rejects.toThrow(/预览后变化/u);
    expect(f.output.join("")).toContain("部分成功：主配置已保存");
    expect(await readFile(f.agentsPath, "utf8")).toBe("concurrent\n");
    await expect(readFile(join(f.home, ".codexc-subagents.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses overlapping local setup writers instead of taking another writer's lock", async () => {
    const f = await fixture("both");
    await writeFile(join(f.home, ".codexc-subagents.lock"), "other writer");
    await expect(f.run()).rejects.toMatchObject({ code: "EEXIST" });
    expect(f.client.writeUserConfigEdits).not.toHaveBeenCalled();
    expect(await readFile(join(f.home, ".codexc-subagents.lock"), "utf8")).toBe("other writer");
  });
});
