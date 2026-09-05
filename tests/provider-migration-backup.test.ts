import {
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
import { describe, expect, it } from "vitest";

import {
  backupAndMigrateProviderFiles,
  resolveBackupTarget,
} from "../scripts/backup-provider-migration.mjs";
import {
  deepseekProviderDefinition,
  opencodeGoProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import type { ModelProviderDefinition } from "../runtime/model-provider-definitions.mjs";

describe("backup provider migration", () => {
  it("resolves backup targets inside managed directories and rejects outside paths", () => {
    const fixture = createFixture();
    try {
      const backupRoot = join(fixture.root, "backups", "provider-migration-test");
      const roots = {
        codexHome: fixture.codexHome,
        connectHome: fixture.connectHome,
      };
      expect(resolveBackupTarget(
        backupRoot,
        roots,
        join(fixture.codexHome, "sf-deepseek.config.toml"),
      )).toBe(join(backupRoot, "codex-home", "sf-deepseek.config.toml"));
      expect(resolveBackupTarget(
        backupRoot,
        roots,
        join(fixture.connectHome, "providers", "deepseek", "models.json"),
      )).toBe(join(backupRoot, "other", "providers", "deepseek", "models.json"));
      expect(() => resolveBackupTarget(
        backupRoot,
        roots,
        join(fixture.root, "outside", "secret.toml"),
      )).toThrow(/不在受管目录内，拒绝迁移/u);
    } finally {
      fixture.remove();
    }
  });

  it("previews the plan without writing anything", () => {
    const fixture = createFixture();
    try {
      writeLegacyProvider(fixture, deepseekProviderDefinition);
      writeCurrentProviderDirectory(fixture, deepseekProviderDefinition);

      const result = backupAndMigrateProviderFiles(fixture.environment, { apply: false });

      expect(result.status).toBe("dry-run");
      if (result.status !== "dry-run") throw new Error("unreachable");
      expect(result.legacyFiles).toContain(
        join(fixture.codexHome, "sf-deepseek.models.json"),
      );
      expect(existsSync(result.backupDirectory)).toBe(false);
      expect(existsSync(join(fixture.codexHome, "sf-deepseek.models.json"))).toBe(true);
      expect(existsSync(join(
        fixture.connectHome,
        "providers",
        "deepseek",
        "models.json",
      ))).toBe(true);
    } finally {
      fixture.remove();
    }
  });

  it("migrates legacy-only files and rewrites profile references", () => {
    const fixture = createFixture();
    try {
      writeLegacyProvider(fixture, deepseekProviderDefinition);
      writeConfigAndRole(fixture);

      const result = backupAndMigrateProviderFiles(fixture.environment, { apply: true });

      expect(result.status).toBe("migrated");
      if (result.status !== "migrated") throw new Error("unreachable");
      expect(result.layout.changed).toBe(true);
      const providerDirectory = join(fixture.connectHome, "providers", "deepseek");
      expect(existsSync(join(providerDirectory, "models.json"))).toBe(true);
      expect(existsSync(join(providerDirectory, "models.manifest.json"))).toBe(true);
      expect(existsSync(join(providerDirectory, "managed.toml"))).toBe(true);
      expect(existsSync(join(fixture.codexHome, "sf-deepseek.models.json"))).toBe(false);
      expect(existsSync(join(fixture.codexHome, "sf-deepseek.managed.toml"))).toBe(false);

      const profile = parse(readFileSync(
        join(fixture.codexHome, "sf-deepseek.config.toml"),
        "utf8",
      )) as Record<string, unknown>;
      expect(profile.model_catalog_json).toBe(join(providerDirectory, "models.json"));

      expect(existsSync(join(result.backupDirectory, "codex-home", "sf-deepseek.models.json")))
        .toBe(true);
      expect(existsSync(join(result.backupDirectory, "codex-home", "sf-deepseek.config.toml")))
        .toBe(true);
      expect(existsSync(join(result.backupDirectory, "reference", "config.toml"))).toBe(true);
      expect(existsSync(join(result.backupDirectory, "backup-manifest.json"))).toBe(true);
      expect(existsSync(join(result.backupDirectory, "providers", ".codex"))).toBe(false);
    } finally {
      fixture.remove();
    }
  });

  it("moves an existing current provider directory aside before migrating", () => {
    const fixture = createFixture();
    try {
      writeLegacyProvider(fixture, deepseekProviderDefinition);
      writeCurrentProviderDirectory(fixture, deepseekProviderDefinition, "current-catalog");
      writeConfigAndRole(fixture);

      const result = backupAndMigrateProviderFiles(fixture.environment, { apply: true });

      expect(result.status).toBe("migrated");
      if (result.status !== "migrated") throw new Error("unreachable");
      expect(result.movedDirectories).toEqual([
        expect.objectContaining({ provider: "deepseek" }),
      ]);

      const providerDirectory = join(fixture.connectHome, "providers", "deepseek");
      const catalog: { models: Array<{ slug: string }> } = JSON.parse(
        readFileSync(join(providerDirectory, "models.json"), "utf8"),
      );
      expect(catalog.models.map(({ slug }) => slug)).toEqual([
        "deepseek-v4-flash",
        "deepseek-v4-flash-vision-exp",
        "deepseek-v4-pro",
      ]);

      const originalDirectory = join(
        result.backupDirectory,
        "original-providers",
        "deepseek",
      );
      expect(existsSync(originalDirectory)).toBe(true);
      expect(readFileSync(join(originalDirectory, "models.json"), "utf8"))
        .toContain("current-catalog");
      expect(existsSync(join(originalDirectory, "backup", "state.json"))).toBe(true);
      expect(existsSync(join(result.backupDirectory, "providers", "deepseek", "models.json")))
        .toBe(true);
    } finally {
      fixture.remove();
    }
  });

  it("treats an already-migrated layout as a no-op", () => {
    const fixture = createFixture();
    try {
      writeCurrentProviderDirectory(fixture, deepseekProviderDefinition);

      const result = backupAndMigrateProviderFiles(fixture.environment, { apply: true });

      expect(result.status).toBe("already-migrated");
      expect(result.backupDirectory).toBeUndefined();
      expect(existsSync(join(fixture.connectHome, "providers", "deepseek", "models.json")))
        .toBe(true);
    } finally {
      fixture.remove();
    }
  });

  it("restores the moved current directory when migration fails", () => {
    const fixture = createFixture();
    try {
      writeLegacyProvider(fixture, deepseekProviderDefinition);
      writeCurrentProviderDirectory(fixture, deepseekProviderDefinition, "current-catalog");
      writeConfigAndRole(fixture);
      writeFileSync(
        join(fixture.codexHome, "sf-deepseek.config.toml"),
        "[",
        { mode: 0o600 },
      );

      expect(() => backupAndMigrateProviderFiles(fixture.environment, { apply: true }))
        .toThrow();

      const providerDirectory = join(fixture.connectHome, "providers", "deepseek");
      expect(readFileSync(join(providerDirectory, "models.json"), "utf8"))
        .toContain("current-catalog");
      expect(existsSync(join(fixture.codexHome, "sf-deepseek.models.json"))).toBe(true);
    } finally {
      fixture.remove();
    }
  });

  it("migrates DeepSeek while preserving accountless legacy OpenCode Go files", () => {
    const fixture = createFixture();
    try {
      writeLegacyProvider(fixture, deepseekProviderDefinition);
      writeLegacyProvider(fixture, opencodeGoProviderDefinition);
      writeConfigAndRole(fixture);

      const result = backupAndMigrateProviderFiles(fixture.environment, { apply: true });

      expect(result.status).toBe("migrated");
      expect(existsSync(join(
        fixture.connectHome,
        "providers",
        "deepseek",
        "models.json",
      ))).toBe(true);
      expect(existsSync(join(
        fixture.connectHome,
        "providers",
        "opencode-go",
        "models.json",
      ))).toBe(false);
      expect(existsSync(join(fixture.codexHome, "sf-opencode-go.models.json"))).toBe(true);
      expect(existsSync(join(fixture.codexHome, "sf-opencode-go.config.toml"))).toBe(true);
    } finally {
      fixture.remove();
    }
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codexc-backup-migrate-"));
  const codexHome = join(root, ".codex");
  const connectHome = join(root, ".codex-connect");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(join(connectHome, "providers"), { recursive: true, mode: 0o700 });
  return {
    root,
    codexHome,
    connectHome,
    environment: {
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: connectHome,
    } as NodeJS.ProcessEnv,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeLegacyProvider(
  fixture: ReturnType<typeof createFixture>,
  definition: ModelProviderDefinition,
) {
  const legacyId = definition.storageId ?? definition.id;
  const catalogPath = join(fixture.codexHome, `sf-${legacyId}.models.json`);
  writeFileSync(catalogPath, legacyCatalog(), { mode: 0o600 });
  writeFileSync(
    join(fixture.codexHome, `sf-${legacyId}.models.manifest.json`),
    JSON.stringify({ sha256: `legacy-${legacyId}` }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(fixture.codexHome, `sf-${legacyId}.managed.toml`),
    `version = 1\nprovider = "${legacyId}"\nmode = "switching"\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(fixture.codexHome, definition.profileFileName),
    [
      'model = "deepseek-v4-flash"',
      `model_provider = "${legacyId}"`,
      'model_reasoning_effort = "high"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      `[model_providers.${legacyId}]`,
      `name = "${legacyId}"`,
      `base_url = "${definition.baseUrl}"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      'experimental_bearer_token = "sk-test-secret"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function writeCurrentProviderDirectory(
  fixture: ReturnType<typeof createFixture>,
  definition: ModelProviderDefinition,
  catalogMarker = "current-catalog",
) {
  const directory = join(
    fixture.connectHome,
    "providers",
    definition.storageId ?? definition.id,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, "models.json"),
    `${JSON.stringify({ marker: catalogMarker })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(directory, "models.manifest.json"),
    JSON.stringify({ sha256: `current-${definition.id}` }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(directory, "managed.toml"),
    `version = 1\nprovider = "${definition.id}"\nmode = "switching"\n`,
    { mode: 0o600 },
  );
  const backupDirectory = join(directory, "backup");
  mkdirSync(backupDirectory, { mode: 0o700 });
  writeFileSync(
    join(backupDirectory, "state.json"),
    JSON.stringify({ keep: true }),
    { mode: 0o600 },
  );
}

function writeConfigAndRole(fixture: ReturnType<typeof createFixture>) {
  const rolePath = join(fixture.codexHome, "sf-agent.config.toml");
  writeFileSync(
    rolePath,
    [
      'model = "deepseek-v4-flash"',
      'model_provider = "deepseek"',
      `model_catalog_json = ${JSON.stringify(join(fixture.codexHome, "sf-deepseek.models.json"))}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  writeFileSync(
    join(fixture.codexHome, "config.toml"),
    [
      "[features]",
      "multi_agent_v2 = true",
      "",
      "[agents.external]",
      `config_file = ${JSON.stringify(rolePath)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function legacyCatalog(): string {
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
        { effort: "high", description: "High" },
        { effort: "max", description: "Max" },
      ],
    })),
  })}\n`;
}
