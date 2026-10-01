import { randomUUID } from "node:crypto";

export interface OpenAiResetCredit {
  id: string;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}
export interface OpenAiResetCreditSnapshot {
  accountId: string;
  availableCount: string;
  credits: OpenAiResetCredit[];
}
export type ResetCreditOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";
export interface OpenAiResetCreditPort {
  readResetCredits(signal?: AbortSignal): Promise<OpenAiResetCreditSnapshot>;
  consumeResetCredit(creditId: string, idempotencyKey: string, signal?: AbortSignal): Promise<ResetCreditOutcome>;
}
export class ResetCreditError extends Error {
  constructor(readonly code: "reset_stale" | "reset_busy" | "reset_unavailable" | "reset_unknown") {
    super(code);
  }
}
interface Attempt {
  accountId: string;
  credit: OpenAiResetCredit;
  expiresAt: number;
}
/** 只保存有界短期确认上下文，不持久化券或凭据，不自动重试消费。 */
export class OpenAiResetCreditService {
  private readonly attempts = new Map<string, Attempt>();
  private busy = false;
  constructor(private readonly port: OpenAiResetCreditPort, private readonly refresh: (signal: AbortSignal) => Promise<unknown>) {}

  async list(signal?: AbortSignal): Promise<OpenAiResetCreditSnapshot> {
    return this.port.readResetCredits(signal);
  }

  async preview(creditId: string, signal?: AbortSignal) {
    for (const [id, attempt] of this.attempts) if (attempt.expiresAt <= Date.now()) this.attempts.delete(id);
    if (this.busy || this.attempts.size >= 128) throw new ResetCreditError("reset_busy");
    const snapshot = await this.list(signal);
    signal?.throwIfAborted();
    const credit = snapshot.credits.find(item => item.id === creditId);
    if (!credit || (credit.expiresAt !== null && credit.expiresAt * 1000 <= Date.now())) throw new ResetCreditError("reset_stale");
    if (this.busy || this.attempts.size >= 128) throw new ResetCreditError("reset_busy");
    const attemptId = randomUUID();
    const attempt = { accountId: snapshot.accountId, credit, expiresAt: Date.now() + 5 * 60_000 };
    this.attempts.set(attemptId, attempt);
    return { attemptId, ...attempt };
  }

  async consume(attemptId: string, signal?: AbortSignal) {
    if (this.busy) throw new ResetCreditError("reset_busy");
    const attempt = this.attempts.get(attemptId);
    this.attempts.delete(attemptId);
    if (!attempt || attempt.expiresAt <= Date.now()) throw new ResetCreditError("reset_stale");
    this.busy = true;
    try {
      const snapshot = await this.list(signal);
      const credit = snapshot.credits.find(item => item.id === attempt.credit.id);
      if (attempt.expiresAt <= Date.now() || snapshot.accountId !== attempt.accountId || !credit || JSON.stringify(credit) !== JSON.stringify(attempt.credit)
        || (credit.expiresAt !== null && credit.expiresAt * 1000 <= Date.now())) throw new ResetCreditError("reset_stale");
      signal?.throwIfAborted();
      let outcome: ResetCreditOutcome;
      try { outcome = await this.port.consumeResetCredit(credit.id, attemptId, signal); }
      catch { throw new ResetCreditError("reset_unknown"); }
      // 消费结果与快照刷新分开，刷新失败不能把已消费改成失败。
      const refreshed = await this.refresh(AbortSignal.timeout(5_000)).then(() => true, () => false);
      return { outcome, refreshed };
    } finally { this.busy = false; }
  }
}
