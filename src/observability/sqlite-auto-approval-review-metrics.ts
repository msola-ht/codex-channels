import type { DatabaseSync } from "node:sqlite";
import type { AutoApprovalReviewStore, AutoApprovalReviewSummary } from "./request-metrics.js";
import { validateThreadId } from "./sqlite-request-metrics-queries.js";

/** Minimal review identity and observation facts; no approval content or history. */
export class SqliteAutoApprovalReviewMetrics implements AutoApprovalReviewStore {
  constructor(private readonly database: DatabaseSync) {}

  observeAutoApprovalTurn(threadId: string, turnId: string, provider: string, phase: "started" | "completed"): void {
    this.validate(threadId, turnId, provider);
    this.database.prepare(`
      INSERT INTO auto_approval_review_turns
        (thread_id, turn_id, provider, started, completed, continuous, recorded_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, turn_id) DO UPDATE SET
        started = MAX(started, excluded.started),
        completed = MAX(completed, excluded.completed),
        recorded_at_ms = excluded.recorded_at_ms
    `).run(threadId, turnId, provider, Number(phase === "started"), Number(phase === "completed"),
      Number(phase === "started"), Date.now());
  }

  recordAutoApprovalReview(event: Parameters<AutoApprovalReviewStore["recordAutoApprovalReview"]>[0], provider: string): void {
    this.validate(event.threadId, event.turnId, provider);
    validateThreadId(event.reviewId, "自动审查 ID");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      // A review without an observed turn start is always a partial observation.
      this.database.prepare(`
        INSERT INTO auto_approval_review_turns
          (thread_id, turn_id, provider, started, completed, continuous, recorded_at_ms)
        VALUES (?, ?, ?, 0, 0, 0, ?)
        ON CONFLICT(thread_id, turn_id) DO NOTHING
      `).run(event.threadId, event.turnId, provider, Date.now());
      this.database.prepare(`
        INSERT INTO auto_approval_reviews
          (thread_id, turn_id, review_id, completed, approved, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, turn_id, review_id) DO UPDATE SET
          completed = MAX(completed, excluded.completed),
          approved = CASE WHEN completed = 1 THEN approved ELSE excluded.approved END,
          recorded_at_ms = excluded.recorded_at_ms
      `).run(event.threadId, event.turnId, event.reviewId, Number(event.phase === "completed"),
        Number(event.phase === "completed" && event.approved), Date.now());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  invalidateAutoApprovalCoverage(provider?: string): void {
    if (provider === undefined) this.database.exec("UPDATE auto_approval_review_turns SET continuous = 0");
    else this.database.prepare("UPDATE auto_approval_review_turns SET continuous = 0 WHERE provider = ?").run(provider);
  }

  taskAutoApprovalReviewSummary(threadId: string, turnId: string,
    pendingParentTurns: readonly { threadId: string; turnId: string }[] = []): AutoApprovalReviewSummary {
    validateThreadId(threadId, "Thread ID");
    validateThreadId(turnId, "Turn ID");
    // UNION de-duplicates exact runs, including diamonds and malformed cycles.
    const row = this.database.prepare(`
      WITH RECURSIVE task_turns(thread_id, turn_id) AS (
        SELECT ?, ? UNION
        SELECT child.thread_id, child.turn_id FROM subagent_turns child
        JOIN task_turns parent ON child.parent_thread_id = parent.thread_id
          AND child.parent_turn_id = parent.turn_id
      )
      SELECT
        (SELECT COALESCE(SUM(review.approved), 0) FROM auto_approval_reviews review
          JOIN task_turns task USING (thread_id, turn_id)) AS approved,
        COUNT(state.thread_id) AS observed,
        COUNT(*) AS expected,
        COALESCE(SUM(CASE WHEN state.started = 1 AND state.completed = 1 AND state.continuous = 1
          AND NOT EXISTS (SELECT 1 FROM json_each(?) pending
            WHERE json_extract(pending.value, '$.threadId') = task.thread_id
              AND json_extract(pending.value, '$.turnId') = task.turn_id)
          AND NOT EXISTS (SELECT 1 FROM auto_approval_reviews pending
            WHERE pending.thread_id = task.thread_id AND pending.turn_id = task.turn_id AND pending.completed = 0)
          THEN 1 ELSE 0 END), 0) AS complete
      FROM task_turns task LEFT JOIN auto_approval_review_turns state USING (thread_id, turn_id)
    `).get(threadId, turnId, JSON.stringify(pendingParentTurns)) as { approved: number; observed: number; expected: number; complete: number };
    return { approved: row.approved, coverage: row.observed === 0 ? "unknown"
      : row.complete === row.expected ? "complete" : "partial" };
  }

  /** Called inside the owner's existing cleanup transaction. */
  cleanup(beforeMs: number, maximumRows: number): void {
    // Removing a review invalidates its turn's count coverage before deletion.
    this.database.prepare(`
      UPDATE auto_approval_review_turns SET continuous = 0
      WHERE (thread_id, turn_id) IN (
        SELECT thread_id, turn_id FROM auto_approval_reviews WHERE recorded_at_ms < ?
          OR rowid IN (SELECT rowid FROM auto_approval_reviews ORDER BY recorded_at_ms DESC, rowid DESC LIMIT -1 OFFSET ?)
      )
    `).run(beforeMs, maximumRows);
    this.database.prepare(`DELETE FROM auto_approval_reviews WHERE recorded_at_ms < ?
      OR rowid IN (SELECT rowid FROM auto_approval_reviews ORDER BY recorded_at_ms DESC, rowid DESC LIMIT -1 OFFSET ?)
    `).run(beforeMs, maximumRows);
    this.database.prepare(`DELETE FROM auto_approval_review_turns WHERE recorded_at_ms < ?
      OR rowid IN (SELECT rowid FROM auto_approval_review_turns ORDER BY recorded_at_ms DESC, rowid DESC LIMIT -1 OFFSET ?)
    `).run(beforeMs, maximumRows);
    this.database.exec(`DELETE FROM auto_approval_reviews WHERE (thread_id, turn_id) NOT IN (
      SELECT thread_id, turn_id FROM auto_approval_review_turns
    )`);
  }

  private validate(threadId: string, turnId: string, provider: string): void {
    validateThreadId(threadId, "Thread ID");
    validateThreadId(turnId, "Turn ID");
    if (!provider.trim() || provider.length > 128) throw new Error("自动审查 Provider 无效");
  }
}
