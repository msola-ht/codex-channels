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

import {
  migrateManagedModelProviderFiles,
  migrateManagedModelProviderModelSettings,
} from "../scripts/model-provider-file-layout.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed model provider file layout", () => {
  it("moves legacy Provider files into the unified provider storage and updates references", () => {
    const { codexHome, connectHome } = fixtureHome();
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

    const result = migrateManagedModelProviderFiles({
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: connectHome,
    });

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
    expect(profile.model_catalog_json).toBe(
      join(connectHome, "providers", "deepseek", "models.json"),
    );
    const rootConfig = parse(readFileSync(join(codexHome, "config.toml"), "utf8"));
    expect(rootConfig.model).toBe("gpt-5.6-sol");
    expect(rootConfig.agents).toMatchObject({
      external: {
        config_file: join(codexHome, "sf-agent.config.toml"),
        description: "共享第三方子代理",
      },
    });
    expect(existsSync(
      join(connectHome, "providers", "deepseek", "managed.toml"),
    )).toBe(true);
    const openCodeProfile = parse(
      readFileSync(join(codexHome, "sf-opencode-go.config.toml"), "utf8"),
    );
    expect(openCodeProfile.model_catalog_json).toBe(
      join(connectHome, "providers", "deepseek", "models.json"),
    );
    expect(existsSync(
      join(connectHome, "providers", "opencode-go", "managed.toml"),
    )).toBe(true);
    expect(existsSync(
      join(connectHome, "providers", "deepseek", "models.manifest.json"),
    )).toBe(true);
    expect(existsSync(join(codexHome, "sf-agent.config.toml"))).toBe(true);
  });

  it("migrates the original managed ds role file and agents.ds entry", () => {
    const { codexHome, connectHome } = fixtureHome();
    const oldCatalogPath = join(codexHome, "deepseek.models.json");
    const legacyDsRolePath = join(codexHome, "codex-connect-ds-subagent.config.toml");
    writePrivate(join(codexHome, "deepseek.config.toml"), [
      'model = "deepseek-v4-pro"',
      'model_provider = "deepseek"',
      `model_catalog_json = ${JSON.stringify(oldCatalogPath)}`,
      "",
    ].join("\n"));
    writePrivate(oldCatalogPath, '{"models":[]}\n');
    writePrivate(
      join(codexHome, "codex-connect-deepseek.config.toml"),
      'version = 1\nprovider = "deepseek"\nmode = "switching"\n',
    );
    writePrivate(legacyDsRolePath, [
      'model = "deepseek-v4-pro"',
      'model_provider = "deepseek"',
      'model_reasoning_effort = "high"',
      `model_catalog_json = ${JSON.stringify(oldCatalogPath)}`,
      "",
    ].join("\n"));
    writePrivate(join(codexHome, "config.toml"), [
      "[agents.ds]",
      'description = "Old managed role"',
      `config_file = ${JSON.stringify(legacyDsRolePath)}`,
      "[agents.reviewer]",
      'description = "User role"',
      "",
    ].join("\n"));

    const result = migrateManagedModelProviderFiles({
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: connectHome,
    });

    expect(result.changed).toBe(true);
    expect(existsSync(legacyDsRolePath)).toBe(false);
    const migratedRole = parse(
      readFileSync(join(codexHome, "sf-agent.config.toml"), "utf8"),
    );
    expect(migratedRole.model_catalog_json).toBe(
      join(connectHome, "providers", "deepseek", "models.json"),
    );
    const rootConfig = parse(readFileSync(join(codexHome, "config.toml"), "utf8"));
    expect(rootConfig.agents).toMatchObject({
      external: {
        description: "Old managed role",
        config_file: join(codexHome, "sf-agent.config.toml"),
      },
      reviewer: { description: "User role" },
    });
    expect((rootConfig.agents as Record<string, unknown> | undefined)?.ds).toBeUndefined();
  });

  it("fails closed when a legacy file conflicts with its sf- target", () => {
    const { codexHome, connectHome } = fixtureHome();
    writePrivate(join(codexHome, "deepseek.config.toml"), 'model = "legacy"\n');
    writePrivate(join(codexHome, "sf-deepseek.config.toml"), 'model = "current"\n');

    expect(() => migrateManagedModelProviderFiles({
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: connectHome,
    }))
      .toThrow(/新旧文件同时存在/u);
    expect(readFileSync(join(codexHome, "deepseek.config.toml"), "utf8"))
      .toBe('model = "legacy"\n');
    expect(readFileSync(join(codexHome, "sf-deepseek.config.toml"), "utf8"))
      .toBe('model = "current"\n');
  });

  it("fails closed when two legacy role files target the same sf-agent name", () => {
    const { codexHome, connectHome } = fixtureHome();
    writePrivate(
      join(codexHome, "codex-connect-ds-subagent.config.toml"),
      'model_provider = "deepseek"\n',
    );
    writePrivate(
      join(codexHome, "codex-connect-third-party-subagent.config.toml"),
      'model_provider = "deepseek"\n',
    );

    expect(() => migrateManagedModelProviderFiles({
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: connectHome,
    }))
      .toThrow(/多个旧版文件指向同一目标/u);
    expect(existsSync(join(codexHome, "sf-agent.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "codex-connect-ds-subagent.config.toml"))).toBe(true);
    expect(
      existsSync(join(codexHome, "codex-connect-third-party-subagent.config.toml")),
    ).toBe(true);
  });

  it("rejects a legacy file that is not private", () => {
    const { codexHome, connectHome } = fixtureHome();
    const legacy = join(codexHome, "deepseek.config.toml");
    writePrivate(legacy, 'model = "legacy"\n');
    chmodSync(legacy, 0o644);

    expect(() => migrateManagedModelProviderFiles({
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: connectHome,
    }))
      .toThrow(/权限或类型不安全/u);
    expect(existsSync(join(codexHome, "sf-deepseek.config.toml"))).toBe(false);
  });

  it("migrates Provider-wide defaults into independent per-model catalogs", () => {
    const { codexHome, connectHome } = fixtureHome();
    const deepseekDirectory = join(connectHome, "providers", "deepseek");
    const openCodeDirectory = join(connectHome, "providers", "opencode-go");
    mkdirSync(deepseekDirectory, { recursive: true, mode: 0o700 });
    const sharedCatalog = join(deepseekDirectory, "models.json");
    writePrivate(sharedCatalog, modelCatalog());
    writePrivate(
      join(deepseekDirectory, "models.manifest.json"),
      '{"source":"deepseek"}\n',
    );
    writeManagedProvider(
      codexHome,
      connectHome,
      "deepseek",
      sharedCatalog,
      "deepseek-v4-flash",
      419_430,
    );
    writeManagedProvider(
      codexHome,
      connectHome,
      "opencode-go",
      sharedCatalog,
      "deepseek-v4-pro",
      629_146,
    );
    writePrivate(join(codexHome, "sf-agent.config.toml"), [
      'model = "deepseek-v4-flash"',
      'model_provider = "opencode-go"',
      'model_reasoning_effort = "high"',
      `model_catalog_json = ${JSON.stringify(sharedCatalog)}`,
      "model_context_window = 1048576",
      "model_auto_compact_token_limit = 629146",
      'model_auto_compact_token_limit_scope = "total"',
      "",
    ].join("\n"));

    const result = migrateManagedModelProviderModelSettings({
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: connectHome,
    });

    expect(result.changed).toBe(true);
    const deepseekCatalog = JSON.parse(readFileSync(sharedCatalog, "utf8"));
    const openCodeCatalogPath = join(openCodeDirectory, "models.json");
    const openCodeCatalog = JSON.parse(readFileSync(openCodeCatalogPath, "utf8"));
    expect(readFileSync(
      join(openCodeDirectory, "models.manifest.json"),
      "utf8",
    )).toBe('{"source":"deepseek"}\n');
    const deepseekFlash = deepseekCatalog.models.find(
      ({ slug }: { slug: string }) => slug === "deepseek-v4-flash",
    );
    const deepseekPro = deepseekCatalog.models.find(
      ({ slug }: { slug: string }) => slug === "deepseek-v4-pro",
    );
    const openCodeFlash = openCodeCatalog.models.find(
      ({ slug }: { slug: string }) => slug === "deepseek-v4-flash",
    );
    const openCodePro = openCodeCatalog.models.find(
      ({ slug }: { slug: string }) => slug === "deepseek-v4-pro",
    );
    expect(deepseekFlash.auto_compact_token_limit).toBe(419_430);
    expect(deepseekFlash.context_window).toBe(1_048_576);
    expect(deepseekPro.auto_compact_token_limit).toBeNull();
    expect(openCodeFlash.auto_compact_token_limit).toBeNull();
    expect(openCodePro.auto_compact_token_limit).toBe(629_146);
    expect(openCodePro.context_window).toBe(900_000);
    for (const [provider, catalogPath] of [
      ["deepseek", sharedCatalog],
      ["opencode-go", openCodeCatalogPath],
    ]) {
      const profile = parse(readFileSync(
        join(codexHome, `sf-${provider}.config.toml`),
        "utf8",
      ));
      expect(profile.model_catalog_json).toBe(catalogPath);
      expect(profile.model_reasoning_effort).toBe("high");
      expect(profile.model_context_window).toBeUndefined();
      expect(profile.model_auto_compact_token_limit).toBeUndefined();
      expect(profile.model_auto_compact_token_limit_scope).toBeUndefined();
    }
    const role = parse(readFileSync(join(codexHome, "sf-agent.config.toml"), "utf8"));
    expect(role.model_catalog_json).toBe(openCodeCatalogPath);
    expect(role.model_context_window).toBeUndefined();
    expect(role.model_auto_compact_token_limit).toBeUndefined();
  });
});

function writeManagedProvider(
  codexHome: string,
  connectHome: string,
  provider: "deepseek" | "opencode-go",
  catalogPath: string,
  model: "deepseek-v4-flash" | "deepseek-v4-pro",
  autoCompactLimit: number,
) {
  const providerDirectory = join(connectHome, "providers", provider);
  mkdirSync(providerDirectory, { recursive: true, mode: 0o700 });
  writePrivate(
    join(providerDirectory, "managed.toml"),
    `version = 1\nprovider = "${provider}"\nmode = "switching"\n`,
  );
  writePrivate(join(codexHome, `sf-${provider}.config.toml`), [
    `model = "${model}"`,
    `model_provider = "${provider}"`,
    'model_reasoning_effort = "high"',
    `model_context_window = ${provider === "opencode-go" ? 900_000 : 1_048_576}`,
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    `model_auto_compact_token_limit = ${autoCompactLimit}`,
    'model_auto_compact_token_limit_scope = "total"',
    "",
  ].join("\n"));
}

function modelCatalog() {
  return `${JSON.stringify({
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
    ].map((slug) => ({
      slug,
      display_name: slug,
      context_window: 1_048_576,
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "low", description: "Low" },
        { effort: "high", description: "High" },
        { effort: "max", description: "Max" },
      ],
      auto_compact_token_limit: null,
    })),
  })}\n`;
}

function fixtureHome(): { codexHome: string; connectHome: string } {
  const root = mkdtempSync(join(tmpdir(), "codex-provider-layout-"));
  temporaryDirectories.push(root);
  const codexHome = join(root, ".codex");
  const connectHome = join(root, ".codex-connect");
  mkdirSync(codexHome, { mode: 0o700 });
  mkdirSync(connectHome, { mode: 0o700 });
  return { codexHome, connectHome };
}

function writePrivate(path: string, content: string) {
  writeFileSync(path, content, { mode: 0o600 });
}
