import { withTransaction, type DbPool } from "@aisevak/core";
import type { PoolClient } from "pg";

export async function assertThreadAcceptsInput(client: Pick<PoolClient,"query">, id: string): Promise<void> {
  const result = await client.query<{ archived_at: Date | null; cleanup_state: string | null }>(
    "SELECT archived_at, cleanup_state FROM agent_threads WHERE id = $1", [id]
  );
  const thread = result.rows[0];
  if (thread?.archived_at || thread?.cleanup_state === "restoring") {
    throw Object.assign(new Error(thread.archived_at ? "Restore this archived chat before sending a message" : "Chat restoration is still pending"), {statusCode:409});
  }
}

export async function setThreadArchived(pool: DbPool, id: string, archived: boolean): Promise<void> {
  const initial = await pool.query<{ task_id: string | null }>("SELECT task_id FROM agent_threads WHERE id = $1", [id]);
  if (!initial.rows[0]) throw Object.assign(new Error("Chat not found"), {statusCode:404});
  await withTransaction(pool, async client => {
    // Match the enqueue/launch lock order: task, then navigation thread.
    const taskId = initial.rows[0]!.task_id;
    if (taskId) await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
    const locked = await client.query<{task_id:string|null; archived_at:Date|null}>(
      "SELECT task_id, archived_at FROM agent_threads WHERE id = $1 FOR UPDATE", [id]
    );
    const thread = locked.rows[0];
    if (!thread) throw Object.assign(new Error("Chat not found"), {statusCode:404});
    if (thread.task_id !== taskId) throw Object.assign(new Error("Chat ownership changed; retry the operation"), {statusCode:409});
    if (Boolean(thread.archived_at) === archived) return;
    await client.query(`UPDATE agent_threads SET archived_at = CASE WHEN $2 THEN now() ELSE NULL END,
      cleanup_state = CASE WHEN $2 THEN 'pending' ELSE 'restoring' END,
      cleanup_error = NULL, cleanup_attempt_at = NULL,
      ownership_generation = ownership_generation + 1, updated_at = now() WHERE id = $1`, [id,archived]);
    if (!archived) return;
    for (const table of ["task_runs","dispatcher_runs"]) {
      await client.query(`UPDATE ${table} SET
        status = CASE WHEN status = 'queued' THEN 'cancelled'::run_status ELSE 'cancel_requested'::run_status END,
        finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END,
        error = 'Chat archived', updated_at = now()
        WHERE agent_thread_id = $1 AND status IN ('queued','running','cancel_requested')`, [id]);
    }
    await client.query("UPDATE agent_turn_inputs SET status = 'failed', error = 'Chat archived', updated_at = now() WHERE agent_thread_id = $1 AND status IN ('queued','delivering')", [id]);
    await client.query(`UPDATE message_deliveries SET status = 'failed', error = 'Chat archived', completed_at = now(), updated_at = now()
      WHERE id IN (SELECT message_delivery_id FROM dispatcher_runs WHERE agent_thread_id = $1
        UNION SELECT message_delivery_id FROM agent_turn_inputs WHERE agent_thread_id = $1)
        AND status IN ('queued','retrying','running')`,[id]);
    await client.query(`UPDATE task_assignments SET status = 'blocked', result = 'Agent chat archived', active_delivery_id = NULL, updated_at = now()
      WHERE active_delivery_id IN (SELECT message_delivery_id FROM dispatcher_runs WHERE agent_thread_id = $1
        UNION SELECT message_delivery_id FROM agent_turn_inputs WHERE agent_thread_id = $1)
        AND status IN ('queued','running')`,[id]);
    await client.query("DELETE FROM agent_tool_tokens WHERE agent_thread_id = $1",[id]);
  });
}
