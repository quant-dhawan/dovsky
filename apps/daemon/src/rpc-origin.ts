import type { DovskyDatabase } from "./database.js";
import { DaemonError } from "./config.js";

/** Local listener authority. Never deserialize this type from an RPC envelope. */
export type RpcOrigin = Readonly<{ kind: "operator" } | { kind: "job"; jobId: string }>;
export const OPERATOR_ORIGIN: RpcOrigin = Object.freeze({ kind: "operator" });
export const principalFor = (origin: RpcOrigin): string => origin.kind === "operator" ? "operator" : `job:${origin.jobId}`;

export function authorizeRpc(db: DovskyDatabase, origin: RpcOrigin, method: string, params: Record<string, unknown>): void {
  if (origin.kind === "operator") return;
  const deny = (): never => { throw new DaemonError("FORBIDDEN", "This job connection is not authorized for that operation"); };
  if (!['tasks.checkpoint','tasks.controls.ack','jobs.grade'].includes(method)) deny();
  const caller = db.getJob(origin.jobId);
  if (!caller || !['starting','running','cancel_requested'].includes(caller.state)) deny();
  if (method !== 'jobs.grade') {
    if (!caller || !caller.taskId || caller.role !== 'work' || params.jobId !== origin.jobId || params.taskId !== caller.taskId) deny();
    const kind = db.db.prepare('SELECT execution_kind FROM jobs WHERE id=?').get(origin.jobId)?.execution_kind;
    if (kind !== 'foreground' && kind !== 'promotion') deny();
    return;
  }
  if (typeof params.jobId !== 'string' || !db.getJob(params.jobId)) deny();
  // Follow all persisted lineage edges in both directions, with UNION for cycle safety.
  const related = db.db.prepare(`WITH RECURSIVE edges(child,parent) AS (
    SELECT id,parent_job_id FROM jobs UNION SELECT id,predecessor_job_id FROM jobs
    UNION SELECT id,retry_of_job_id FROM jobs UNION SELECT id,source_job_id FROM jobs
    UNION SELECT id,review_of FROM jobs UNION SELECT id,escalated_from FROM jobs
    UNION SELECT id,promotion_of FROM jobs UNION SELECT id,review_retry_of FROM jobs
  ), lineage(id) AS (SELECT ? UNION SELECT CASE WHEN e.child=l.id THEN e.parent ELSE e.child END
    FROM edges e JOIN lineage l ON (e.child=l.id OR e.parent=l.id) WHERE e.parent IS NOT NULL)
    SELECT 1 FROM lineage WHERE id=? LIMIT 1`).get(origin.jobId, params.jobId as string);
  if (related) deny();
}
