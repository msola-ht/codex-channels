import { UserFacingError, conversationTargetKey, type ConversationTarget } from "../conversation-core/index.js";
import { OpenAiResetCreditService, ResetCreditError, type OpenAiResetCredit, type ResetCreditOutcome } from "./openai-reset-credit-service.js";

export const resetCreditCommandUsage = "/limits reset [页码]\n/limits reset use <券ID>\n/limits reset confirm <一次性令牌>\n/limits reset cancel <一次性令牌>";
export type ConversationResetCreditResult =
  | { type: "list"; accountId: string; availableCount: string; credits: OpenAiResetCredit[]; page: number; pageCount: number }
  | { type: "preview"; accountId: string; credit: OpenAiResetCredit; token: string; expiresAt: number }
  | { type: "cancelled" }
  | { type: "consumed"; outcome: ResetCreditOutcome; refreshed: boolean };

/** 只保存渠道确认归属；官方账户、券复核和消费仍由共用服务完成。 */
export class ConversationResetCreditService {
  private readonly pending = new Map<string, { owner: string; context: string; expiresAt: number }>();
  constructor(private readonly credits: OpenAiResetCreditService,
    private readonly authorizedContext: (target: ConversationTarget, actorId: string) => string) {}

  async execute(target: ConversationTarget, actorId: string | undefined, input: string): Promise<ConversationResetCreditResult> {
    try {
      if (!actorId) throw failure("forbidden");
      const context = this.authorizedContext(target, actorId);
      const owner = JSON.stringify([conversationTargetKey(target), actorId]);
      for (const [token, pending] of this.pending) if (pending.expiresAt <= Date.now()) {
        this.pending.delete(token); this.credits.cancel(token);
      }
      const parts = input.trim().split(/\s+/u);
      if (parts[0] !== "reset") throw failure("usage");
      if (parts.length === 1 || (parts.length === 2 && /^[1-9]\d{0,3}$/u.test(parts[1]!))) {
        const page = Number(parts[1] ?? "1");
        const snapshot = await this.credits.list();
        if (this.authorizedContext(target, actorId) !== context) throw failure("reset_stale");
        const pageCount = Math.max(1, Math.ceil(snapshot.credits.length / 8));
        if (page > pageCount) throw failure("usage");
        return { type: "list", accountId: snapshot.accountId, availableCount: snapshot.availableCount,
          credits: snapshot.credits.slice((page - 1) * 8, page * 8), page, pageCount };
      }
      if (parts.length !== 3) throw failure("usage");
      const [, action, value] = parts;
      if (action === "use") {
        if (!value || value.length > 256) throw failure("usage");
        if (this.pending.size >= 128) throw failure("reset_busy");
        const preview = await this.credits.preview(value);
        try {
          if (this.authorizedContext(target, actorId) !== context) throw failure("reset_stale");
          if (this.pending.size >= 128) throw failure("reset_busy");
          this.pending.set(preview.attemptId, { owner, context, expiresAt: preview.expiresAt });
        } catch (error) { this.credits.cancel(preview.attemptId); throw error; }
        return { type: "preview", accountId: preview.accountId, credit: preview.credit, token: preview.attemptId, expiresAt: preview.expiresAt };
      }
      if (action !== "confirm" && action !== "cancel") throw failure("usage");
      const pending = this.pending.get(value!);
      if (!pending || pending.owner !== owner) throw failure("reset_stale");
      this.pending.delete(value!);
      if (pending.context !== context) { this.credits.cancel(value!); throw failure("reset_stale"); }
      if (action === "cancel") { this.credits.cancel(value!); return { type: "cancelled" }; }
      const result = await this.credits.consume(value!, undefined, () => {
        if (this.authorizedContext(target, actorId) !== context) throw failure("reset_stale");
      });
      return { type: "consumed", ...result };
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      throw failure(error instanceof ResetCreditError ? error.code : "reset_unavailable", error);
    }
  }
}
function failure(reason: string, cause?: unknown) {
  return new UserFacingError("reset-credit.failed", "重置券操作未完成", { reason }, { cause });
}
