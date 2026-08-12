import { describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { runCodexDefaultsSetup } from "../scripts/codex-defaults-setup.mjs";

describe("Codex official defaults setup", () => {
  it("writes the selected official model and supported reasoning effort together", async () => {
    const output: string[] = [];
    const client = {
      connect: vi.fn(async () => undefined),
      listModels: vi.fn(async () => [{
        id: "gpt-test",
        model: "gpt-test",
        displayName: "GPT Test",
        supportedReasoningEfforts: [{ effort: "medium", description: "Balanced" }, {
          effort: "high",
          description: "Deeper reasoning",
        }],
        defaultReasoningEffort: "medium",
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
        inputModalities: ["text"],
      }]),
      readDefaultModelSettings: vi.fn(async () => ({
        model: "gpt-test",
        effort: "medium",
      })),
      writeDefaultModelSettings: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const prompts = {
      select: vi.fn()
        .mockResolvedValueOnce("gpt-test")
        .mockResolvedValueOnce("high"),
      confirm: vi.fn(async () => true),
      isCancel: () => false,
    };
    const createClient = vi.fn(async () => client);

    await expect(runCodexDefaultsSetup({
      output: { write: (value: string) => output.push(value) },
      prompts,
      environment: { CODEX_HOME: "/tmp/codex-home" },
      createClient,
      primaryProvider: () => "openai",
    })).resolves.toEqual({ model: "gpt-test", effort: "high" });

    expect(createClient).toHaveBeenCalledWith({
      environment: { CODEX_HOME: "/tmp/codex-home" },
    });
    expect(client.readDefaultModelSettings).toHaveBeenCalledWith();
    expect(client.writeDefaultModelSettings).toHaveBeenCalledWith("gpt-test", "high");
    expect(client.close).toHaveBeenCalledOnce();
    expect(output.join("")).toContain("Codex 全局默认设置已更新");
    expect(output.join("")).toContain("codexc service restart all");
  });

  it("does not write global defaults when the user rejects the final confirmation", async () => {
    const client = setupClient();
    const output: string[] = [];

    await expect(runCodexDefaultsSetup({
      output: { write: (value: string) => output.push(value) },
      prompts: {
        select: vi.fn()
          .mockResolvedValueOnce("gpt-test")
          .mockResolvedValueOnce("medium"),
        confirm: vi.fn(async () => false),
        isCancel: () => false,
      },
      createClient: async () => client,
      primaryProvider: () => "openai",
    })).resolves.toBeUndefined();

    expect(client.writeDefaultModelSettings).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
    expect(output.join("")).toContain("未修改 Codex 全局配置");
  });

  it("rejects official defaults setup while DeepSeek is the fixed primary provider", async () => {
    const createClient = vi.fn();

    await expect(runCodexDefaultsSetup({
      createClient,
      primaryProvider: () => "deepseek",
    })).rejects.toThrow("仅 DeepSeek 固定模式");

    expect(createClient).not.toHaveBeenCalled();
  });
});

function setupClient() {
  return {
    connect: vi.fn(async () => undefined),
    listModels: vi.fn(async () => [{
      id: "gpt-test",
      model: "gpt-test",
      displayName: "GPT Test",
      supportedReasoningEfforts: [{ effort: "medium", description: "Balanced" }],
      defaultReasoningEffort: "medium",
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: true,
      inputModalities: ["text"],
    }]),
    readDefaultModelSettings: vi.fn(async () => ({
      model: "gpt-test",
      effort: "medium",
    })),
    writeDefaultModelSettings: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}
