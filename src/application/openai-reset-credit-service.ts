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
  readResetCredits(signal?: AbortSignal, beforeSubmit?: () => void): Promise<OpenAiResetCreditSnapshot>;
  consumeResetCredit(creditId: string, idempotencyKey: string, signal?: AbortSignal, beforeSubmit?: () => void): Promise<ResetCreditOutcome>;
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

  async list(signal?: AbortSignal, validateAuthorization?: () => void): Promise<OpenAiResetCreditSnapshot> {
    validateAuthorization?.();
    const snapshot = await this.port.readResetCredits(signal, validateAuthorization);
    validateAuthorization?.();
    return snapshot;
  }

  async preview(creditId: string, signal?: AbortSignal, validateAuthorization?: () => void) {
    validateAuthorization?.();
    for (const [id, attempt] of this.attempts) if (attempt.expiresAt <= Date.now()) this.attempts.delete(id);
    if (this.busy || this.attempts.size >= 128) throw new ResetCreditError("reset_busy");
    const snapshot = await this.list(signal, validateAuthorization);
    signal?.throwIfAborted();
    const credit = snapshot.credits.find(item => item.id === creditId);
    if (!credit || (credit.expiresAt !== null && credit.expiresAt * 1000 <= Date.now())) throw new ResetCreditError("reset_stale");
    if (this.busy || this.attempts.size >= 128) throw new ResetCreditError("reset_busy");
    const attemptId = randomUUID();
    const attempt = { accountId: snapshot.accountId, credit, expiresAt: Date.now() + 5 * 60_000 };
    this.attempts.set(attemptId, attempt);
    return { attemptId, ...attempt };
  }

  cancel(attemptId: string): void { this.attempts.delete(attemptId); }

  async consume(attemptId: string, signal?: AbortSignal, validateAuthorization?: () => void) {
    const attempt = this.attempts.get(attemptId);
    this.attempts.delete(attemptId);
    if (!attempt || attempt.expiresAt <= Date.now()) throw new ResetCreditError("reset_stale");
    // 所有确认调用均消耗一次性预览，包括并发忙碌的拒绝。
    if (this.busy) throw new ResetCreditError("reset_busy");
    this.busy = true;
    try {
      const snapshot = await this.list(signal, validateAuthorization);
      const credit = snapshot.credits.find(item => item.id === attempt.credit.id);
      if (attempt.expiresAt <= Date.now() || snapshot.accountId !== attempt.accountId || !credit || JSON.stringify(credit) !== JSON.stringify(attempt.credit)
        || (credit.expiresAt !== null && credit.expiresAt * 1000 <= Date.now())) throw new ResetCreditError("reset_stale");
      signal?.throwIfAborted();
      validateAuthorization?.();
      let outcome: ResetCreditOutcome;
      let submissionRejected = false;
      const beforeSubmit = () => {
        try {
          validateAuthorization?.();
          if (attempt.expiresAt <= Date.now()
            || (credit.expiresAt !== null && credit.expiresAt * 1000 <= Date.now())) {
            throw new ResetCreditError("reset_stale");
          }
        } catch (error) { submissionRejected = true; throw error; }
      };
      try { outcome = await this.port.consumeResetCredit(credit.id, attemptId, signal, beforeSubmit); }
      catch (error) {
        // A local guard rejection proves that this consumption was not sent.
        if (submissionRejected) throw error;
        throw new ResetCreditError("reset_unknown");
      }
      // 消费结果与快照刷新分开，刷新失败不能把已消费改成失败。
      const refreshed = await this.refresh(AbortSignal.timeout(5_000)).then(() => true, () => false);
      return { outcome, refreshed };
    } finally { this.busy = false; }
  }
}
