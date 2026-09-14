import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { TASK_STATES } from "@dovsky/protocol";
import { DovskyDatabase } from "./database.js";
import { CoordinationStore, parseTaskResult } from "./coordination.js";

function harness() {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-controls-test-"));
  const db = new DovskyDatabase(resolve(root, "state.db"));
  db.createRoom("room", "Control tests", "test", "review");
  db.createJob({ id: "job", roomId: "room", provider: "codex", projectId: "test", workflowId: "review", prompt: "work" }, "turn");
  const store = new CoordinationStore(db);
  const start = () => { db.transitionJob("job", ["queued"], "starting"); db.transitionJob("job", ["starting"], "running"); };
  return { db, store, start, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("structured results prefer Dovsky marker, permit one legacy read marker, and reject duplicates or mixed output", () => {
  const value = { outcome: "awaiting_decision", phase: "Release permission", blocker: "Approval missing", nextAction: "Ask operator", acknowledgedControls: [] };
  const line = `DOVSKY_RESULT: ${JSON.stringify(value)}`;
  const legacyLine = `AGENTBUS_RESULT: ${JSON.stringify(value)}`;
  assert.deepEqual(parseTaskResult(`Recap\n${line}`), value);
  assert.deepEqual(parseTaskResult(legacyLine), value);
  for (const text of ["Done. Needs your approval", line + "\n" + line, legacyLine + "\n" + legacyLine, `${line}\n${legacyLine}`, line.replace("awaiting_decision", "success"), 'DOVSKY_RESULT: {"outcome":"completed"}']) assert.equal(parseTaskResult(text), null);
});

test("controls create no job; delivery and ordered acknowledgment are independently durable", () => {
  const h = harness();
  try {
    const first = h.store.create({ taskId: "job", kind: "instruction", body: "Inspect conflicts" });
    const second = h.store.create({ taskId: "job", kind: "decision", body: "Migration permitted, tests not attested" });
    assert.equal(h.db.countQueued(), 1);
    assert.equal(first.deliveredAt, null);
    h.start();
    assert.throws(() => h.store.acknowledge("job", "job", [first.id]), /not delivered/);
    h.store.checkpoint("job", "job");
    assert.equal(h.store.get("job").controls[0]!.acknowledgedAt, null);
    assert.throws(() => h.store.acknowledge("job", "job", [second.id]), /in sequence/);
    h.store.acknowledge("job", "job", [first.id, second.id]);
    assert.ok(h.store.get("job").controls.every((c) => c.acknowledgedAt));
    assert.equal(h.db.countActive(), 1);
    assert.equal(h.db.db.prepare("SELECT count(*) AS n FROM release_authorizations").get()!.n, 0);
    assert.equal((h.db.exportData("room").task_controls as unknown[]).length, 2);
    assert.equal((h.db.exportData().tasks as unknown[]).length, 1);
  } finally { h.close(); }
});

test("new controls prevent false completion and explicit checkpoint retains worktree ownership", () => {
  const h = harness();
  try {
    h.start();
    h.store.claim("job", "/fixture/worktree", true);
    h.store.create({ taskId: "job", kind: "instruction", body: "New instruction" });
    const task = h.store.finish("job", "job", { outcome: "completed", phase: "Done", blocker: null, nextAction: null, acknowledgedControls: [] });
    assert.equal(task.state, "checkpointed");
    assert.equal(h.db.db.prepare("SELECT task_id FROM task_ownership").get()!.task_id, "job");
    const controls = h.store.checkpoint("job", "job").controls;
    h.store.finish("job", "job", { outcome: "completed", phase: "Done", blocker: null, nextAction: null, acknowledgedControls: controls.map((c) => c.id) });
    assert.equal(h.db.db.prepare("SELECT count(*) AS n FROM task_ownership").get()!.n, 0);
  } finally { h.close(); }
});

test("a completed task retains its worktree ownership while its execution lease is unresolved", () => {
  const h = harness();
  try {
    h.start();
    h.store.claim("job", "/fixture/worktree", true);
    h.db.prepareExecutionLease("lease", "job", null, "provider", 1);
    const task = h.store.finish("job", "job", { outcome: "completed", phase: "Provider returned", blocker: null, nextAction: null, acknowledgedControls: [] });
    assert.equal(task.state, "completed");
    assert.equal(h.db.db.prepare("SELECT task_id FROM task_ownership").get()!.task_id, "job");
    h.db.settleExecutionLease("lease");
    h.db.transitionJob("job", ["running"], "succeeded");
    assert.equal(h.db.releaseTaskOwnershipIfSafe("job"), true);
    assert.equal(h.db.db.prepare("SELECT task_id FROM task_ownership").get(), undefined);
  } finally { h.close(); }
});

test("foreground consumer replays until explicit ACK, retains cursor across reconnection", () => {
  const h = harness();
  try {
    const first = h.store.consume("codex-chat", "room", 2);
    assert.equal(first.items.length, 2);
    assert.deepEqual(h.store.consume("codex-chat", "room", 2), first);
    assert.throws(() => h.store.ackEvents("codex-chat", first.cursor + 100), /delivered/);
    h.store.ackEvents("codex-chat", first.cursor);
    assert.equal(new CoordinationStore(h.db).consume("codex-chat", "room", 2).items.length, 0);
    assert.throws(() => h.store.consume("codex-chat", null, 2), /filter cannot change/);
  } finally { h.close(); }
});

test("acknowledging a pause cannot complete a task and workdir rebinding does not steal ownership", () => {
  const h = harness();
  try {
    h.start();
    h.store.claim("job", "/fixture/original", true);
    const control = h.store.create({ taskId: "job", kind: "pause", body: "Pause safely" });
    h.store.checkpoint("job", "job");
    const result = h.store.finish("job", "job", { outcome: "completed", phase: "Done", blocker: null, nextAction: null, acknowledgedControls: [control.id] });
    assert.equal(result.state, "checkpointed");
    assert.equal(h.store.paused("job"), true);
    assert.throws(() => h.store.claim("job", "/fixture/other", true), /workdir cannot change/);
    assert.equal(h.db.db.prepare("SELECT count(*) AS n FROM task_ownership").get()!.n, 1);
    h.store.create({ taskId: "job", kind: "resume", body: "Continue" });
    assert.equal(h.store.paused("job"), false);
    assert.equal(h.db.countQueued(), 0);
  } finally { h.close(); }
});

test("explicit checkpoint rebind moves ownership only when the task and target are free", () => {
  const h = harness();
  try {
    h.start();
    h.store.claim("job", "/fixture/original", true);
    h.store.setState("job", { outcome: "checkpointed", phase: "Safe checkpoint", blocker: null, nextAction: "Resume", acknowledgedControls: [] });
    assert.throws(() => h.store.rebind("job", "/fixture/target", true), /queued or active execution/);

    h.db.transitionJob("job", ["running"], "succeeded", { result: "checkpointed" });
    h.db.db.prepare("INSERT INTO release_operations(id,task_id,room_id,semantic_key,state,data_json) VALUES('release','job','room','release-key','reconcile_required','{}')").run();
    assert.throws(() => h.store.rebind("job", "/fixture/target", true), /uncertain release operation/);
    h.db.db.prepare("DELETE FROM release_operations WHERE id='release'").run();
    h.db.createJob({ id: "other", roomId: "room", provider: "codex", projectId: "test", workflowId: "review", prompt: "other" }, "other-turn");
    h.store.claim("other", "/fixture/target", true);
    assert.throws(() => h.store.rebind("job", "/fixture/target", true), /owned by another task/);
    assert.equal(h.db.db.prepare("SELECT task_id FROM task_ownership WHERE workdir='/fixture/original'").get()!.task_id, "job");

    h.store.setState("other", { outcome: "completed", phase: "Done", blocker: null, nextAction: null, acknowledgedControls: [] });
    const rebound = h.store.rebind("job", "/fixture/target", true);
    assert.equal(rebound.workdir, "/fixture/target");
    assert.equal(h.db.db.prepare("SELECT task_id FROM task_ownership WHERE workdir='/fixture/target'").get()!.task_id, "job");
    assert.equal(h.db.db.prepare("SELECT 1 FROM task_ownership WHERE workdir='/fixture/original'").get(), undefined);

    h.store.setState("job", { outcome: "blocked", phase: "Blocked", blocker: "Conflict", nextAction: "Inspect", acknowledgedControls: [] });
    assert.throws(() => h.store.rebind("job", "/fixture/third", true), /Only a checkpointed task/);
  } finally { h.close(); }
});

test("receipt events retain the acting execution when a continuation is queued", () => {
  const h = harness();
  try {
    h.start();
    h.db.createJob({ id: "continuation", predecessorJobId: "job", roomId: "room", provider: "codex", projectId: "test", workflowId: "review", prompt: "Continue" }, "next-turn");
    assert.equal(h.store.get("job").task.latestJobId, "continuation");
    const control = h.store.create({ taskId: "job", kind: "instruction", body: "Check before continuing" });
    h.store.checkpoint("job", "job");
    h.store.finish("job", "job", { outcome: "completed", phase: "Done", blocker: null, nextAction: null, acknowledgedControls: [control.id] });
    const events = h.db.listEvents("room", 0, 100).filter(event => ["task.controls.delivered", "task.controls.acknowledged", "task.updated"].includes(event.type));
    assert.equal(events.length, 3);
    assert.ok(events.every(event => event.jobId === "job"), "receipt and completion events must identify the predecessor that acted, not the queued continuation");
    const detail = h.store.get("job");
    assert.equal(detail.task.latestJobId, "continuation");
    assert.equal(detail.controls[0]!.acknowledgedJobId, "job");
    assert.equal(h.store.consume("attribution-regression", "room", 100).items.filter(event => events.some(receipt => receipt.id === event.id)).length, 3);
  } finally { h.close(); }
});

test("a queued continuation cannot hide the paused checkpoint state", () => {
  const h = harness();
  try {
    h.start();
    h.db.createJob({ id: "continuation", predecessorJobId: "job", roomId: "room", provider: "codex", projectId: "test", workflowId: "review", prompt: "Continue" }, "next-turn");
    h.store.create({ taskId: "job", kind: "pause", body: "Pause" });
    const result = h.store.finish("job", "job", { outcome: "checkpointed", phase: "Yield", blocker: null, nextAction: "Resume", acknowledgedControls: [] });
    assert.equal(result.state, "checkpointed");
    assert.equal(result.phase, "Paused at checkpoint");
    assert.equal(h.db.getJob("continuation")!.state, "queued");
  } finally { h.close(); }
});

test("listPending returns only the four human-waiting states, excluding every other state", () => {
  const h = harness();
  try {
    const ids = TASK_STATES.map((state) => `state-${state}`);
    for (const id of ids) h.db.createJob({ id, roomId: "room", provider: "codex", projectId: "test", workflowId: "review", prompt: "work" }, `turn-${id}`);
    for (const state of TASK_STATES) h.store.setState(`state-${state}`, { outcome: state, phase: state, blocker: null, nextAction: null, acknowledgedControls: [] });
    const pendingIds = h.store.listPending().map((t) => t.id).sort();
    assert.deepEqual(pendingIds, ["state-awaiting_decision", "state-blocked", "state-checkpointed", "state-unknown"]);
  } finally { h.close(); }
});

test("a migrated legacy task waits on no one: the inbox and the room list's attention filter agree", () => {
  const h = harness();
  try {
    h.db.createRoom("legacy-room", "Imported", "test", "review");
    h.db.createJob({ id: "legacy", roomId: "legacy-room", provider: "codex", projectId: "test", workflowId: "review", prompt: "work" }, "legacy-turn");
    h.store.setState("legacy", { outcome: "unknown", phase: "legacy execution; outcome not reported", blocker: null, nextAction: null, acknowledgedControls: [] });
    h.store.setState("job", { outcome: "unknown", phase: "Execution interrupted", blocker: "Inspect effects before resuming", nextAction: "Reconcile then resume explicitly", acknowledgedControls: [] });
    assert.deepEqual(h.store.listPending().map((t) => t.id), ["job"]);
    assert.deepEqual(h.db.listRooms(50, null, undefined, "attention").items.map((r) => r.id), ["room"]);
  } finally { h.close(); }
});

test("listPending spans rooms and attaches each task's own roomTitle", () => {
  const h = harness();
  try {
    h.db.createRoom("room-2", "Second room", "test", "review");
    h.db.createJob({ id: "other", roomId: "room-2", provider: "codex", projectId: "test", workflowId: "review", prompt: "work" }, "other-turn");
    h.store.setState("job", { outcome: "checkpointed", phase: "Checkpointed", blocker: null, nextAction: "Resume", acknowledgedControls: [] });
    h.store.setState("other", { outcome: "awaiting_decision", phase: "Waiting", blocker: "Needs approval", nextAction: "Decide", acknowledgedControls: [] });
    const byId = new Map(h.store.listPending().map((t) => [t.id, t]));
    assert.equal(byId.size, 2);
    assert.equal(byId.get("job")!.roomTitle, "Control tests");
    assert.equal(byId.get("other")!.roomTitle, "Second room");
  } finally { h.close(); }
});

test("listPending orders by updated_at descending, tiebroken by id", () => {
  const h = harness();
  try {
    h.db.createJob({ id: "aaa", roomId: "room", provider: "codex", projectId: "test", workflowId: "review", prompt: "work" }, "aaa-turn");
    h.db.createJob({ id: "older", roomId: "room", provider: "codex", projectId: "test", workflowId: "review", prompt: "work" }, "older-turn");
    for (const id of ["job", "aaa", "older"]) h.store.setState(id, { outcome: "blocked", phase: "Blocked", blocker: "x", nextAction: null, acknowledgedControls: [] });
    // "job" and "aaa" tie on updated_at; "older" is older. "aaa" was inserted after "job",
    // so insertion order and id order disagree: only the id tiebreak puts "aaa" first.
    h.db.db.prepare("UPDATE tasks SET updated_at=? WHERE id IN ('job','aaa')").run("2026-01-01T00:00:00.000Z");
    h.db.db.prepare("UPDATE tasks SET updated_at=? WHERE id='older'").run("2025-01-01T00:00:00.000Z");
    assert.deepEqual(h.store.listPending().map((t) => t.id), ["aaa", "job", "older"]);
  } finally { h.close(); }
});

test("listPending caps at 200 even when more tasks are pending", () => {
  const h = harness();
  try {
    const insert = h.db.db.prepare("INSERT INTO tasks(id,room_id,provider,latest_job_id,state,phase,workdir,created_at,updated_at) VALUES(?,'room','codex','job','blocked','Blocked',NULL,?,?)");
    for (let i = 0; i < 205; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
      insert.run(`overflow-${String(i).padStart(3, "0")}`, ts, ts);
    }
    const pending = h.store.listPending();
    assert.equal(pending.length, 200);
    assert.equal(pending[0]!.id, "overflow-204"); // Newest updated_at first.
    assert.ok(!pending.some((t) => ["overflow-000", "overflow-001", "overflow-002", "overflow-003", "overflow-004"].includes(t.id)));
  } finally { h.close(); }
});

test("listPending is empty when no task is waiting on a human", () => {
  const h = harness();
  try {
    assert.deepEqual(h.store.listPending(), []);
  } finally { h.close(); }
});

test("a legacy row's terminal colour residue and proof-worktree scratch path are cleaned on read, not rewritten in place", () => {
  const h = harness();
  try {
    // Seed a row the way the daemon actually wrote it before this fix: raw captured output straight in the
    // blocker/phase columns, bypassing the store's write path entirely (setState/finish never produce this).
    const dirty =
      "red-before: the test passes without the fix, so it proves nothing: \x1b[1m\x1b[30m\x1b[46m RUN " +
      "\x1b[49m\x1b[39m\x1b[22m \x1b[36mv4.1.10 \x1b[39m\x1b[90m/home/USER/.agentbus-v2/artifacts/proof-worktrees/" +
      "bee84b9f-4690-4bc4-a7c2-33c4eead4d93/backend\x1b[39m";
    h.db.db.prepare("UPDATE tasks SET state='blocked', blocker=?, phase=? WHERE id='job'").run(dirty, dirty);

    const pending = h.store.listPending();
    assert.equal(pending.length, 1);
    for (const text of [pending[0]!.blocker, pending[0]!.phase]) {
      assert.doesNotMatch(text ?? "", /\x1b/, "no raw escape byte");
      assert.doesNotMatch(text ?? "", /\[\d+m/, "no ANSI bracket residue");
      assert.doesNotMatch(text ?? "", /proof-worktrees/, "the daemon's scratch path is not exposed");
      assert.match(text ?? "", /RUN\s+v4\.1\.10\s+backend$/, "the path reads relative to the project");
    }
    // get()/list() read through the same getTask(), so they see the same cleaned text.
    assert.equal(h.store.get("job").task.blocker, pending[0]!.blocker);
    assert.equal(h.store.list("room").find((t) => t.id === "job")!.blocker, pending[0]!.blocker);
    // Nothing was rewritten in the database itself -- only the read is sanitized.
    assert.equal(h.db.db.prepare("SELECT blocker FROM tasks WHERE id='job'").get()!.blocker, dirty);
  } finally { h.close(); }
});
