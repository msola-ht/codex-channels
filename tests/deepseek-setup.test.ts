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

import { parse, stringify } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import {
  deepseekSetupScriptUrl,
  downloadDeepseekCatalog,
  extractDeepseekCatalog,
  runDeepseekSetup as runDeepseekSetupImplementation,
  type DeepseekSetupOptions,
} from "../scripts/deepseek-setup.mjs";
import {
  configureThirdPartyRole,
} from "../scripts/agents.mjs";
import type {
  CodexUserConfigEdit,
  CodexUserConfigValue,
} from "../scripts/codex-user-config.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";

const script = `#!/bin/sh
cat > "$TMP_MODELS" <<'CODEX_MODELS_JSON'
{"models":[{"slug":"deepseek-v4-flash","context_window":1048576},{"slug":"deepseek-v4-pro","context_window":1048576}]}
CODEX_MODELS_JSON
`;

function runDeepseekSetup(options: DeepseekSetupOptions = {}) {
  return runDeepseekSetupImplementation({
    ...options,
    configureRole: (provider, model, environment) => configureThirdPartyRole(
      provider,
      model,
      environment,
      { updateConfig: applyConfigUpdate },
    ),
  });
}

describe("DeepSeek setup", () => {
  it("extracts exactly one official model catalog heredoc", () => {
    expect(extractDeepseekCatalog(script).models).toHaveLength(2);
    expect(() => extractDeepseekCatalog("echo no-catalog")).toThrow("模型目录标记无效");
  });

  it("returns to the parent setup without reading a key or changing files", async () => {
    const fixture = setupFixture('model = "gpt-5.4"\n');
    const fetchImpl = vi.fn();
    const prompt = prompter(["5"], []);

    await expect(runDeepseekSetup({
      allowBack: true,
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl,
      prompter: prompt,
    })).resolves.toEqual({ action: "back" });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readFileSync(join(fixture.home, "config.toml"), "utf8"))
      .toBe('model = "gpt-5.4"\n');
  });

  it("shows a return option in the model channel menu", async () => {
    const select = vi.fn(async () => "5");

    await expect(runDeepseekSetup({
      allowBack: true,
      output: outputFixture(mkdtempSync(join(tmpdir(), "codexc-deepseek-menu-"))).output,
      prompts: {
        select,
        text: vi.fn(),
        password: vi.fn(),
        confirm: vi.fn(),
        isCancel: () => false,
      },
    })).resolves.toEqual({ action: "back" });

    expect(select).toHaveBeenCalledWith({
      message: "选择 DeepSeek 安装模式",
      options: [
        { value: "1", label: "OpenAI + DeepSeek 切换模式" },
        { value: "2", label: "仅 DeepSeek 固定模式" },
        { value: "3", label: "恢复安装前配置" },
        { value: "4", label: "修改自动压缩阈值" },
        { value: "5", label: "返回上一级" },
      ],
    });
  });

  it("returns to the parent setup when a nested auto-compact prompt is cancelled", async () => {
    const fixture = setupFixture('model = "gpt-5.4"\n');
    const cancelled = Symbol("cancelled");
    const select = vi.fn()
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce(cancelled);
    const fetchImpl = vi.fn();

    await expect(runDeepseekSetup({
      allowBack: true,
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl,
      prompts: {
        select,
        password: vi.fn(async () => "sk-secret"),
        text: vi.fn(),
        confirm: vi.fn(),
        isCancel: (value: unknown) => value === cancelled,
      },
    })).resolves.toEqual({ action: "back" });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readFileSync(join(fixture.home, "config.toml"), "utf8"))
      .toBe('model = "gpt-5.4"\n');
  });

  it("retries retryable download failures and passes an abort signal", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockImplementationOnce(successfulFetch);

    await expect(downloadDeepseekCatalog(fetchImpl, {
      sleep: async () => undefined,
    })).resolves.toMatchObject({ catalog: { models: expect.any(Array) } });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("times out a stalled official script download", async () => {
    const fetchImpl = vi.fn((
      _url: string | URL | Request,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));

    await expect(downloadDeepseekCatalog(fetchImpl, {
      attempts: 1,
      timeoutMs: 5,
    })).rejects.toThrow("下载超时");
  });

  it("stops reading an oversized streamed official script", async () => {
    const oversizedChunk = new Uint8Array((2 * 1024 * 1024) + 1);
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(oversizedChunk);
        controller.close();
      },
    })));

    await expect(downloadDeepseekCatalog(fetchImpl, { attempts: 1 }))
      .rejects.toThrow("超过允许大小");
  });

  it("installs a switching profile without replacing the OpenAI default", async () => {
    const original = 'model = "gpt-5.4"\nmodel_provider = "openai"\n# keep formatting\n';
    const fixture = setupFixture(original);
    writeFileSync(join(fixture.home, "auth.json"), '{"tokens":"openai"}\n', { mode: 0o600 });
    const result = await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1", "2"], ["sk-secret"]),
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
    expect(config.features).toMatchObject({ multi_agent_v2: true });
    expect(record(config.agents).external).toMatchObject({
      description:
        "第三方模型单次子代理；仅处理当前用户消息中的完整任务，必须使用 fork_turns=1，不能接收后续消息",
      config_file: join(fixture.home, "codex-connect-third-party-subagent.config.toml"),
      nickname_candidates: ["DeepSeek"],
    });
    const roleConfigPath = join(fixture.home, "codex-connect-third-party-subagent.config.toml");
    expect(existsSync(roleConfigPath)).toBe(true);
    expect(parse(readFileSync(roleConfigPath, "utf8"))).toMatchObject({
      model: "deepseek-v4-flash",
      model_provider: "deepseek",
    });
    expect(readFileSync(roleConfigPath, "utf8")).not.toContain("sk-secret");
    const profile = parse(readFileSync(join(fixture.home, "deepseek.config.toml"), "utf8"));
    expect(profile.model).toBe("deepseek-v4-flash");
    expect(profile.model_provider).toBe("deepseek");
    expect(profile.model_auto_compact_token_limit).toBe(629_146);
    expect(profile.model_auto_compact_token_limit_scope).toBe("total");
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
      prompter: prompter(["1", "2"], ["sk-first"]),
    });
    const current = 'model = "gpt-5.6-sol"\ncustom_after = true\n';
    writeFileSync(join(fixture.home, "config.toml"), current, { mode: 0o600 });

    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1", "2"], ["sk-second"]),
    });

    const updated = parse(readFileSync(join(fixture.home, "config.toml"), "utf8"));
    expect(updated).toMatchObject({
      model: "gpt-5.6-sol",
      custom_after: true,
      features: { multi_agent_v2: true },
    });
    expect(record(updated.agents).external).toBeDefined();
  });

  it("rejects a custom external role without modifying DeepSeek files", async () => {
    const original = [
      'model = "gpt-5.4"',
      "[agents.external]",
      'description = "User managed role"',
      'config_file = "/opt/custom/ds.toml"',
      "",
    ].join("\n");
    const fixture = setupFixture(original);
    const fetchImpl = vi.fn(successfulFetch);

    await expect(runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl,
      prompter: prompter(["1", "2"], ["sk-secret"]),
    })).rejects.toThrow("agents.external 已由用户配置");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readFileSync(join(fixture.home, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(fixture.home, "deepseek.config.toml"))).toBe(false);
  });

  it("restores every installation target when the role config transaction fails", async () => {
    const original = 'model = "gpt-5.4"\ncustom = true\n';
    const fixture = setupFixture(original);

    await expect(runDeepseekSetupImplementation({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1", "2"], ["sk-secret"]),
      configureRole: vi.fn(async () => {
        throw new Error("config version conflict");
      }),
    })).rejects.toThrow("config version conflict");

    expect(readFileSync(join(fixture.home, "config.toml"), "utf8")).toBe(original);
    for (const name of [
      "deepseek.config.toml",
      "codex-connect-deepseek.config.toml",
      "deepseek.models.json",
      "deepseek.models.manifest.json",
      "codex-connect-third-party-subagent.config.toml",
    ]) {
      expect(existsSync(join(fixture.home, name))).toBe(false);
    }
  });

  it("does not overwrite a concurrent config change while rolling back a failed install", async () => {
    const fixture = setupFixture('model = "gpt-5.4"\n');
    const concurrent = 'model = "gpt-5.6-sol"\nconcurrent = true\n';

    await expect(runDeepseekSetupImplementation({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1", "2"], ["sk-secret"]),
      configureRole: vi.fn(async () => {
        writeFileSync(join(fixture.home, "config.toml"), concurrent, { mode: 0o600 });
        throw new Error("config version conflict");
      }),
    })).rejects.toThrow("未能完整恢复操作前文件");

    expect(readFileSync(join(fixture.home, "config.toml"), "utf8")).toBe(concurrent);
  });

  it("installs exclusive mode and keeps the initial config backup", async () => {
    const original = 'model = "gpt-5.4"\n';
    const fixture = setupFixture(original);
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["2", "2"], ["sk-fixed"], true),
    });
    const config = parse(readFileSync(join(fixture.home, "config.toml"), "utf8"));
    expect(config.model).toBe("deepseek-v4-flash");
    expect(config.model_provider).toBe("deepseek");
    expect(config.forced_login_method).toBeUndefined();
    expect(config.preferred_auth_method).toBeUndefined();
    expect(config.features).toMatchObject({ multi_agent_v2: true });
    expect(record(config.agents).external).toBeDefined();
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

  it("keeps the shared third-party role on DeepSeek when switching to exclusive mode", async () => {
    const fixture = setupFixture('model = "gpt-5.4"\n');
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1", "2"], ["sk-switching"]),
    });

    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["2", "2"], ["sk-exclusive"], true),
    });

    const config = parse(readFileSync(join(fixture.home, "config.toml"), "utf8"));
    expect(record(config.agents).external).toBeDefined();
    expect(config.features).toMatchObject({ multi_agent_v2: true });
  });

  it("removes stale auto-compact fields when exclusive mode is reinstalled disabled", async () => {
    const fixture = setupFixture('model = "gpt-5.4"\n');
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["2", "2"], ["sk-first"], true),
    });
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["2", "1"], ["sk-second"], true),
    });

    const config = parse(readFileSync(join(fixture.home, "config.toml"), "utf8"));
    expect(config.model_auto_compact_token_limit).toBeUndefined();
    expect(config.model_auto_compact_token_limit_scope).toBeUndefined();
  });

  it("does not modify Codex files when the download fails", async () => {
    const original = 'model = "gpt-5.4"\n';
    const fixture = setupFixture(original);
    await expect(runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: vi.fn(async () => new Response("failed", { status: 404 })),
      prompter: prompter(["1", "2"], ["sk-secret"]),
    })).rejects.toThrow("HTTP 404");
    expect(readFileSync(join(fixture.home, "config.toml"), "utf8")).toBe(original);
  });

  it("removes exclusive defaults when the original config did not exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-deepseek-empty-"));
    const fixture = outputFixture(home);
    await runDeepseekSetup({
      environment: { CODEX_HOME: home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["2", "2"], ["sk-fixed"], true),
    });
    await runDeepseekSetup({
      environment: { CODEX_HOME: home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1", "2"], ["sk-switching"]),
    });
    const config = parse(readFileSync(join(home, "config.toml"), "utf8"));
    expect(config.features).toMatchObject({ multi_agent_v2: true });
    expect(record(config.agents).external).toBeDefined();
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
      prompter: prompter(["2", "2"], ["sk-fixed"], true),
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
      prompter: prompter(["1", "2"], ["sk-switching"]),
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
      prompter: prompter(["1", "2"], ["sk-migrated"]),
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
      prompter: prompter(["1", "2"], ["sk-repaired"]),
    });

    const repaired = parse(readFileSync(join(fixture.home, "config.toml"), "utf8"));
    expect(repaired).toMatchObject({
      model: "gpt-5.4",
      model_provider: "openai",
      features: { multi_agent_v2: true },
    });
    expect(record(repaired.model_providers).deepseek).toBeUndefined();
    expect(record(repaired.agents).external).toBeDefined();
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
      prompter: prompter(["2", "2"], ["sk-fixed"], true),
    });
    const backupStatePath = join(
      fixture.home,
      "backup-codex-connect-deepseek",
      "state.json",
    );
    const legacyState = JSON.parse(readFileSync(backupStatePath, "utf8"));
    delete legacyState.originalRoleConfigExisted;
    writeFileSync(backupStatePath, `${JSON.stringify(legacyState)}\n`, { mode: 0o600 });
    writeFileSync(
      join(fixture.home, "codex-connect-opencode-go.config.toml"),
      'version = 1\nprovider = "opencode-go"\nmode = "switching"\n',
      { mode: 0o600 },
    );
    const result = await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: vi.fn(),
      prompter: prompter(["3"], [], true),
    });
    expect(result?.mode).toBe("restored");
    expect(readFileSync(join(fixture.home, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(fixture.home, "deepseek.config.toml"))).toBe(false);
    expect(existsSync(join(fixture.home, "codex-connect-third-party-subagent.config.toml")))
      .toBe(false);
    expect(existsSync(join(fixture.home, "deepseek.models.json"))).toBe(true);
  });

  it("does not treat a user DeepSeek provider added after restore as legacy managed config", async () => {
    const original = 'model = "gpt-5.4"\n';
    const fixture = setupFixture(original);
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["2", "2"], ["sk-fixed"], true),
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
      prompter: prompter(["1", "2"], ["sk-second"]),
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
      prompter: prompter(["1", "2"], ["sk-secret"]),
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
    expect(existsSync(join(fixture.home, "codex-connect-third-party-subagent.config.toml")))
      .toBe(false);
  });

  it("backs up and restores an existing managed-path role file", async () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-deepseek-role-backup-"));
    const roleConfigPath = join(home, "codex-connect-third-party-subagent.config.toml");
    const originalRole = 'developer_instructions = "User role file"\n';
    const originalConfig = [
      'model = "gpt-5.4"',
      "[agents.external]",
      'description = "User role"',
      `config_file = ${JSON.stringify(roleConfigPath)}`,
      "",
    ].join("\n");
    writeFileSync(join(home, "config.toml"), originalConfig, { mode: 0o600 });
    writeFileSync(roleConfigPath, originalRole, { mode: 0o600 });
    const fixture = outputFixture(home);

    await runDeepseekSetup({
      environment: { CODEX_HOME: home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1", "2"], ["sk-secret"]),
    });
    await runDeepseekSetup({
      environment: { CODEX_HOME: home },
      output: fixture.output,
      fetchImpl: vi.fn(),
      prompter: prompter(["3"], [], true),
    });

    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(originalConfig);
    expect(readFileSync(roleConfigPath, "utf8")).toBe(originalRole);
  });

  it("rejects an invalid role backup state before restoring files", async () => {
    const fixture = setupFixture('model = "gpt-5.4"\n');
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1", "2"], ["sk-secret"]),
    });
    const configPath = join(fixture.home, "config.toml");
    const roleConfigPath = join(fixture.home, "codex-connect-third-party-subagent.config.toml");
    const configBeforeRestore = readFileSync(configPath, "utf8");
    const roleBeforeRestore = readFileSync(roleConfigPath, "utf8");
    const backupStatePath = join(
      fixture.home,
      "backup-codex-connect-deepseek",
      "state.json",
    );
    const state = JSON.parse(readFileSync(backupStatePath, "utf8"));
    state.originalRoleConfigExisted = "yes";
    writeFileSync(backupStatePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    await expect(runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: vi.fn(),
      prompter: prompter(["3"], [], true),
    })).rejects.toThrow("Codex 初始配置备份状态无效");

    expect(readFileSync(configPath, "utf8")).toBe(configBeforeRestore);
    expect(readFileSync(roleConfigPath, "utf8")).toBe(roleBeforeRestore);
  });

  it("modifies and disables the auto-compact threshold of an existing profile", async () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-deepseek-auto-compact-"));
    const fixture = outputFixture(home);
    await runDeepseekSetup({
      environment: { CODEX_HOME: home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["1", "2"], ["sk-secret"]),
    });

    const updated = await runDeepseekSetup({
      environment: { CODEX_HOME: home },
      output: fixture.output,
      fetchImpl: vi.fn(),
      prompter: prompter(["4", "3", "70"], []),
    });
    expect(updated).toMatchObject({ action: "auto-compact", autoCompactPercent: 70 });
    const profile = parse(readFileSync(join(home, "deepseek.config.toml"), "utf8"));
    expect(profile.model_auto_compact_token_limit).toBe(734_003);
    expect(profile.model_auto_compact_token_limit_scope).toBe("total");

    await runDeepseekSetup({
      environment: { CODEX_HOME: home },
      output: fixture.output,
      fetchImpl: vi.fn(),
      prompter: prompter(["4", "1"], []),
    });
    const disabled = parse(readFileSync(join(home, "deepseek.config.toml"), "utf8"));
    expect(disabled.model_auto_compact_token_limit).toBeUndefined();
    expect(disabled.model_auto_compact_token_limit_scope).toBeUndefined();
  });

  it("updates exclusive auto-compact settings through one user config transaction", async () => {
    const fixture = setupFixture('model = "gpt-5.4"\n');
    await runDeepseekSetup({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: successfulFetch,
      prompter: prompter(["2", "2"], ["sk-fixed"], true),
    });
    const writeConfigEdits = vi.fn(async () => undefined);

    await runDeepseekSetupImplementation({
      environment: { CODEX_HOME: fixture.home },
      output: fixture.output,
      fetchImpl: vi.fn(),
      prompter: prompter(["4", "3", "70"], []),
      writeConfigEdits,
    });

    expect(writeConfigEdits).toHaveBeenCalledWith(
      { CODEX_HOME: fixture.home },
      [{
        keyPath: "model_auto_compact_token_limit",
        value: 734_003,
      }, {
        keyPath: "model_auto_compact_token_limit_scope",
        value: "total",
      }],
    );
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
    text: vi.fn(async () => answers.shift() ?? ""),
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

async function applyConfigUpdate(
  environment: NodeJS.ProcessEnv,
  createEdits: (
    config: Record<string, CodexUserConfigValue | undefined>,
  ) => CodexUserConfigEdit[],
): Promise<void> {
  const configPath = join(String(environment.CODEX_HOME), "config.toml");
  const source = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const comments = source
    .split("\n")
    .filter((line) => line.trimStart().startsWith("#"));
  const document = source === "" ? {} : record(parse(source));
  const edits = createEdits(document as Record<string, CodexUserConfigValue | undefined>);
  for (const edit of edits) {
    if (edit.keyPath === "features.multi_agent_v2") {
      const features = record(document.features);
      features.multi_agent_v2 = edit.value;
      document.features = features;
      continue;
    }
    if (edit.keyPath === "agents.external") {
      const agents = record(document.agents);
      if (edit.value === null) {
        delete agents.external;
      } else {
        agents.external = edit.value;
      }
      if (Object.keys(agents).length === 0) {
        delete document.agents;
      } else {
        document.agents = agents;
      }
      continue;
    }
    throw new Error(`测试配置事务不支持：${edit.keyPath}`);
  }
  const prefix = comments.length === 0 ? "" : `${comments.join("\n")}\n`;
  writePrivateFileAtomicSync(configPath, `${prefix}${stringify(document)}`);
}
