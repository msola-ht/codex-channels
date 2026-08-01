import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import {
  deepseekSetupScriptUrl,
  extractDeepseekCatalog,
  runDeepseekSetup,
} from "../scripts/deepseek-setup.mjs";

const script = `#!/bin/sh
cat > "$TMP_MODELS" <<'CODEX_MODELS_JSON'
{"models":[{"slug":"deepseek-v4-flash"},{"slug":"deepseek-v4-pro"}]}
CODEX_MODELS_JSON
`;

describe("DeepSeek setup", () => {
  it("extracts exactly one official model catalog heredoc", () => {
    expect(extractDeepseekCatalog(script).models).toHaveLength(2);
    expect(() => extractDeepseekCatalog("echo no-catalog")).toThrow("模型目录标记无效");
  });

  it("installs a switching profile without replacing the OpenAI default", async () => {
    const original = 'model = "gpt-5.4"\nmodel_provider = "openai"\n# keep formatting\n';
    const fixture = setupFixture(original);
    writeFileSync(join(fixture.home, "auth.json"), '{"tokens":"openai"}\n', { mode: 0o600 });
    const result = await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1"], ["sk-secret"]),
    });
    const config = parse(readFileSync(join(fixture.home, "config.toml"), "utf8"));
    expect(result?.mode).toBe("switching");
    expect(readFileSync(join(fixture.home, "config.toml"), "utf8")).toContain(
      '# keep formatting',
    );
    expect(config.model).toBe("gpt-5.4");
    expect(config.model_provider).toBe("openai");
    expect(record(config.profiles).deepseek).toBeUndefined();
    expect(record(config.model_providers).deepseek).toBeUndefined();
    expect(readFileSync(join(fixture.home, "config.toml"), "utf8")).toBe(original);
    const profile = parse(readFileSync(join(fixture.home, "deepseek.config.toml"), "utf8"));
    expect(profile.model).toBe("deepseek-v4-flash");
    expect(profile.model_provider).toBe("deepseek");
    expect(profile.preferred_auth_method).toBeUndefined();
    expect(profile.forced_login_method).toBeUndefined();
    expect(record(record(profile.model_providers).deepseek)).toMatchObject({
      name: "deepseek",
      base_url: "https://api.deepseek.com/",
      wire_api: "responses",
      requires_openai_auth: false,
      experimental_bearer_token: "sk-secret",
    });
    expect(parse(readFileSync(
      join(fixture.home, "codex-connect-deepseek.config.toml"),
      "utf8",
    ))).toEqual({ version: 1, provider: "deepseek", mode: "switching" });
    expect(readFileSync(join(fixture.home, "auth.json"), "utf8"))
      .toBe('{"tokens":"openai"}\n');
    expect(fixture.text()).not.toContain("sk-secret");
    expect(statSync(join(fixture.home, "config.toml")).mode & 0o777).toBe(0o600);
    expect(statSync(join(fixture.home, "deepseek.config.toml")).mode & 0o777).toBe(0o600);
    expect(statSync(join(fixture.home, "codex-connect-deepseek.config.toml")).mode & 0o777)
      .toBe(0o600);
    expect(readFileSync(join(fixture.home, "deepseek.models.manifest.json"), "utf8"))
      .toContain(deepseekSetupScriptUrl);
  });

  it("preserves OpenAI config changes made after a switching install", async () => {
    const original = 'model = "gpt-5.4"\ncustom_before = true\n';
    const fixture = setupFixture(original);
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1"], ["sk-first"]),
    });
    const current = 'model = "gpt-5.6-sol"\ncustom_after = true\n';
    writeFileSync(join(fixture.home, "config.toml"), current, { mode: 0o600 });

    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1"], ["sk-second"]),
    });

    expect(readFileSync(join(fixture.home, "config.toml"), "utf8")).toBe(current);
  });

  it("installs exclusive mode and keeps the initial config backup", async () => {
    const original = 'model = "gpt-5.4"\n';
    const fixture = setupFixture(original);
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["2"], ["sk-fixed"], true),
    });
    const config = parse(readFileSync(join(fixture.home, "config.toml"), "utf8"));
    expect(config.model).toBe("deepseek-v4-flash");
    expect(config.model_provider).toBe("deepseek");
    expect(config.forced_login_method).toBeUndefined();
    expect(config.preferred_auth_method).toBeUndefined();
    expect(existsSync(join(fixture.home, "deepseek.config.toml"))).toBe(false);
    expect(parse(readFileSync(
      join(fixture.home, "codex-connect-deepseek.config.toml"),
      "utf8",
    ))).toEqual({ version: 1, provider: "deepseek", mode: "exclusive" });
    expect(readFileSync(
      join(fixture.home, "backup-codex-connect-deepseek", "config.toml"),
      "utf8",
    )).toBe(original);
  });

  it("does not modify Codex files when the download fails", async () => {
    const original = 'model = "gpt-5.4"\n';
    const fixture = setupFixture(original);
    await expect(runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: vi.fn(async () => new Response("failed", { status: 503 })),
      prompter: prompter(["1"], ["sk-secret"]),
    })).rejects.toThrow("HTTP 503");
    expect(readFileSync(join(fixture.home, "config.toml"), "utf8")).toBe(original);
  });

  it("removes exclusive defaults when the original config did not exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-deepseek-empty-"));
    const fixture = outputFixture(home);
    await runDeepseekSetup({
      environment: { CODEX_HOME: home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["2"], ["sk-fixed"], true),
    });
    await runDeepseekSetup({
      environment: { CODEX_HOME: home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1"], ["sk-switching"]),
    });
    expect(existsSync(join(home, "config.toml"))).toBe(false);
    const profile = parse(readFileSync(join(home, "deepseek.config.toml"), "utf8"));
    expect(profile.model).toBe("deepseek-v4-flash");
    expect(record(record(profile.model_providers).deepseek).experimental_bearer_token)
      .toBe("sk-switching");
  });

  it("restores managed fields but preserves unrelated edits when leaving exclusive mode", async () => {
    const original = 'model = "gpt-5.4"\nmodel_provider = "openai"\n';
    const fixture = setupFixture(original);
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["2"], ["sk-fixed"], true),
    });
    const exclusive = readFileSync(join(fixture.home, "config.toml"), "utf8");
    writeFileSync(
      join(fixture.home, "config.toml"),
      `custom_after = true\n${exclusive}`,
      { mode: 0o600 },
    );

    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1"], ["sk-switching"]),
    });

    const config = parse(readFileSync(join(fixture.home, "config.toml"), "utf8"));
    expect(config).toMatchObject({
      model: "gpt-5.4",
      model_provider: "openai",
      custom_after: true,
    });
    expect(record(config.model_providers).deepseek).toBeUndefined();
  });

  it("migrates the legacy managed profile created by an earlier setup", async () => {
    const original = 'model = "gpt-5.4"\nmodel_provider = "openai"\n';
    const fixture = setupFixture(`${original}\n[profiles.deepseek]\nmodel = "deepseek-v4-flash"\n`);
    const backupDirectory = join(fixture.home, "backup-codex-connect-deepseek");
    mkdirSync(backupDirectory);
    writeFileSync(join(backupDirectory, "config.toml"), original, { mode: 0o600 });
    writeFileSync(
      join(backupDirectory, "state.json"),
      '{"originalConfigExisted":true}\n',
      { mode: 0o600 },
    );

    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1"], ["sk-migrated"]),
    });

    const config = parse(readFileSync(join(fixture.home, "config.toml"), "utf8"));
    expect(record(config.profiles).deepseek).toBeUndefined();
    expect(config.model).toBe("gpt-5.4");
    expect(config.model_provider).toBe("openai");
    expect(record(config.model_providers).deepseek).toBeUndefined();
    const profile = parse(readFileSync(join(fixture.home, "deepseek.config.toml"), "utf8"));
    expect(profile.model).toBe("deepseek-v4-flash");
    expect(record(record(profile.model_providers).deepseek).experimental_bearer_token)
      .toBe("sk-migrated");
  });

  it("repairs the previous switching layout that polluted the OpenAI base config", async () => {
    const original = 'model = "gpt-5.4"\nmodel_provider = "openai"\n';
    const polluted = `${original}\n[model_providers.deepseek]\nname = "deepseek"\nbase_url = "https://api.deepseek.com/"\nwire_api = "responses"\nexperimental_bearer_token = "sk-old"\n`;
    const fixture = setupFixture(polluted);
    writeFileSync(
      join(fixture.home, "deepseek.config.toml"),
      'model = "deepseek-v4-flash"\nmodel_provider = "deepseek"\nforced_login_method = "api"\n',
      { mode: 0o600 },
    );
    const backupDirectory = join(fixture.home, "backup-codex-connect-deepseek");
    mkdirSync(backupDirectory);
    writeFileSync(join(backupDirectory, "config.toml"), original, { mode: 0o600 });
    writeFileSync(
      join(backupDirectory, "state.json"),
      JSON.stringify({
        originalConfigExisted: true,
        originalProfileExisted: false,
        originalGatewayProfileExisted: false,
      }),
      { mode: 0o600 },
    );

    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1"], ["sk-repaired"]),
    });

    expect(readFileSync(join(fixture.home, "config.toml"), "utf8")).toBe(original);
    const profile = parse(readFileSync(join(fixture.home, "deepseek.config.toml"), "utf8"));
    expect(profile.forced_login_method).toBeUndefined();
    expect(record(record(profile.model_providers).deepseek).experimental_bearer_token)
      .toBe("sk-repaired");
  });

  it("restores the exact initial config", async () => {
    const original = 'model = "gpt-5.4"\n# keep me\n';
    const fixture = setupFixture(original);
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["2"], ["sk-fixed"], true),
    });
    const result = await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: vi.fn(),
      prompter: prompter(["3"], [], true),
    });
    expect(result?.mode).toBe("restored");
    expect(readFileSync(join(fixture.home, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(fixture.home, "deepseek.config.toml"))).toBe(false);
  });

  it("does not treat a user DeepSeek provider added after restore as legacy managed config", async () => {
    const original = 'model = "gpt-5.4"\n';
    const fixture = setupFixture(original);
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["2"], ["sk-fixed"], true),
    });
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: vi.fn(),
      prompter: prompter(["3"], [], true),
    });
    const userConfig = `${original}\n[model_providers.deepseek]\nname = "user-managed"\n`;
    writeFileSync(join(fixture.home, "config.toml"), userConfig, { mode: 0o600 });

    await expect(runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1"], ["sk-second"]),
    })).rejects.toThrow("已存在 deepseek Provider");
    expect(readFileSync(join(fixture.home, "config.toml"), "utf8")).toBe(userConfig);
  });

  it("backs up and restores an existing deepseek profile file", async () => {
    const originalConfig = 'model = "gpt-5.4"\n';
    const originalProfile = 'model = "custom-deepseek"\n';
    const originalGatewayProfile = '[model_providers.custom]\nname = "custom"\n';
    const fixture = setupFixture(originalConfig);
    writeFileSync(join(fixture.home, "deepseek.config.toml"), originalProfile, { mode: 0o600 });
    writeFileSync(
      join(fixture.home, "codex-connect-deepseek.config.toml"),
      originalGatewayProfile,
      { mode: 0o600 },
    );

    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1"], ["sk-secret"]),
    });
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: vi.fn(),
      prompter: prompter(["3"], [], true),
    });

    expect(readFileSync(join(fixture.home, "config.toml"), "utf8")).toBe(originalConfig);
    expect(readFileSync(join(fixture.home, "deepseek.config.toml"), "utf8"))
      .toBe(originalProfile);
    expect(readFileSync(join(fixture.home, "codex-connect-deepseek.config.toml"), "utf8"))
      .toBe(originalGatewayProfile);
  });
});

function setupFixture(config: string) {
  const home = mkdtempSync(join(tmpdir(), "codexc-deepseek-"));
  writeFileSync(join(home, "config.toml"), config, { mode: 0o600 });
  return outputFixture(home);
}

function outputFixture(home: string) {
  let value = "";
  const output = new Writable({ write(chunk, _encoding, callback) { value += chunk; callback(); } });
  return { home, output, text: () => value };
}

function successfulFetch() {
  return Promise.resolve(new Response(script, {
    status: 200,
    headers: { "content-length": String(Buffer.byteLength(script)) },
  }));
}

function prompter(answers: string[], secrets: string[], confirmation = false) {
  return {
    ask: vi.fn(async () => answers.shift() ?? ""),
    secret: vi.fn(async () => secrets.shift() ?? ""),
    confirm: vi.fn(async () => confirmation),
    close: vi.fn(),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
