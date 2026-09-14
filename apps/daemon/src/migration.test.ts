import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DovskyDatabase } from "./database.js";

import { seedHistoricalDatabase as seed, downgradeHistoricalDatabase as downgrade } from "./__fixtures__/historical-database.js";
import { SCHEMA_VERSION } from "./schema-migrations.js";
for (const variant of ["schema9", "visibility10", "coordination10"] as const) {
  test(`schema 13 reconciles ${variant} without losing existing records`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "dovsky-schema-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "state.db"); seed(path); downgrade(path, variant);
    const before = new DatabaseSync(path);
    if (variant === "visibility10") before.prepare("UPDATE jobs SET reported_model='observed-model' WHERE id='parent'").run();
    const counts = ["rooms", "jobs", "turns", "events"].map((table) => [table, before.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n] as const);
    const controls = variant === "coordination10" ? before.prepare("SELECT * FROM task_controls").all() : null;
    const releases = variant === "coordination10" ? before.prepare("SELECT * FROM release_operations").all() : null;
    before.close();
    const db = new DovskyDatabase(path);
    try {
      assert.equal(db.db.prepare("PRAGMA user_version").get()!.user_version, SCHEMA_VERSION);
      assert.deepEqual(db.db.prepare("PRAGMA foreign_key_check").all(), []);
      for (const [table, count] of counts) assert.equal(db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, count);
      const parent = db.getJobSummary("parent");
      assert.equal(parent.requestedModel, "gpt-5.6-terra");
      assert.equal(parent.reportedModel, variant === "visibility10" ? "observed-model" : null);
      assert.equal(db.getJob("parent")!.prompt, "old prompt");
      if (variant === "coordination10") {
        assert.deepEqual(db.db.prepare("SELECT * FROM task_controls").all(), controls);
        assert.deepEqual(db.db.prepare("SELECT id,task_id,room_id,semantic_key,state,data_json FROM release_operations").all(), releases);
        assert.equal(db.db.prepare("SELECT owner_token FROM release_targets").get()!.owner_token, "owner");
        assert.equal(db.db.prepare("SELECT workdir FROM task_ownership").get()!.workdir, "/owned/tree");
        assert.equal(db.db.prepare("SELECT acknowledged FROM event_consumers").get()!.acknowledged, 1);
      }
      if (variant === "visibility10") {
        for (const id of ["child", "grandchild"]) {
          assert.equal(db.getJob(id)!.taskId, "parent");
          assert.equal(db.db.prepare("SELECT predecessor_pending FROM jobs WHERE id=?").get(id)!.predecessor_pending, 1);
        }
        assert.equal(db.db.prepare("SELECT latest_job_id FROM tasks WHERE id='parent'").get()!.latest_job_id, "grandchild");
        assert.equal(db.db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 1);
      }
      db.createJob({ id: "new", roomId: "room", provider: "codex", projectId: "project", workflowId: "review", prompt: "admission probe", model: "gpt-5.6-luna" }, "new-turn");
      assert.equal(db.getJobSummary("new").requestedModel, "gpt-5.6-luna");
    } finally { db.close(); }
    const reopened = new DovskyDatabase(path);
    assert.equal(reopened.getJobSummary("new").reportedModel, null); reopened.close();
  });
}

test("schema validation rejects missing required columns even when version numbers match", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dovsky-schema-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.db"); seed(path);
  const damaged = new DatabaseSync(path); damaged.exec("ALTER TABLE jobs DROP COLUMN requested_model"); damaged.close();
  assert.throws(() => new DovskyDatabase(path), /missing jobs.requested_model/);
});

test("an incomplete coordination migration fails atomically without advancing schema version", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dovsky-schema-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.db"); seed(path); downgrade(path, "coordination10");
  const damaged = new DatabaseSync(path); damaged.exec("DROP TABLE event_consumers"); damaged.close();
  assert.throws(() => new DovskyDatabase(path), /Incomplete coordination schema/);
  const check = new DatabaseSync(path); assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 10); check.close();
});

// Schema 13 puts a session above rooms. The migration must adopt every existing room -- a room with a
// null session_id would be invisible to a sidebar that groups by session, which is the whole point of
// the layer -- and it must create exactly one session per (project, workflow) rather than one per room.
function downgradeToSchema12(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("DROP INDEX rooms_session_idx; ALTER TABLE rooms DROP COLUMN session_id; ALTER TABLE rooms DROP COLUMN archived; ALTER TABLE rooms DROP COLUMN pinned; DROP TABLE sessions; PRAGMA user_version=12;");
  } finally { db.close(); }
}

test("schema 13 adopts every existing room into one session per project and workflow", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dovsky-schema-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.db");
  seed(path);
  // Two more rooms on the same workflow and one on a different workflow: the backfill must group, not copy.
  const extra = new DatabaseSync(path);
  try {
    for (const id of ['room-2','room-3','room-4']) extra.prepare("INSERT INTO rooms(id,title,project_id,workflow_id,created_at,updated_at) VALUES(?,?,'project',?,'2026-09-09','2026-09-09')").run(id,id,id==='room-4'?'change':'review');
  } finally { extra.close(); }
  downgradeToSchema12(path);

  const db = new DovskyDatabase(path);
  try {
    assert.equal(db.db.prepare("PRAGMA user_version").get()!.user_version, SCHEMA_VERSION);
    assert.deepEqual(db.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM rooms WHERE session_id IS NULL").get()!.n, 0, "every room must be adopted");
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM sessions").get()!.n, 2, "one session per (project, workflow), not one per room");
    const review = db.db.prepare("SELECT session_id FROM rooms WHERE id IN ('room','room-2','room-3')").all().map((row) => row.session_id);
    assert.equal(new Set(review).size, 1, "rooms sharing a workflow share a session");
    assert.notEqual(db.db.prepare("SELECT session_id FROM rooms WHERE id='room-4'").get()!.session_id, review[0]);
    // Archive and pin are plain room columns and default off, so no existing room changes visibility.
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM rooms WHERE archived=0 AND pinned=0").get()!.n, 4);
  } finally { db.close(); }
});
