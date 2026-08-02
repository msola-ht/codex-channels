import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { readVisionApiKey, visionCredentialPath } from "../runtime/vision-credential.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { initializeUserData } from "../scripts/runtime-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { runVisionSetup } from "../scripts/vision-setup.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Vision setup", () => {
  it("offers the same external visual API setup in dual-provider mode", async () => {
    const fixture = createFixture();
    const prompts = promptFixture({
      selections: ["responses_api"],
      texts: ["https://vision.example/v1/responses", "vision-model"],
      passwords: ["private-vision-key"],
    });

    await expect(runVisionSetup({
      environment: fixture.environment,
      output: fixture.output,
      prompts,
    })).resolves.toMatchObject({ mode: "responses_api" });

    const selection = prompts.select.mock.calls[0]?.[0] as
      | { options: Array<{ value: string }> }
      | undefined;
    expect(selection?.options).toEqual([
      expect.objectContaining({ value: "responses_api" }),
      expect.objectContaining({ value: "disabled" }),
      expect.objectContaining({ value: "back" }),
    ]);
    expect(readVisionApiKey(fixture.credentialsDirectory)).toBe("private-vision-key");
  });

  it("stores an external visual API key outside config.toml with private permissions", async () => {
    const fixture = createFixture();
    const secret = "private-vision-key";
    await runVisionSetup({
      environment: fixture.environment,
      output: fixture.output,
      prompts: promptFixture({
        selections: ["responses_api"],
        texts: ["https://vision.example/v1/responses", "vision-model"],
        passwords: [secret],
      }),
    });

    expect(readGatewayConfig(fixture.configPath).vision).toEqual({
      mode: "responses_api",
      endpoint: "https://vision.example/v1/responses",
      model: "vision-model",
    });
    expect(readFileSync(fixture.configPath, "utf8")).not.toContain(secret);
    expect(fixture.text()).not.toContain(secret);
    expect(readVisionApiKey(fixture.credentialsDirectory)).toBe(secret);
    expect(statSync(visionCredentialPath(fixture.credentialsDirectory)).mode & 0o777).toBe(0o600);
  });

  it("removes the external key when image recognition is disabled", async () => {
    const fixture = createFixture();
    await runVisionSetup({
      environment: fixture.environment,
      output: fixture.output,
      prompts: promptFixture({
        selections: ["responses_api"],
        texts: ["https://vision.example/v1/responses", "vision-model"],
        passwords: ["private-vision-key"],
      }),
    });

    await runVisionSetup({
      environment: fixture.environment,
      output: fixture.output,
      prompts: promptFixture({ selections: ["disabled"] }),
    });

    expect(readGatewayConfig(fixture.configPath).vision).toEqual({ mode: "disabled" });
    expect(() => readVisionApiKey(fixture.credentialsDirectory)).toThrow();
  });

  it("refuses to write a key through a symbolic-link credential directory", async () => {
    const fixture = createFixture();
    const redirected = join(fixture.codexHome, "redirected");
    mkdirSync(redirected, { recursive: true, mode: 0o700 });
    mkdirSync(join(fixture.credentialsDirectory), { recursive: true, mode: 0o700 });
    symlinkSync(redirected, join(fixture.credentialsDirectory, "vision"));

    await expect(runVisionSetup({
      environment: fixture.environment,
      output: fixture.output,
      prompts: promptFixture({
        selections: ["responses_api"],
        texts: ["https://vision.example/v1/responses", "vision-model"],
        passwords: ["private-vision-key"],
      }),
    })).rejects.toThrow("凭据目录权限无效");

    expect(readFileSync(fixture.configPath, "utf8")).not.toContain("responses_api");
  });

  it("restores the previous credential state when the full config cannot be saved", async () => {
    const fixture = createFixture();

    await expect(runVisionSetup({
      environment: fixture.environment,
      output: fixture.output,
      writeConfig: () => { throw new Error("配置写入失败"); },
      prompts: promptFixture({
        selections: ["responses_api"],
        texts: ["https://vision.example/v1/responses", "vision-model"],
        passwords: ["must-be-rolled-back"],
      }),
    })).rejects.toThrow("配置写入失败");

    expect(() => readVisionApiKey(fixture.credentialsDirectory)).toThrow();
    expect(readFileSync(fixture.configPath, "utf8")).not.toContain("must-be-rolled-back");
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codexc-vision-setup-"));
  roots.push(root);
  const home = join(root, ".codex-connect");
  const codexHome = join(root, ".codex");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: home,
    CODEX_CONNECT_CONFIG_FILE: "",
    CODEX_HOME: codexHome,
  };
  const { configPath, dataDir } = initializeUserData({ environment, cwd: workspace });
  let rendered = "";
  return {
    environment,
    configPath,
    codexHome,
    credentialsDirectory: join(dataDir, "credentials"),
    output: { write: (value: string) => { rendered += value; return true; } },
    text: () => rendered,
  };
}

function promptFixture({
  selections = [],
  texts = [],
  passwords = [],
  password = vi.fn(),
}: {
  selections?: string[];
  texts?: string[];
  passwords?: string[];
  password?: ReturnType<typeof vi.fn>;
} = {}) {
  const passwordImpl = passwords.length > 0
    ? vi.fn(async () => passwords.shift() ?? "")
    : password;
  return {
    select: vi.fn(async (question?: unknown) => {
      void question;
      return selections.shift();
    }),
    text: vi.fn(async () => texts.shift() ?? ""),
    password: passwordImpl,
    isCancel: () => false,
  };
}
