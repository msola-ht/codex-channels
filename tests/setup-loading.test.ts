import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const routes = [
  { choices: ["channels", "feishu"], option: "feishuSetup", module: "feishu-setup", entry: "runFeishuSetup" },
  { choices: ["channels", "telegram"], option: "telegramSetup", module: "telegram-setup", entry: "runTelegramSetup" },
  { choices: ["channels", "weixin"], option: "weixinSetup", module: "weixin-setup", entry: "runWeixinSetup" },
  { choices: ["skills"], option: "skillSetup", module: "skill-setup", entry: "runSkillSetup" },
  { choices: ["summary", "cancel"], option: "setupSummary", module: "setup-summary", entry: "writeSetupConfigurationSummary" },
  { choices: ["models", "official", "official_login"], option: "officialLoginSetup", module: "official-login-setup", entry: "runOfficialLoginSetup" },
  ...([
    ["deepseek", "deepseekSetup", "deepseek-account-setup", "runDeepseekSetup"],
    ["ccg", "ccgSetup", "ccg-setup", "runCcgSetup"],
    ["clp", "clinePassSetup", "cline-pass-setup", "runClinePassSetup"],
    ["opencode-go", "openCodeGoSetup", "opencode-go-setup", "runOpenCodeGoSetup"],
    ["provider_default", "modelProviderDefaultSetup", "model-provider-default-setup", "runModelProviderDefaultSetup"],
    ["model_window", "modelWindowSetup", "model-window-setup", "runModelWindowSetup"],
    ["custom_primary", "customPrimarySetup", "primary-provider-cli", "runCustomPrimaryProviderMenu"],
    ["custom_responses", "customPrimarySetup", "primary-provider-cli", "runCustomPrimaryProviderMenu"],
  ] as const).map(([choice, option, module, entry]) => ({ choices: ["models", "third_party", choice], option, module, entry })),
];
const setupUrl = pathToFileURL(resolve("scripts/setup.mjs")).href;
const optionalUrls = routes.map(({ module }) => pathToFileURL(resolve(`scripts/${module}.mjs`)).href);

// Each case uses a fresh ESM graph. Replaced handlers cannot read user data or contact platforms.
function runIsolatedSetup(action: string, replacement?: { module: string; source: string }) {
  const replacementUrl = replacement && pathToFileURL(resolve(`scripts/${replacement.module}.mjs`)).href;
  const loader = `
    export async function resolve(specifier, context, nextResolve) {
      if (["@larksuiteoapi/node-sdk", "grammy", "qrcode"].includes(specifier)) {
        throw new Error("Unexpected SDK: " + specifier);
      }
      const result = await nextResolve(specifier, context);
      if (${JSON.stringify(optionalUrls)}.includes(result.url) && result.url !== ${JSON.stringify(replacementUrl)}) {
        throw new Error("Unexpected setup module: " + result.url);
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
    import { register } from "node:module";
    register(${JSON.stringify("data:text/javascript," + encodeURIComponent(loader))}, import.meta.url);
    const { runSetup } = await import(${JSON.stringify(setupUrl)});
    const input = { isTTY: true };
    const output = { isTTY: true, write() {} };
    function promptsFor(choices) {
      return { intro() {}, cancel() {}, isCancel: () => false, select: async () => {
        assert.ok(choices.length, "Unexpected extra prompt");
        return choices.shift();
      } };
    }
    ${action}
  `], { encoding: "utf8", timeout: 10_000 });
}

describe("Setup lazy loading", () => {
  it("opens, returns through submenus and cancels without loading handlers", () => {
    const result = runIsolatedSetup(`
      for (const choices of [["cancel"], ["channels", "back", "models", "third_party", "back", "back", "cancel"]]) {
        await runSetup({ input, output, prompts: promptsFor(choices) });
        assert.equal(choices.length, 0);
      }
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects noninteractive use before loading handlers", () => {
    const result = runIsolatedSetup(`
      await assert.rejects(runSetup({ input: { isTTY: false }, output }), /交互终端/);
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(routes)("loads only the selected default handler: $choices", (route) => {
    const result = runIsolatedSetup(`
      const choices = ${JSON.stringify(route.choices)};
      await runSetup({ input, output, prompts: promptsFor(choices) });
      assert.equal(choices.length, 0);
    `, {
      module: route.module,
      source: `export function ${route.entry}(options) {
        console.log(JSON.stringify({ handler: ${JSON.stringify(route.entry)}, allowBack: options.allowBack, catalogKind: options.catalogKind }));
        return { action: "fixture" };
      }`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      handler: route.entry,
      ...(route.choices[1] === "third_party" ? { allowBack: true } : {}),
      ...(route.choices[2] === "custom_responses" ? { catalogKind: "custom" } : {}),
    });
  });

  it.each(routes)("uses an injected handler without loading its default: $option", (route) => {
    const result = runIsolatedSetup(`
      let calls = 0;
      const choices = ${JSON.stringify(route.choices)};
      await runSetup({ input, output, prompts: promptsFor(choices),
        ${route.option}: async (options) => {
          calls++;
          assert.equal(options.output, output);
          return { action: "fixture" };
        },
      });
      assert.equal(calls, 1);
      assert.equal(choices.length, 0);
    `);
    expect(result.status, result.stderr).toBe(0);
  });

  it("sanitizes a module loading failure and allows another selection", () => {
    const result = runIsolatedSetup(`
      const events = [];
      const choices = ["channels", "telegram", "cancel"];
      await runSetup({ input, output, prompts: promptsFor(choices), stayOnMenu: true,
        onResult: event => events.push(event),
      });
      assert.deepEqual(events, [
        { event: "error", category: "channels", message: "api_key=[REDACTED]" },
        { event: "cancelled" },
      ]);
    `, { module: "telegram-setup", source: 'throw new Error("api_key=fixture-secret");' });
    expect(result.status, result.stderr).toBe(0);
  });

  it("propagates child signals from a lazily loaded handler", () => {
    const signalModule = pathToFileURL(resolve("runtime/process-lifecycle.mjs")).href;
    const result = runIsolatedSetup(`
      const { ForwardedChildSignalError } = await import(${JSON.stringify(signalModule)});
      await assert.rejects(runSetup({ input, output,
        prompts: promptsFor(["models", "official", "official_login"]), stayOnMenu: true,
      }), error => error instanceof ForwardedChildSignalError && error.signal === "SIGINT");
    `, { module: "official-login-setup", source: `
      import { ForwardedChildSignalError } from ${JSON.stringify(signalModule)};
      export function runOfficialLoginSetup() { throw new ForwardedChildSignalError("SIGINT"); }
    ` });
    expect(result.status, result.stderr).toBe(0);
  });
});
