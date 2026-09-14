import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DovskyDatabase } from "./database.js";
import { seedHistoricalDatabase, downgradeHistoricalDatabase } from "./__fixtures__/historical-database.js";
import { SCHEMA_VERSION } from "./schema-migrations.js";

test("schema 9 migration preserves legacy records and SQLite backup restores the pre-upgrade schema", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-migration-test-"));
  const path = resolve(root, "legacy.db");
  seedHistoricalDatabase(path);
  downgradeHistoricalDatabase(path, "schema9");
  const old = new DatabaseSync(path);
  try {
    old.exec("UPDATE jobs SET state='succeeded',result='Awaiting permission',cwd='/legacy' WHERE id='parent'");
    await backup(old, resolve(root, "pre-upgrade.db"));
  } finally { old.close(); }
  let upgraded: DovskyDatabase | undefined;
  try {
    upgraded = new DovskyDatabase(path);
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()!.user_version, SCHEMA_VERSION);
    assert.equal(upgraded.db.prepare("SELECT requested_model FROM jobs WHERE id='parent'").get()!.requested_model, "gpt-5.6-terra");
    assert.equal(upgraded.db.prepare("SELECT state FROM tasks WHERE id='parent'").get()!.state, "unknown");
    assert.equal(upgraded.db.prepare("SELECT task_id,result FROM jobs WHERE id='parent'").get()!.task_id, "parent");
    assert.equal(upgraded.db.prepare("SELECT result FROM jobs WHERE id='parent'").get()!.result, "Awaiting permission");
    assert.equal(upgraded.db.prepare("SELECT data_json FROM events").get()!.data_json, '{"unchanged":true}');
    assert.ok(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE name='execution_leases'").get());
    // A room left with a null session_id is invisible to a client that groups by session.
    assert.equal(upgraded.db.prepare("SELECT s.is_default FROM rooms r JOIN sessions s ON s.id=r.session_id WHERE r.id='room'").get()!.is_default, 1);
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(upgraded.integrityCheck(), "ok");
    upgraded.close(); upgraded = undefined;
    upgraded = new DovskyDatabase(path);
    assert.equal(upgraded.db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 3);
    const restored = new DatabaseSync(resolve(root, "pre-upgrade.db"), { readOnly: true });
    try {
      assert.equal(restored.prepare("PRAGMA user_version").get()!.user_version, 9);
      assert.equal(restored.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
      assert.equal(restored.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get(), undefined);
    } finally { restored.close(); }
  } finally { upgraded?.close(); rmSync(root, { recursive: true, force: true }); }
});
