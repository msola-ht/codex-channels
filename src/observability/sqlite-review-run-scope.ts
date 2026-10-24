/** Exact review runs shared by summaries and write-failure attribution. */
export function reviewRunScope(threadId: string, turnId?: string): { cte: string; parameters: string[] } {
  const seed = turnId === undefined
    ? `SELECT thread_id, turn_id FROM auto_approval_review_turns WHERE thread_id = ?
       UNION SELECT thread_id, turn_id FROM turn_execution_metrics WHERE thread_id = ?
       UNION SELECT thread_id, turn_id FROM model_request_metrics WHERE thread_id = ? AND turn_id IS NOT NULL
       UNION SELECT parent_thread_id, parent_turn_id FROM subagent_turns WHERE parent_thread_id = ?`
    : "SELECT ? AS thread_id, ? AS turn_id";
  return {
    // UNION de-duplicates exact runs, including diamonds and malformed cycles.
    cte: `review_runs(thread_id, turn_id) AS (
      ${seed} UNION
      SELECT child.thread_id, child.turn_id FROM subagent_turns child
      JOIN review_runs parent ON child.parent_thread_id = parent.thread_id
        AND child.parent_turn_id = parent.turn_id
    )`,
    parameters: turnId === undefined ? [threadId, threadId, threadId, threadId] : [threadId, turnId],
  };
}
