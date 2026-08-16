import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

import { migrateManagedModelProviderFiles } from "../scripts/model-provider-file-layout.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed model provider file layout", () => {
  it("moves legacy Provider files to sf- names and updates managed references", () => {
    const codexHome = fixtureHome();
    const oldCatalogPath = join(codexHome, "deepseek.models.json");
    const oldRolePath = join(codexHome, "codex-connect-third-party-subagent.config.toml");
    writePrivate(join(codexHome, "deepseek.config.toml"), [
      'model = "deepseek-v4-pro"',
      'model_provider = "deepseek"',
      `model_catalog_json = ${JSON.stringify(oldCatalogPath)}`,
      "",
    ].join("\n"));
    writePrivate(oldCatalogPath, '{"models":[]}\n');
    writePrivate(join(codexHome, "deepseek.models.manifest.json"), '{"source":"test"}\n');
    writePrivate(
      join(codexHome, "codex-connect-deepseek.config.toml"),
      'version = 1\nprovider = "deepseek"\nmode = "switching"\n',
    );
    writePrivate(join(codexHome, "opencode-go.config.toml"), [
      'model = "deepseek-v4-flash"',
      'model_provider = "opencode-go"',
      `model_catalog_json = ${JSON.stringify(oldCatalogPath)}`,
      "",
    ].join("\n"));
    writePrivate(
      join(codexHome, "codex-connect-opencode-go.config.toml"),
      'version = 1\nprovider = "opencode-go"\nmode = "switching"\n',
    );
    writePrivate(oldRolePath, 'model = "deepseek-v4-pro"\n');
    writePrivate(join(codexHome, "config.toml"), [
      'model = "gpt-5.6-sol"',
      "[agents.external]",
      `config_file = ${JSON.stringify(oldRolePath)}`,
      'description = "共享第三方子代理"',
      "",
    ].join("\n"));

    const result = migrateManagedModelProviderFiles({ CODEX_HOME: codexHome });

    expect(result.changed).toBe(true);
    expect(result.moved).toHaveLength(7);
    for (const legacy of [
      "deepseek.config.toml",
      "deepseek.models.json",
      "deepseek.models.manifest.json",
      "codex-connect-deepseek.config.toml",
      "opencode-go.config.toml",
      "codex-connect-opencode-go.config.toml",
      "codex-connect-third-party-subagent.config.toml",
    ]) {
      expect(existsSync(join(codexHome, legacy))).toBe(false);
    }
    const profile = parse(readFileSync(join(codexHome, "sf-deepseek.config.toml"), "utf8"));
    expect(profile.model_catalog_json).toBe(join(codexHome, "sf-deepseek.models.json"));
    const rootConfig = parse(readFileSync(join(codexHome, "config.toml"), "utf8"));
    expect(rootConfig.model).toBe("gpt-5.6-sol");
    expect(rootConfig.agents).toMatchObject({
      external: {
        config_file: join(codexHome, "sf-agent.config.toml"),
        description: "共享第三方子代理",
      },
    });
    expect(existsSync(join(codexHome, "sf-deepseek.managed.toml"))).toBe(true);
    const openCodeProfile = parse(
      readFileSync(join(codexHome, "sf-opencode-go.config.toml"), "utf8"),
    );
    expect(openCodeProfile.model_catalog_json).toBe(
      join(codexHome, "sf-deepseek.models.json"),
    );
    expect(existsSync(join(codexHome, "sf-opencode-go.managed.toml"))).toBe(true);
    expect(existsSync(join(codexHome, "sf-deepseek.models.manifest.json"))).toBe(true);
    expect(existsSync(join(codexHome, "sf-agent.config.toml"))).toBe(true);
  });

  it("fails closed when a legacy file conflicts with its sf- target", () => {
    const codexHome = fixtureHome();
    writePrivate(join(codexHome, "deepseek.config.toml"), 'model = "legacy"\n');
    writePrivate(join(codexHome, "sf-deepseek.config.toml"), 'model = "current"\n');

    expect(() => migrateManagedModelProviderFiles({ CODEX_HOME: codexHome }))
      .toThrow(/新旧文件同时存在/u);
    expect(readFileSync(join(codexHome, "deepseek.config.toml"), "utf8"))
      .toBe('model = "legacy"\n');
    expect(readFileSync(join(codexHome, "sf-deepseek.config.toml"), "utf8"))
      .toBe('model = "current"\n');
  });

  it("rejects a legacy file that is not private", () => {
    const codexHome = fixtureHome();
    const legacy = join(codexHome, "deepseek.config.toml");
    writePrivate(legacy, 'model = "legacy"\n');
    chmodSync(legacy, 0o644);

    expect(() => migrateManagedModelProviderFiles({ CODEX_HOME: codexHome }))
      .toThrow(/权限或类型不安全/u);
    expect(existsSync(join(codexHome, "sf-deepseek.config.toml"))).toBe(false);
  });
});

function fixtureHome() {
  const root = mkdtempSync(join(tmpdir(), "codex-provider-layout-"));
  temporaryDirectories.push(root);
  const codexHome = join(root, ".codex");
  mkdirSync(codexHome, { mode: 0o700 });
  return codexHome;
}

function writePrivate(path: string, content: string) {
  writeFileSync(path, content, { mode: 0o600 });
}
