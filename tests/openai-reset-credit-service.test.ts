import { describe, expect, it, vi } from "vitest";
import { OpenAiResetCreditService, type OpenAiResetCreditSnapshot, type ResetCreditOutcome } from "../src/application/index.js";

function fixture() {
  const snapshot: OpenAiResetCreditSnapshot = { accountId: "account-a", availableCount: "1", credits: [
    { id: "credit-a", title: "Full reset", description: "Official scope", expiresAt: null },
  ] };
  const readResetCredits = vi.fn(async () => structuredClone(snapshot));
  const consumeResetCredit = vi.fn(async (): Promise<ResetCreditOutcome> => "reset");
  const refresh = vi.fn(async () => {});
  return { snapshot, readResetCredits, consumeResetCredit, refresh,
    service: new OpenAiResetCreditService({ readResetCredits, consumeResetCredit }, refresh) };
}
describe("OpenAI reset credit confirmation", () => {
  it.each(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"] as const)("returns %s and refreshes without retry", async outcome => {
    const f = fixture(); f.consumeResetCredit.mockResolvedValue(outcome);
    const preview = await f.service.preview("credit-a");
    expect(f.consumeResetCredit).not.toHaveBeenCalled();
    expect(await f.service.consume(preview.attemptId)).toEqual({ outcome, refreshed: true });
    expect(f.consumeResetCredit).toHaveBeenCalledExactlyOnceWith("credit-a", preview.attemptId, undefined);
    await expect(f.service.consume(preview.attemptId)).rejects.toMatchObject({ code: "reset_stale" });
  });
  it.each(["account", "removed", "description", "expiry"])("rejects changed %s before consumption", async change => {
    const f = fixture(); const preview = await f.service.preview("credit-a");
    if (change === "account") f.snapshot.accountId = "account-b";
    if (change === "removed") f.snapshot.credits = [];
    if (change === "description") f.snapshot.credits[0]!.description = "Changed scope";
    if (change === "expiry") f.snapshot.credits[0]!.expiresAt = 1;
    await expect(f.service.consume(preview.attemptId)).rejects.toMatchObject({ code: "reset_stale" });
    expect(f.consumeResetCredit).not.toHaveBeenCalled();
  });
  it("expires previews and never consumes unknown identifiers", async () => {
    const f = fixture(); const preview = await f.service.preview("credit-a");
    const now = vi.spyOn(Date, "now").mockReturnValue(preview.expiresAt);
    try { await expect(f.service.consume(preview.attemptId)).rejects.toMatchObject({ code: "reset_stale" }); }
    finally { now.mockRestore(); }
    await expect(f.service.consume("unknown")).rejects.toMatchObject({ code: "reset_stale" });
    expect(f.consumeResetCredit).not.toHaveBeenCalled();
  });
  it("serializes consumes and reports uncertain writes without retrying", async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.consumeResetCredit.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const a = await f.service.preview("credit-a"); const b = await f.service.preview("credit-a");
    const first = f.service.consume(a.attemptId);
    await vi.waitFor(() => expect(f.consumeResetCredit).toHaveBeenCalledOnce());
    await expect(f.service.consume(b.attemptId)).rejects.toMatchObject({ code: "reset_busy" });
    reject(new Error("private upstream message"));
    await expect(first).rejects.toMatchObject({ code: "reset_unknown", message: "reset_unknown" });
    expect(f.consumeResetCredit).toHaveBeenCalledOnce();
    await expect(f.service.consume(b.attemptId)).rejects.toMatchObject({ code: "reset_stale" });
    for (let i = 0; i < 128; i++) await f.service.preview("credit-a");
  });
  it("keeps success when snapshot refresh fails", async () => {
    const f = fixture(); f.refresh.mockRejectedValue(new Error("disk"));
    const preview = await f.service.preview("credit-a");
    await expect(f.service.consume(preview.attemptId)).resolves.toEqual({ outcome: "reset", refreshed: false });
  });
});
