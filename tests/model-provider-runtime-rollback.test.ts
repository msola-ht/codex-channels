import {
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const runtimeFileFailures = vi.hoisted(() => ({
  unlinkPath: undefined as string | undefined,
  atomicWritePath: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: (path: string) => {
      if (path === runtimeFileFailures.unlinkPath) {
        throw new Error("injected Profile deletion failure");
      }
      return actual.unlinkSync(path);
    },
  };
});

vi.mock("../runtime/private-file.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/private-file.mjs")>();
  return {
    ...actual,
    writePrivateFileAtomicSync: (path: string, content: string) => {
      if (path === runtimeFileFailures.atomicWritePath) {
        throw new Error("injected registry rollback failure");
      }
      return actual.writePrivateFileAtomicSync(path, content);
    },
  };
});

import {
  customPrimaryProviderProfilePath,
  customSwitchingProviderRegistryPath,
  removeCustomPrimaryProviderSwitchingProfile,
  writeCustomPrimaryProviderSwitchingProfile,
  writeManagedModelWindowGlobal,
} from "../runtime/model-provider-runtime.mjs";
import {
  configuredHome,
  configureOpenCodeGo,
  connectHomeFor,
  providerCatalogPath,
  testEnvironment,
} from "./model-provider-runtime-test-fixture.js";

describe("model provider runtime rollback", () => {
  it("preserves both failures when Profile deletion and registry rollback fail", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-custom-switching-remove-failure-"));
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    const environment = testEnvironment(codexHome);
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "proxy-a",
      model: "gpt-5.6-sol",
      name: "Proxy A",
      baseUrl: "https://a.example.test/v1",
      apiKey: "sk-a",
    }, environment);
    runtimeFileFailures.unlinkPath = customPrimaryProviderProfilePath(environment, "proxy-a");
    runtimeFileFailures.atomicWritePath = customSwitchingProviderRegistryPath(environment);

    try {
      expect(() => removeCustomPrimaryProviderSwitchingProfile(environment, "proxy-a"))
        .toThrow(expect.objectContaining({
          name: "AggregateError",
          message: "自定义切换 Provider Profile 删除失败，且注册表回滚失败",
        }));
    } finally {
      runtimeFileFailures.unlinkPath = undefined;
      runtimeFileFailures.atomicWritePath = undefined;
    }
  });

  it("restores earlier Provider catalogs when a global window write fails", async () => {
    const codexHome = await configuredHome("switching");
    configureOpenCodeGo(codexHome);
    const environment = testEnvironment(codexHome);
    const deepseekCatalogPath = providerCatalogPath(codexHome);
    const opencodeGoCatalogPath = join(
      connectHomeFor(codexHome),
      "providers",
      "opencode-go",
      "models.json",
    );
    const deepseekCatalog = readFileSync(deepseekCatalogPath, "utf8");
    const opencodeGoCatalog = readFileSync(opencodeGoCatalogPath, "utf8");
    runtimeFileFailures.atomicWritePath = opencodeGoCatalogPath;

    try {
      expect(() => writeManagedModelWindowGlobal({
        model: "deepseek-v4-flash",
        windowPercent: 40,
        environment,
      })).toThrow("injected registry rollback failure");
    } finally {
      runtimeFileFailures.atomicWritePath = undefined;
    }

    expect(readFileSync(deepseekCatalogPath, "utf8")).toBe(deepseekCatalog);
    expect(readFileSync(opencodeGoCatalogPath, "utf8")).toBe(opencodeGoCatalog);
  });

});
