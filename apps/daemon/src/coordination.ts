import { randomUUID } from "node:crypto";
import { isForegroundExecution } from '@dovsky/protocol';
import { CONTROL_KINDS, TASK_STATES, type ControlInput, type ControlView, type PendingTaskView, type TaskDetail, type TaskResult, type TaskState, type TaskView } from "@dovsky/protocol";
import type { DovskyDatabase } from "./database.js";
import { DaemonError } from "./config.js";
import { sanitizeStoredText } from "./sanitize.js";

export const COORDINATION_SCHEMA_SQL = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), provider TEXT NOT NULL,
    latest_job_id TEXT NOT NULL REFERENCES jobs(id), state TEXT NOT NULL, phase TEXT NOT NULL,
    blocker TEXT, next_action TEXT, workdir TEXT, revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  ALTER TABLE jobs ADD COLUMN task_id TEXT REFERENCES tasks(id);
  ALTER TABLE jobs ADD COLUMN predecessor_job_id TEXT REFERENCES jobs(id);
  ALTER TABLE jobs ADD COLUMN predecessor_pending INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX jobs_task_idx ON jobs(task_id);
  CREATE TABLE task_controls (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL,
    kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
    delivered_at TEXT, delivered_job_id TEXT REFERENCES jobs(id),
    acknowledged_at TEXT, acknowledged_job_id TEXT REFERENCES jobs(id),
    delivery_actor TEXT, acknowledgment_actor TEXT, UNIQUE(task_id,sequence)
  );
  CREATE TABLE task_ownership (workdir TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id));
  CREATE TABLE event_consumers (id TEXT PRIMARY KEY, room_id TEXT, acknowledged INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE daemon_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO tasks(id,room_id,provider,latest_job_id,state,phase,workdir,created_at,updated_at)
    SELECT id,room_id,provider,id,'unknown','legacy execution; outcome not reported',cwd,created_at,updated_at FROM jobs WHERE role='work';
  UPDATE jobs SET task_id=id WHERE role='work';
`;

/**
 * A task waiting on a human, as SQL over the tasks row aliased `alias`. It is the one definition
 * the room list's attention filter, a room's needsAttention and the inbox all use. The migration
 * above stamps every pre-coordination task 'unknown' with a 'legacy ...' phase: that is history,
 * not a question.
 */
export function taskNeedsHuman(alias: string): string {
  return `(${alias}.state IN ('checkpointed','awaiting_decision','blocked') OR (${alias}.state='unknown' AND ${alias}.phase NOT LIKE 'legacy%'))`;
}

/** A process exit or prose recap never stands in for a task outcome. */
export function parseTaskResult(text: string): TaskResult | null {
  const marker = "DOVSKY_RESULT:";
  // A checkpointed predecessor may finish immediately after the rename. This is
  // deliberately the sole read-side legacy compatibility path.
  const legacyMarker = "AGENTBUS_RESULT:";
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith(marker) || line.startsWith(legacyMarker));
  if (lines.length !== 1) return null;
  try {
    const line = lines[0]!;
    const value = JSON.parse(line.slice(line.startsWith(marker) ? marker.length : legacyMarker.length));
    if (!value || !TASK_STATES.includes(value.outcome) || typeof value.phase !== "string" || !value.phase.trim() || value.phase.length > 500) return null;
    if (![value.blocker, value.nextAction].every((item) => item === null || typeof item === "string" && item.length <= 2000)) return null;
    if (!Array.isArray(value.acknowledgedControls) || value.acknowledgedControls.some((id: unknown) => typeof id !== "string") || new Set(value.acknowledgedControls).size !== value.acknowledgedControls.length) return null;
    return { outcome: value.outcome, phase: value.phase, blocker: value.blocker, nextAction: value.nextAction, acknowledgedControls: value.acknowledgedControls };
  } catch { return null; }
}

export class CoordinationStore {
  constructor(private readonly database: DovskyDatabase) {}
  /**
   * One of two independent places a `tasks` row becomes a `TaskView`: this one backs `get`/`list`/
   * `listPending` (the inbox, and `rooms.get`'s `tasks`); the other is `mapped()` in reads.ts, which maps a
   * `tasks` row for the paginated `rooms.snapshot`/`jobs.evidence` instead of going through this class. Both
   * call the shared `sanitizeStoredText` on `phase`/`blocker`/`nextAction` so a row written before that
   * sanitizer existed still renders clean everywhere, without rewriting the row itself.
   */
  getTask(taskId: string): TaskView {
    const row = this.database.db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
    if (!row) throw new DaemonError("NOT_FOUND", `Task not found: ${taskId}`);
    return {
      id: String(row.id), roomId: String(row.room_id), provider: row.provider as TaskView["provider"],
      latestJobId: String(row.latest_job_id), state: row.state as TaskView["state"], phase: sanitizeStoredText(String(row.phase)),
      blocker: sanitizeStoredText(row.blocker as string | null), nextAction: sanitizeStoredText(row.next_action as string | null), workdir: row.workdir as string | null,
      revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
  get(taskId: string): TaskDetail {
    const task = this.getTask(taskId);
    const controls = this.database.db.prepare("SELECT * FROM task_controls WHERE task_id=? ORDER BY sequence").all(taskId).map((r): ControlView => ({
      id: String(r.id), taskId, sequence: Number(r.sequence), kind: r.kind as ControlView["kind"], body: String(r.body), createdAt: String(r.created_at),
      deliveredAt: r.delivered_at as string | null, deliveredJobId: r.delivered_job_id as string | null,
      acknowledgedAt: r.acknowledged_at as string | null, acknowledgedJobId: r.acknowledged_job_id as string | null,
      deliveryActor: r.delivery_actor as "provider" | "coordinator" | null, acknowledgmentActor: r.acknowledgment_actor as "provider" | "coordinator" | null,
    }));
    return { task, controls };
  }
  list(roomId: string): TaskView[] {
    return this.database.db.prepare("SELECT id FROM tasks WHERE room_id=? ORDER BY created_at,id").all(roomId).map((row) => this.getTask(String(row.id)));
  }
  /** Every task waiting on a human, across all rooms: the daemon-wide inbox (`f2-replan.md` §4). */
  listPending(): PendingTaskView[] {
    return this.database.db
      .prepare(`SELECT t.id AS id, r.title AS room_title FROM tasks t JOIN rooms r ON r.id=t.room_id WHERE ${taskNeedsHuman("t")} ORDER BY t.updated_at DESC, t.id LIMIT 200`)
      .all()
      .map((row) => ({ ...this.getTask(String(row.id)), roomTitle: String(row.room_title) }));
  }
  create(input: ControlInput): ControlView {
    if (!CONTROL_KINDS.includes(input.kind) || typeof input.body !== "string" || !input.body.trim() || input.body.length > 20_000) throw new DaemonError("INVALID_REQUEST", "A valid control kind and nonempty body (max 20000) are required");
    return this.database.transaction(() => {
      const { task, controls } = this.get(input.taskId);
      if (task.state === "cancelled") throw new DaemonError("STATE_CONFLICT", "Cancelled tasks cannot receive controls");
      const id = randomUUID();
      this.database.db.prepare("INSERT INTO task_controls(id,task_id,sequence,kind,body,created_at) VALUES(?,?,?,?,?,?)").run(id, task.id, (controls.at(-1)?.sequence ?? 0) + 1, input.kind, input.body, new Date().toISOString());
      if (task.state === "completed" && input.kind === "instruction") this.setState(task.id, { outcome: "checkpointed", phase: "New instruction awaiting delivery", blocker: null, nextAction: "Resume task to deliver controls", acknowledgedControls: [] });
      this.event(task.id, "task.control.recorded", { controlId: id });
      return this.get(task.id).controls.at(-1)!;
    });
  }
  private current(taskId: string, jobId: string): "provider" | "coordinator" {
    const job = this.database.getJob(jobId);
    const task = this.getTask(taskId);
    const completedReceipt = task.state === "completed" && task.latestJobId === jobId && job?.state === "succeeded";
    if (job?.taskId !== taskId || !isForegroundExecution(job.executionKind) || !["running", "starting"].includes(job.state) && !completedReceipt) throw new DaemonError("STATE_CONFLICT", "Only the current execution or completed task's foreground worker can receive or acknowledge controls");
    return completedReceipt ? "coordinator" : "provider";
  }
  checkpoint(taskId: string, jobId: string): TaskDetail {
    return this.database.transaction(() => {
      const actor = this.current(taskId, jobId);
      this.database.db.prepare("UPDATE task_controls SET delivered_at=?,delivered_job_id=?,delivery_actor=? WHERE task_id=? AND acknowledged_at IS NULL").run(new Date().toISOString(), jobId, actor, taskId);
      this.event(taskId, "task.controls.delivered", { jobId }, jobId);
      return this.get(taskId);
    });
  }
  acknowledge(taskId: string, jobId: string, ids: string[]): TaskDetail {
    return this.database.transaction(() => {
      const actor = this.current(taskId, jobId);
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) throw new DaemonError("INVALID_REQUEST", "controlIds must be unique strings");
      const controls = this.get(taskId).controls;
      for (const id of ids) {
        const control = controls.find((c) => c.id === id);
        if (!control || control.deliveredJobId !== jobId) throw new DaemonError("STATE_CONFLICT", "Cannot acknowledge a control not delivered to this execution");
        if (controls.some((c) => c.sequence < control.sequence && !c.acknowledgedAt && !ids.includes(c.id))) throw new DaemonError("STATE_CONFLICT", "Controls must be acknowledged in sequence");
      }
      for (const id of ids) this.database.db.prepare("UPDATE task_controls SET acknowledged_at=COALESCE(acknowledged_at,?),acknowledged_job_id=?,acknowledgment_actor=? WHERE id=? AND acknowledged_at IS NULL").run(new Date().toISOString(), jobId, actor, id);
      if (ids.length) this.event(taskId, "task.controls.acknowledged", { jobId, controlIds: ids }, jobId);
      return this.get(taskId);
    });
  }
  finish(taskId: string, jobId: string, result: TaskResult | null): TaskView {
    return this.database.transaction(() => {
      const job = this.database.getJob(jobId);
      if (!job || job.taskId !== taskId || !isForegroundExecution(job.executionKind)) throw new DaemonError('STATE_CONFLICT','Only foreground task executions can report completion');
      if (result) this.acknowledge(taskId, jobId, result.acknowledgedControls);
      let outcome = result ?? { outcome: "unknown" as const, phase: "Execution ended without a structured task outcome", blocker: "Task completion is unverified", nextAction: "Inspect result and resume if needed", acknowledgedControls: [] };
      if (outcome.outcome === "completed" && this.get(taskId).controls.some((c) => !c.acknowledgedAt && c.kind === "instruction")) outcome = { ...outcome, outcome: "checkpointed", phase: "Undelivered or unacknowledged controls remain", nextAction: "Resume task to process pending controls" };
      if (this.database.db.prepare("SELECT id FROM jobs WHERE task_id=? AND execution_kind IN ('foreground','promotion') AND state='queued' AND id<>?").get(taskId, jobId)) outcome = { ...outcome, outcome: "working", phase: "Continuation queued" };
      else if (outcome.outcome === "working") outcome = { ...outcome, outcome: "checkpointed", phase: "Execution yielded with work remaining", nextAction: outcome.nextAction ?? "Resume task" };
      if (this.paused(taskId)) outcome = { ...outcome, outcome: "checkpointed", phase: "Paused at checkpoint", nextAction: "Record a resume control to continue" };
      return this.setState(taskId, outcome, jobId);
    });
  }
  setState(taskId: string, result: TaskResult, jobId: string | null = null): TaskView {
    this.database.db.prepare("UPDATE tasks SET state=?,phase=?,blocker=?,next_action=?,revision=revision+1,updated_at=? WHERE id=?").run(result.outcome, result.phase, result.blocker, result.nextAction, new Date().toISOString(), taskId);
    // Long-lived ownership is reserved for an explicit cooperative checkpoint.
    // Legacy providers without the result contract retain unknown status, not an
    // indefinite reservation that would stall every later independent task.
    // A lease-bearing execution is different: its detached group can survive its
    // terminal job transition, so its task ownership stays until reconciliation.
    const canReleaseOwnership = this.database.canReleaseTaskOwnership(taskId);
    if (canReleaseOwnership && (["completed", "cancelled"].includes(result.outcome) || result.outcome === "unknown" && result.phase !== "Execution interrupted")) {
      this.database.db.prepare("DELETE FROM task_ownership WHERE task_id=?").run(taskId);
    }
    this.event(taskId, "task.updated", {}, jobId);
    return this.getTask(taskId);
  }
  claim(taskId: string, workdir: string, writable: boolean): boolean {
    const task = this.getTask(taskId);
    if (task.workdir && task.workdir !== workdir) throw new DaemonError("WORKTREE_CONFLICT", "Task workdir cannot change; create a new task for a different worktree");
    const owner = this.database.db.prepare("SELECT task_id FROM task_ownership WHERE workdir=?").get(workdir);
    if (owner && owner.task_id !== taskId && writable) return false;
    if (writable) this.database.db.prepare("INSERT OR IGNORE INTO task_ownership(workdir,task_id) VALUES(?,?)").run(workdir, taskId);
    this.database.db.prepare("UPDATE tasks SET workdir=? WHERE id=?").run(workdir, taskId);
    return true;
  }
  rebind(taskId: string, workdir: string, writable: boolean): TaskView {
    return this.database.transaction(() => {
      const task = this.getTask(taskId);
      if (task.state !== "checkpointed") throw new DaemonError("STATE_CONFLICT", "Only a checkpointed task can move to another worktree");
      if (!this.database.canReleaseTaskOwnership(taskId)) throw new DaemonError('STATE_CONFLICT', 'Task execution or canonical application requires reconciliation before moving worktrees');
      if (this.database.db.prepare("SELECT 1 FROM jobs WHERE task_id=? AND execution_kind IN ('foreground','promotion') AND state IN ('queued','starting','running','cancel_requested') LIMIT 1").get(taskId)) {
        throw new DaemonError("STATE_CONFLICT", "Task already has a queued or active execution");
      }
      if (this.database.db.prepare("SELECT 1 FROM release_operations WHERE task_id=? AND state IN ('executing','reconcile_required') LIMIT 1").get(taskId)) {
        throw new DaemonError("STATE_CONFLICT", "Task has an executing or uncertain release operation; reconcile it before moving worktrees");
      }
      const owner = this.database.db.prepare("SELECT task_id FROM task_ownership WHERE workdir=?").get(workdir);
      if (owner && String(owner.task_id) !== taskId) throw new DaemonError("WORKTREE_CONFLICT", "Target worktree is owned by another task");
      this.database.db.prepare("DELETE FROM task_ownership WHERE task_id=?").run(taskId);
      if (writable) this.database.db.prepare("INSERT INTO task_ownership(workdir,task_id) VALUES(?,?)").run(workdir, taskId);
      this.database.db.prepare("UPDATE tasks SET workdir=?,revision=revision+1,updated_at=? WHERE id=?").run(workdir, new Date().toISOString(), taskId);
      return this.getTask(taskId);
    });
  }
  /**
   * Goal floor: how many of this task's prior work-job claims already reported `outcome`, not counting
   * `jobId` itself. Text is never compared (an LLM's rewording of the same claim is not checkable), so
   * this simply counts claims of that outcome. Narrowed to `role='work'` (a reviewer job inherits the
   * task id through `reviewOf`, so without this a reviewer's own result would be double-counted) and
   * `state='succeeded'` (a job that failed after storing a parseable result, e.g. a model-mismatch
   * failure, is not an accepted claim). A `blocked` state written by the daemon itself (schedule's
   * interrupted-predecessor sweep, finishJob's cancellation path, failUnexpected) has no parseable
   * `result` row and so never counts here; only an agent's own self-report does, deliberately. Counts
   * only claims from jobs created after the newest `task_controls` row for the task, if any: a human
   * instruction resets the discipline, since it means a person, not the goal floor, is now steering.
   * A null or unparseable prior result is simply not a match, never a throw.
   */
  priorClaimCount(taskId: string, jobId: string, outcome: TaskState): number {
    const since = this.database.db.prepare(
      "SELECT created_at FROM task_controls WHERE task_id=? ORDER BY created_at DESC LIMIT 1",
    ).get(taskId) as { created_at: string } | undefined;
    const rows = (
      since
        ? this.database.db.prepare(
            "SELECT result FROM jobs WHERE task_id=? AND id<>? AND execution_kind IN ('foreground','promotion') AND state='succeeded' AND result IS NOT NULL AND created_at>?",
          ).all(taskId, jobId, since.created_at)
        : this.database.db.prepare(
            "SELECT result FROM jobs WHERE task_id=? AND id<>? AND execution_kind IN ('foreground','promotion') AND state='succeeded' AND result IS NOT NULL",
          ).all(taskId, jobId)
    ) as Array<{ result: unknown }>;
    let count = 0;
    for (const row of rows) {
      const parsed = typeof row.result === "string" ? parseTaskResult(row.result) : null;
      if (parsed?.outcome === outcome) count++;
    }
    return count;
  }
  paused(taskId: string): boolean {
    const last = this.get(taskId).controls.filter((c) => c.kind === "pause" || c.kind === "resume").at(-1);
    return last?.kind === "pause";
  }
  event(taskId: string, type: string, data: object, jobId: string | null = null): void {
    this.database.db.prepare("UPDATE tasks SET updated_at=?,revision=revision+1 WHERE id=?").run(new Date().toISOString(), taskId);
    const detail = this.get(taskId);
    this.database.insertEvent(detail.task.roomId, jobId, type, { ...data, ...detail });
  }
  consume(consumerId: string, roomId: string | null, limit: number): { items: ReturnType<DovskyDatabase["listEvents"]>; cursor: number } {
    this.consumerId(consumerId);
    return this.database.transaction(() => {
      this.database.db.prepare("INSERT OR IGNORE INTO event_consumers(id,room_id) VALUES(?,?)").run(consumerId, roomId);
      const row = this.database.db.prepare("SELECT * FROM event_consumers WHERE id=?").get(consumerId)!;
      if (row.room_id !== roomId) throw new DaemonError("STATE_CONFLICT", "Consumer room filter cannot change");
      const items = this.database.listEvents(roomId, Number(row.acknowledged), limit);
      const cursor = items.at(-1)?.id ?? Number(row.acknowledged);
      this.database.db.prepare("UPDATE event_consumers SET delivered=MAX(delivered,?) WHERE id=?").run(cursor, consumerId);
      return { items, cursor };
    });
  }
  peek(consumerId:string,limit:number):{items:ReturnType<DovskyDatabase['listEvents']>;cursor:number} {
    this.consumerId(consumerId);
    const row=this.database.db.prepare('SELECT room_id,acknowledged FROM event_consumers WHERE id=?').get(consumerId);
    const acknowledged=Number(row?.acknowledged??0),roomId=row?.room_id==null?null:String(row.room_id);
    const items=this.database.listEvents(roomId,acknowledged,limit);
    return {items,cursor:items.at(-1)?.id??acknowledged};
  }
  ackEvents(consumerId: string, throughId: number): { cursor: number } {
    this.consumerId(consumerId);
    const row = this.database.db.prepare("SELECT * FROM event_consumers WHERE id=?").get(consumerId);
    if (!row || !Number.isSafeInteger(throughId) || throughId < Number(row.acknowledged) || throughId > Number(row.delivered)) throw new DaemonError("STATE_CONFLICT", "Cursor must be within delivered events and cannot move backwards");
    this.database.db.prepare("UPDATE event_consumers SET acknowledged=? WHERE id=?").run(throughId, consumerId);
    return { cursor: throughId };
  }
  private consumerId(id: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id)) throw new DaemonError("INVALID_REQUEST", "Invalid consumerId");
  }
}
