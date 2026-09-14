import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ContentChunk, EventEnvelope, RoomSnapshot } from "@dovsky/protocol";
import { DovskyDatabase } from "./database.js";
import { legacyRoom, readView, roomSnapshot } from "./reads.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dovsky-reads-"));
  const db = new DovskyDatabase(join(root, "state.db"));
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts);
  db.createRoom("room", "History", "project", "workflow");
  db.createRoom("other", "Other", "project", "workflow");
  db.createJob({ id: "job", roomId: "room", provider: "codex", projectId: "project", workflowId: "workflow", prompt: "test" }, "prompt");
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, artifacts };
}

test("large room reads are bounded, paginated and preserve full Unicode content", (t) => {
  const { db, artifacts } = fixture(t);
  const body = "漢🙂".repeat(30_000);
  const insert = db.db.prepare("INSERT INTO turns(id,job_id,room_id,author,recipient,body,created_at,status,role) VALUES(?,?,'room','codex','human',?,'2026-09-09','complete','work')");
  for (let i = 0; i < 26; i++) insert.run(`turn-${i}`, "job", body);
  assert.throws(() => legacyRoom(db, "room"), /rooms.snapshot/);
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = roomSnapshot(db, { roomId: "room", limit: 7, ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
    assert.ok(page.eventCursor > 0);
    for (const turn of page.turns) {
      assert.equal(ids.has(turn.id), false);
      assert.equal(turn.bodyTruncated, turn.id !== "prompt");
      ids.add(turn.id);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(ids.size, 27); // Includes the job's original prompt turn.
  let offset = 0;
  const chunks: Buffer[] = [];
  for (;;) {
    const chunk = readView(db, artifacts, "turns.read", { roomId: "room", turnId: "turn-0", offset, limit: 65535 }) as ContentChunk;
    chunks.push(Buffer.from(chunk.data, "base64"));
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  }
  assert.equal(Buffer.concat(chunks).toString("utf8"), body);
});

test("legacy room reads preserve responses below the RPC transport limit", (t) => {
  const { db } = fixture(t);
  const body = "x".repeat(1_500_000);
  db.db.prepare("INSERT INTO turns(id,job_id,room_id,author,recipient,body,created_at,status,role) VALUES('large-turn','job','room','codex','human',?,'2026-09-09','complete','work')")
    .run(body);
  const detail = legacyRoom(db, "room");
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) > 1024 * 1024);
  assert.equal(detail.turns.find((turn) => turn.id === "large-turn")?.body, body);
  assert.deepEqual(detail.tasks?.map((task) => task.id), ["job"]);
});

test("rooms.snapshot, jobs.evidence and the legacy room read all clean a directly seeded dirty checks/tasks row, without rewriting the stored row", (t) => {
  const { db } = fixture(t);
  // Seeded the way the daemon actually wrote it before this fix: raw captured output straight in the
  // checks.summary and tasks.blocker/phase columns, bypassing every write-side sanitizer entirely.
  const dirty =
    "red-before: the test passes without the fix, so it proves nothing: \x1b[1m\x1b[30m\x1b[46m RUN " +
    "\x1b[49m\x1b[39m\x1b[22m \x1b[36mv4.1.10 \x1b[39m\x1b[90m/home/USER/.agentbus-v2/artifacts/proof-worktrees/" +
    "bee84b9f-4690-4bc4-a7c2-33c4eead4d93/backend\x1b[39m";
  db.db.prepare("INSERT INTO checks(id,job_id,command_json,state,exit_code,summary) VALUES('check-1','job','[\"sh\"]','failed',1,?)").run(dirty);
  db.db.prepare("UPDATE tasks SET state='blocked', blocker=?, phase=? WHERE id='job'").run(dirty, dirty);

  const assertClean = (text: string | null | undefined): void => {
    assert.doesNotMatch(text ?? "", /\x1b/, "no raw escape byte");
    assert.doesNotMatch(text ?? "", /\[\d+m/, "no ANSI bracket residue");
    assert.doesNotMatch(text ?? "", /proof-worktrees/, "the daemon's scratch path is not exposed");
    assert.match(text ?? "", /RUN\s+v4\.1\.10\s+backend$/, "the path reads relative to the project");
  };

  // jobs.evidence: roomSnapshot with a jobId selects the single job's own evidence page. (Its tasks
  // window is deliberately empty for a job-scoped read; checks are still scoped to the job.)
  const evidence = roomSnapshot(db, { roomId: "room", jobId: "job" }, true);
  assertClean(evidence.checks.find((c) => c.id === "check-1")?.summary);

  // rooms.snapshot: the paginated whole-room read.
  const snapshot = roomSnapshot(db, { roomId: "room" });
  assertClean(snapshot.checks.find((c) => c.id === "check-1")?.summary);
  assertClean(snapshot.tasks?.find((tsk) => tsk.id === "job")?.blocker);

  // The legacy full room read (database.getRoom) has its own separate checks mapping.
  const legacy = legacyRoom(db, "room");
  assertClean(legacy.checks.find((c) => c.id === "check-1")?.summary);
  assertClean(legacy.tasks?.find((tsk) => tsk.id === "job")?.blocker);

  // Nothing was rewritten in the database itself -- only the read is sanitized.
  assert.equal(db.db.prepare("SELECT summary FROM checks WHERE id='check-1'").get()!.summary, dirty);
  assert.equal(db.db.prepare("SELECT blocker FROM tasks WHERE id='job'").get()!.blocker, dirty);
});

test("room list paginates by bytes without losing rooms with large acceptance contracts", (t) => {
  const { db } = fixture(t);
  const criteria = Array.from({ length: 30 }, () => "漢".repeat(1996));
  for (let index = 0; index < 10; index++) {
    const roomId = `large-room-${index}`;
    const jobId = `large-job-${index}`;
    db.createRoom(roomId, "Large contract", "project", "workflow");
    db.createJob({ id: jobId, roomId, provider: "codex", projectId: "project", workflowId: "workflow", prompt: "test" }, `large-prompt-${index}`);
    db.db.prepare("UPDATE jobs SET evaluation_json=? WHERE id=?").run(JSON.stringify({
      baselineJobId: jobId, level: "medium", reason: "Review", criteria,
      expectedBaselineFailures: [], runnerSource: "export default null", runnerPath: "evaluation.mjs",
      runnerHash: "a".repeat(64), dependencyRoots: [], qualityCommands: [], reviewRequired: true,
    }), jobId);
  }
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = db.listRooms(100, cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
    assert.ok(page.items.length > 0);
    for (const room of page.items) {
      assert.equal(seen.has(room.id), false);
      seen.add(room.id);
      if (room.id.startsWith("large-room-")) assert.deepEqual(room.evaluation?.criteria, criteria);
    }
    cursor = page.nextCursor;
    assert.ok(++pages < 10);
  } while (cursor);
  assert.equal(seen.size, 12);
  assert.ok(pages > 1);
});

test("maximum valid active Unicode evaluation metadata paginates without exceeding the page bound", (t) => {
  const { db } = fixture(t);
  db.createJob({ id: "job-large", roomId: "room", provider: "codex", projectId: "project", workflowId: "workflow", prompt: "test" }, "prompt-large");
  const criteria = Array.from({ length: 30 }, (_, index) => `${index}: ${"漢".repeat(1996)}`);
  const scenarios = Array.from({ length: 100 }, (_, index) => ({
    id: `scenario-${index}`,
    passed: true,
    detail: "漢".repeat(8000),
    durationMs: 1,
  }));
  const evaluation = {
    baselineJobId: "job",
    level: "high",
    reason: "漢".repeat(4000),
    criteria,
    expectedBaselineFailures: [],
    runnerSource: "export default null",
    runnerPath: "evaluation.mjs",
    runnerHash: "a".repeat(64),
    dependencyRoots: [],
    qualityCommands: [],
    reviewRequired: true,
  };
  const report = { suiteHash: "a".repeat(64), candidate: scenarios, baseline: scenarios, problems: [] };
  const decision = {
    verdict: "accepted",
    note: "漢".repeat(8000),
    checked: Array.from({ length: criteria.length }, (_, index) => index),
    at: "2026-09-09T00:00:00.000Z",
  };
  const update = db.db.prepare(`UPDATE jobs SET evaluation_json=?,evaluation_report_json=?,acceptance_json=?,
    evaluation_evidence_hash=?,end_fingerprint=?,state='running',grade='good',grade_source='human',grade_note=? WHERE id=?`);
  for (const jobId of ["job", "job-large"]) {
    update.run(JSON.stringify({ ...evaluation, baselineJobId: jobId }), JSON.stringify(report), JSON.stringify(decision),
      "b".repeat(64), "c".repeat(64), "漢".repeat(8000), jobId);
  }
  assert.equal(db.roomSummary(db.getRoomRow("room")!).evaluation?.report, null);
  assert.deepEqual(db.getJobSummary("job-large").evaluation?.report, report);

  const seen = new Set<string>();
  let pages = 0;
  let cursor: string | undefined;
  do {
    const page = roomSnapshot(db, { roomId: "room", ...(cursor ? { cursor } : {}) });
    pages += 1;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
    assert.equal(page.room.evaluation?.report, null);
    for (const job of page.jobs) {
      assert.equal(seen.has(job.id), false);
      assert.equal(job.evaluation?.report?.candidate.length, 100);
      seen.add(job.id);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.ok(pages >= 2);
  assert.deepEqual(seen, new Set(["job", "job-large"]));
});

test("snapshot cursor is scoped, stable across inserts, and selected evidence checks room ownership", (t) => {
  const { db, artifacts } = fixture(t);
  for (let i = 0; i < 3; i++) db.createJob({ id: `job-${i}`, roomId: "room", provider: "codex", projectId: "project", workflowId: "workflow", prompt: "test" }, `prompt-${i}`);
  const first = roomSnapshot(db, { roomId: "room", limit: 2 });
  assert.ok(first.nextCursor);
  db.createJob({ id: "new", roomId: "room", provider: "codex", projectId: "project", workflowId: "workflow", prompt: "test" }, "prompt-new");
  const next = roomSnapshot(db, { roomId: "room", limit: 2, cursor: first.nextCursor });
  assert.ok(next.jobs.every((job) => job.id !== "new" && !first.jobs.some((previous) => previous.id === job.id)));
  assert.throws(() => roomSnapshot(db, { roomId: "other", cursor: first.nextCursor }), /Cursor/);
  const malformed = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
  delete malformed.priorityOffset;
  assert.throws(() => roomSnapshot(db, { roomId: "room", cursor: Buffer.from(JSON.stringify(malformed)).toString("base64url") }), /Cursor/);
  assert.throws(() => readView(db, artifacts, "jobs.evidence", { roomId: "other", jobId: "job" }), /this room/);
  const evidence = readView(db, artifacts, "jobs.evidence", { roomId: "room", jobId: "job" }) as RoomSnapshot;
  assert.deepEqual(evidence.jobs.map((job) => job.id), ["job"]);
  assert.ok(evidence.turns.every((turn) => turn.jobId === "job"));
});

test("a paginated change set marks its first page for reset without claiming either page is complete", (t) => {
  const { db } = fixture(t);
  db.replaceChanges("job", Array.from({ length: 51 }, (_, index) => ({
    path: `change-${index}.ts`, status: "added", additions: 1, deletions: 0,
  })));

  const first = roomSnapshot(db, { roomId: "room", jobId: "job", limit: 50 }, true);
  const second = roomSnapshot(db, { roomId: "room", jobId: "job", limit: 50, cursor: first.nextCursor }, true);

  assert.equal(first.changes.length, 50);
  assert.deepEqual(first.resetChangesFor, ["job"]);
  assert.deepEqual(first.completeChangesFor, []);
  assert.equal(second.changes.length, 1);
  assert.deepEqual(second.resetChangesFor, []);
  assert.deepEqual(second.completeChangesFor, []);
  assert.equal(second.eventCursor, first.eventCursor);
});

test("snapshot prioritizes old active work and traverses every job once if its state changes", (t) => {
  const { db } = fixture(t);
  db.transitionJob("job", ["queued"], "starting");
  db.transitionJob("job", ["starting"], "running");
  for (let index = 0; index < 60; index++) {
    const jobId = `terminal-${index}`;
    db.createJob({ id: jobId, roomId: "room", provider: "codex", projectId: "project", workflowId: "workflow", prompt: "test" }, `prompt-${index}`);
    db.transitionJob(jobId, ["queued"], "starting");
    db.transitionJob(jobId, ["starting"], "running");
    db.transitionJob(jobId, ["running"], "succeeded", { result: "done" });
  }

  const seen = new Set<string>();
  let cursor: string | undefined;
  let pageNumber = 0;
  do {
    const page = roomSnapshot(db, { roomId: "room", ...(cursor ? { cursor } : {}) });
    if (pageNumber === 0) {
      assert.equal(page.jobs.some((job) => job.id === "job" && job.state === "running"), true);
      db.transitionJob("job", ["running"], "succeeded", { result: "done" });
    }
    for (const job of page.jobs) {
      assert.equal(seen.has(job.id), false);
      seen.add(job.id);
    }
    pageNumber += 1;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.ok(pageNumber >= 2);
  assert.equal(seen.size, 61);
  assert.equal(seen.has("job"), true);
});

test("snapshot bounds task metadata, prioritizes old live tasks, and traverses task history exactly once", (t) => {
  const { db } = fixture(t);
  db.db.prepare("UPDATE tasks SET state='blocked',phase=?,blocker=?,next_action=? WHERE id='job'")
    .run("漢".repeat(500), "漢".repeat(2000), "漢".repeat(2000));
  for (let index = 0; index < 60; index++) {
    const jobId = `task-job-${index}`;
    db.createJob({ id: jobId, roomId: "room", provider: "codex", projectId: "project", workflowId: "workflow", prompt: "test" }, `task-prompt-${index}`);
    db.transitionJob(jobId, ["queued"], "starting");
    db.transitionJob(jobId, ["starting"], "running");
    db.transitionJob(jobId, ["running"], "succeeded", { result: "done" });
    db.db.prepare("UPDATE tasks SET state='completed',phase=?,blocker=?,next_action=? WHERE id=?")
      .run("漢".repeat(500), "漢".repeat(2000), "漢".repeat(2000), jobId);
  }

  const summary = db.roomSummary(db.getRoomRow("room")!);
  assert.equal(summary.tasks?.length, 1);
  assert.equal(summary.tasks?.[0]?.id, "job");
  assert.equal(summary.taskCounts?.blocked, 1);
  assert.equal(summary.taskCounts?.completed, 60);
  assert.equal(summary.needsAttention, true);

  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = roomSnapshot(db, { roomId: "room", limit: 20, ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
    assert.equal(page.room.tasks, undefined);
    if (pages === 0) {
      assert.equal(page.tasks?.some((task) => task.id === "job" && task.state === "blocked"), true);
      db.db.prepare("UPDATE tasks SET state='completed' WHERE id='job'").run();
    }
    for (const task of page.tasks ?? []) {
      assert.equal(seen.has(task.id), false);
      seen.add(task.id);
    }
    pages += 1;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.ok(pages >= 4);
  assert.equal(seen.size, 61);
  assert.equal(seen.has("job"), true);
});

test("content reads validate offsets, ownership and registered artifact storage", (t) => {
  const { db, artifacts, root } = fixture(t);
  const path = join(artifacts, "evidence.txt");
  writeFileSync(path, "proof漢字");
  db.addArtifact("artifact", "job", "evidence", "evidence.txt", "text/plain", 12, path);
  const chunk = readView(db, artifacts, "artifacts.read", { roomId: "room", artifactId: "artifact" }) as ContentChunk;
  assert.equal(Buffer.from(chunk.data, "base64").toString("utf8"), "proof漢字");
  assert.throws(() => readView(db, artifacts, "artifacts.read", { roomId: "other", artifactId: "artifact" }), /this room/);
  for (const input of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 65537 }, { offset: 999 }]) {
    assert.throws(() => readView(db, artifacts, "artifacts.read", { roomId: "room", artifactId: "artifact", ...input }));
  }
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "outside");
  const link = join(artifacts, "outside");
  symlinkSync(outside, link);
  db.addArtifact("outside", "job", "evidence", "outside", "text/plain", 7, link);
  assert.throws(() => readView(db, artifacts, "artifacts.read", { roomId: "room", artifactId: "outside" }), /outside registered storage/);
});

test("SSE event pages bound batches and retain oversized event identity for refresh", (t) => {
  const { db, artifacts } = fixture(t);
  const largeId = db.insertEvent("room", "job", "evaluation.report", { detail: "x".repeat(300_000) });
  for (let i = 0; i < 10; i++) db.insertEvent("room", "job", "evaluation.report", { detail: "y".repeat(200_000) });
  let afterId = 0;
  const seen: EventEnvelope[] = [];
  for (;;) {
    const events = readView(db, artifacts, "events.page", { roomId: "room", afterId }) as EventEnvelope[];
    if (!events.length) break;
    assert.ok(Buffer.byteLength(JSON.stringify(events)) < 1024 * 1024);
    assert.ok(events.every((event) => event.id > afterId));
    seen.push(...events);
    afterId = events.at(-1)!.id;
  }
  assert.equal(seen.find((event) => event.id === largeId)?.type, "room.refresh_required");
  assert.equal(seen.filter((event) => event.type === "evaluation.report").length, 10);
  assert.equal(db.listEvents("room", largeId - 1, 1)[0]!.type, "evaluation.report");
});
