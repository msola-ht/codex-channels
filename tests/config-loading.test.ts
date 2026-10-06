import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const routes = [
  ["codex_user", "codex-user-settings-setup", "runCodexUserSettingsSetup"],
  ["display", "config-display-menu", "runDisplaySettings"],
  ["system", "config-system-menu", "runSystemSettings"],
  ["scheduled_tasks", "config-advanced-menu", "runScheduledTasks"],
  ["network", "config-advanced-menu", "runNetworkSettings"],
  ["advanced", "config-advanced-menu", "runAdvancedSettings"],
  ["relay", "model-relay-listen-menu", "runRelayListenMenu"],
  ["webui", "config-webui-menu", "runWebuiSettings"],
  ["metrics", "metrics-config-menu", "runMetricsSettings"],
] as const;
const moduleUrl = (name: string) => pathToFileURL(resolve(`scripts/${name}.mjs`)).href;
const optionalUrls = [...routes.map(([, module]) => moduleUrl(module)), moduleUrl("config-summary")];

function runIsolatedConfig(action: string, replacement?: { module: string; source: string }) {
  const replacementUrl = replacement && moduleUrl(replacement.module);
  const loader = `
    export async function resolve(specifier, context, nextResolve) {
      const result = await nextResolve(specifier, context);
      if (${JSON.stringify(optionalUrls)}.includes(result.url) && result.url !== ${JSON.stringify(replacementUrl)}) {
        throw new Error("Unexpected Config module: " + result.url);
      }
      return result;
    }
    export async function load(url, context, nextLoad) {
      if (url === ${JSON.stringify(replacementUrl)}) {
        return { format: "module", source: ${JSON.stringify(replacement?.source)}, shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { register } from "node:module";
    register(${JSON.stringify("data:text/javascript," + encodeURIComponent(loader))}, import.meta.url);
    const { runConfig } = await import(${JSON.stringify(moduleUrl("config"))});
    const root = mkdtempSync(join(tmpdir(), "config-loading-"));
    const configPath = join(root, "config.toml");
    const environment = { CODEX_CONNECT_CONFIG_FILE: configPath, CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: root };
    const input = { isTTY: true };
    const output = { isTTY: true, write() {} };
    const writeConfig = () => { throw new Error("Unexpected write"); };
    function promptsFor(choices) {
      return { intro() {}, cancel() {}, isCancel: () => false, select: async () => {
        assert.ok(choices.length, "Unexpected extra prompt");
        return choices.shift();
      } };
    }
    try {
      writeFileSync(configPath, '[telegram]\\nbot_token = "fixture"\\n');
      ${action}
    } finally { rmSync(root, { recursive: true, force: true }); }
  `], { encoding: "utf8", timeout: 10_000 });
}

describe("Config lazy loading", () => {
  describe("without optional modules", () => {
    let result: ReturnType<typeof runIsolatedConfig>;

    beforeAll(() => {
      result = runIsolatedConfig(`
        writeFileSync(configPath, "[broken");
        assert.equal((await runConfig({ environment, json: true, prompts: null, output })).exists, true);
        assert.equal(await runConfig({ environment, input: { isTTY: false }, output }), undefined);
        assert.equal((await runConfig({ environment, paths: true, input: { isTTY: false }, output })).action, "paths");
        await runConfig({ environment, input, output, prompts: promptsFor(["paths", "cancel"]) });
        console.log("paths passed");

        writeFileSync(configPath, "[broken");
        let called = false;
        await runConfig({ environment, input, output, prompts: promptsFor(["codex_user"]),
          codexUserSettingsSetup: async () => { called = true; },
        });
        assert.equal(called, true);
        console.log("injected handler passed");

        writeFileSync(configPath, "[broken");
        await assert.rejects(runConfig({ environment, input, output, prompts: promptsFor(["display"]) }), /语法无效/);
        console.log("invalid config passed");
      `);
    });

    it("keeps JSON paths, noninteractive paths and cancellation independent of submenus", () => {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("paths passed");
    });

    it("uses injected Codex settings even with broken Gateway config and no default handler", () => {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("injected handler passed");
    });

    it("rejects broken Gateway config before loading a dependent submenu", () => {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("invalid config passed");
    });
  });

  it.each(routes)("loads only the selected %s handler and forwards its existing ports", (section, module, entry) => {
    const result = runIsolatedConfig(`
      const prompts = promptsFor([${JSON.stringify(section)}]);
      globalThis.expected = ${section === "codex_user"
        ? "{ environment, output, prompts }"
        : "{ environment, input, output, prompts, writeConfig, telegramConfigured: true }"};
      assert.deepEqual(await runConfig({ environment, input, output, prompts, writeConfig }), { action: "fixture" });
    `, { module, source: `
      import assert from "node:assert/strict";
      export function ${entry}(options) {
        assert.deepEqual(options, globalThis.expected);
        for (const key of Object.keys(options)) assert.equal(options[key], globalThis.expected[key]);
        return { action: "fixture" };
      }
    ` });
    expect(result.status, result.stderr).toBe(0);
  });

  it("loads summary only on selection and passes the current document", () => {
    const result = runIsolatedConfig(`
      globalThis.expected = { output, configPath, environment };
      await runConfig({ environment, input, output, prompts: promptsFor(["summary", "cancel"]) });
      assert.equal(globalThis.summarized, true);
    `, { module: "config-summary", source: `
      import assert from "node:assert/strict";
      export function writeGatewayConfigSummary(output, document, configPath, environment) {
        assert.equal(output, globalThis.expected.output);
        assert.equal(configPath, globalThis.expected.configPath);
        assert.equal(environment, globalThis.expected.environment);
        assert.equal(document.telegram.bot_token, "fixture");
        globalThis.summarized = true;
      }
    ` });
    expect(result.status, result.stderr).toBe(0);
  });

  it("refreshes config after a lazily loaded submenu returns", () => {
    const result = runIsolatedConfig(`
      globalThis.calls = 0;
      await runConfig({ environment, input, output, prompts: promptsFor(["display", "display", "cancel"]) });
      assert.equal(globalThis.calls, 2);
    `, { module: "config-display-menu", source: `
      import assert from "node:assert/strict";
      import { writeFileSync } from "node:fs";
      export function runDisplaySettings(options) {
        assert.equal(options.telegramConfigured, globalThis.calls === 0);
        globalThis.calls++;
        writeFileSync(options.environment.CODEX_CONNECT_CONFIG_FILE, '[telegram]\\nbot_token = ""\\n');
        return { action: "back" };
      }
    ` });
    expect(result.status, result.stderr).toBe(0);
  });

  it("reports loading failures and continues the menu", () => {
    const result = runIsolatedConfig(`
      await runConfig({ environment, input, output, stayOnMenu: true, prompts: promptsFor(["relay", "paths", "cancel"]) });
    `, { module: "model-relay-listen-menu", source: 'throw new Error("fixture loading failure");' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("fixture loading failure");
  });
});
