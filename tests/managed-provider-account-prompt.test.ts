import { validateOpencodeGoAccountId } from "../runtime/opencode-go-accounts.mjs";
import { describe, expect, it, vi } from "vitest";
import { managedAccountIdPresets, newManagedAccountIdError, opencodeGoReservedAccountIds } from "../runtime/managed-provider-account-options.mjs";
import { promptManagedAccountId } from "../scripts/managed-provider-account-prompt.mjs";

describe("shared account ID choices", () => {
  it("offers main, work and other and removes occupied presets", () => {
    expect(managedAccountIdPresets([]).map(choice => choice.value)).toEqual(["main", "work", "other"]);
    expect(managedAccountIdPresets([{ id: "main" }, { id: "other" }]).map(choice => choice.value)).toEqual(["work"]);
    expect(managedAccountIdPresets(["main", "work", "other"].map(id => ({ id })))).toEqual([]);
  });
  it("rejects invalid, duplicate and credential-colliding custom names", () => {
    for (const id of ["", "UPPER", "../bad", "a".repeat(33), "team-a", "team_a"]) {
      expect(newManagedAccountIdError(id, [{ id: "team-a" }])).toBeTruthy();
    }
    expect(newManagedAccountIdError("custom", [])).toBeUndefined();
  });
  it.each(["main", "work", "other"])("selects preset %s without a text prompt", async id => {
    const prompts = { select: vi.fn().mockResolvedValue(id), text: vi.fn(), isCancel: () => false };
    expect(await promptManagedAccountId(prompts, [])).toBe(id);
    expect(prompts.text).not.toHaveBeenCalled();
  });
  it("keeps custom available when presets are occupied and validates its input", async () => {
    const prompts = { select: vi.fn().mockResolvedValue("custom"), text: vi.fn().mockResolvedValue("team"), isCancel: () => false };
    expect(await promptManagedAccountId(prompts, ["main", "work", "other"].map(id => ({ id })))).toBe("team");
    expect(prompts.select).toHaveBeenCalledWith({ message: "新账户 ID", options: [{ value: "custom", label: "自定义" }] });
    const validate = prompts.text.mock.calls[0]![0].validate as (id: string) => string | undefined;
    expect(validate("main")).toBeTruthy();
    expect(validate("team")).toBeUndefined();
  });
  it.each(["openai", "deepseek", "ocg"])("rejects reserved OpenCode Go ID %s consistently", async id => {
    expect(() => validateOpencodeGoAccountId(id)).toThrow();
    expect(newManagedAccountIdError(id, [], opencodeGoReservedAccountIds)).toContain("保留名称");
    const prompts = { select: vi.fn().mockResolvedValue("custom"), text: vi.fn().mockResolvedValue("work"), isCancel: () => false };
    await promptManagedAccountId(prompts, [], opencodeGoReservedAccountIds);
    const validate = prompts.text.mock.calls[0]![0].validate as (id: string) => string | undefined;
    expect(validate(id)).toContain("保留名称");
    expect(validate("work")).toBeUndefined();
  });
  it("preserves cancellation at either prompt", async () => {
    const cancel = Symbol("cancel");
    const prompts = { select: vi.fn().mockResolvedValue(cancel), text: vi.fn().mockResolvedValue(cancel), isCancel: (value: unknown) => value === cancel };
    expect(await promptManagedAccountId(prompts, [])).toBe(cancel);
    expect(prompts.text).not.toHaveBeenCalled();
    prompts.select.mockResolvedValue("custom");
    expect(await promptManagedAccountId(prompts, [])).toBe(cancel);
  });
});
