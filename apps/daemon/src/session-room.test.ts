import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import type { JobSummary } from "@dovsky/protocol";
import { FixtureDaemon as DovskyDaemon, removeFixtureTree } from './__fixtures__/runtime-isolation.js';
import { DaemonError, type DaemonConfig } from "./config.js";

/**
 * `idleRoomIn` and `rooms.open` exist so `dovsky send` stops opening one room per task (see 625337a): a task
 * joins the session's open room when one is idle, and only opens a new room when every room in the session
 * is busy. These tests pin down "idle" (no archived flag, no job left running or queued) and the ladder
 * exception (no recipients always opens a new room), since both are easy to get subtly wrong in either
 * direction -- too eager to join holds unrelated work behind `predecessorPending`, too eager to open a room
 * defeats the whole feature.
 */

// --- idleRoomIn: a pure database query, so rooms and jobs are seeded directly and job state is poked by
// raw SQL rather than run through a real provider -- the point is the SQL predicate, not scheduling.

function idleRoomFixture(context: TestContext): DovskyDaemon {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-idle-room-"));
  const daemon = new DovskyDaemon({
    socketPath: resolve(root, "run", "bus.sock"), databasePath: resolve(root, "state", "bus.db"),
    artifactDirectory: resolve(root, "artifacts"),
    maxActive: 1,
    projects: [{ id: "project", name: "Fixture", path: root, workflows: [
      { id: "change", name: "Change", readOnly: false, qualityCommands: [], providers: { codex: { argv: [process.execPath] } } },
    ] }],
  });
  context.after(async () => { await daemon.stop(); daemon.close(); removeFixtureTree(root); });
  return daemon;
}

function addJob(daemon: DovskyDaemon, roomId: string, jobId: string): void {
  daemon.database.createJob({ id: jobId, roomId, provider: "codex", projectId: "project", workflowId: "change", prompt: "p" }, randomUUID());
}

function setJobState(daemon: DovskyDaemon, jobId: string, state: string): void {
  daemon.database.db.prepare("UPDATE jobs SET state=? WHERE id=?").run(state, jobId);
}

test("idleRoomIn returns null for a session with no rooms", (context) => {
  const daemon = idleRoomFixture(context);
  const sessionId = daemon.database.defaultSessionFor("project", "change");
  assert.equal(daemon.database.idleRoomIn(sessionId), null);
});

test("idleRoomIn skips an archived room that would otherwise be idle", (context) => {
  const daemon = idleRoomFixture(context);
  daemon.database.createRoom("a", "Archived", "project", "change");
  daemon.database.setRoomArchived("a", true);
  const sessionId = daemon.database.defaultSessionFor("project", "change");
  assert.equal(daemon.database.idleRoomIn(sessionId), null);
});

for (const state of ["queued", "starting", "running", "cancel_requested"]) {
  test(`idleRoomIn skips a room whose only job is ${state}`, (context) => {
    const daemon = idleRoomFixture(context);
    daemon.database.createRoom("a", "Busy", "project", "change");
    addJob(daemon, "a", "job-1");
    setJobState(daemon, "job-1", state);
    const sessionId = daemon.database.defaultSessionFor("project", "change");
    assert.equal(daemon.database.idleRoomIn(sessionId), null);
  });
}

for (const state of ["succeeded", "failed", "cancelled"]) {
  test(`idleRoomIn returns a room whose only job is terminal (${state})`, (context) => {
    const daemon = idleRoomFixture(context);
    daemon.database.createRoom("a", "Done", "project", "change");
    addJob(daemon, "a", "job-1");
    setJobState(daemon, "job-1", state);
    const sessionId = daemon.database.defaultSessionFor("project", "change");
    assert.equal(daemon.database.idleRoomIn(sessionId), "a");
  });
}

test("idleRoomIn returns the most recently updated of several eligible rooms", (context) => {
  const daemon = idleRoomFixture(context);
  // Both rooms are idle (no jobs at all): the tiebreak under test is recency, not liveness.
  daemon.database.createRoom("old", "Old", "project", "change", undefined, "2026-09-01T00:00:00.000Z");
  daemon.database.createRoom("new", "New", "project", "change", undefined, "2026-09-03T00:00:00.000Z");
  const sessionId = daemon.database.defaultSessionFor("project", "change");
  assert.equal(daemon.database.idleRoomIn(sessionId), "new");
});

// --- rooms.open: an RPC, so exercised through daemon.call against a real (fast-completing) provider fixture.
// A second, git-backed harness mirrors daemon.test.ts's own -- self-contained per this repo's convention
// (see charter.test.ts, session.test.ts), since a .test.ts file cannot import helpers from another one.

const providerFixture = new URL("./__fixtures__/provider.js", import.meta.url).pathname;

interface Harness {
  root: string;
  project: string;
  daemon: DovskyDaemon;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function harness(mode = "success"): Harness {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-room-open-test-"));
  const project = resolve(root, "project");
  spawnSync("mkdir", ["-p", project]);
  git(project, "init", "-q");
  git(project, "config", "user.email", "test@example.invalid");
  git(project, "config", "user.name", "Dovsky Test");
  writeFileSync(resolve(project, "tracked.txt"), "baseline\n");
  git(project, "add", "tracked.txt");
  git(project, "commit", "-qm", "baseline");
  const config: DaemonConfig = {
    socketPath: resolve(root, "run", "dovsky.sock"),
    databasePath: resolve(root, "state", "dovsky.db"),
    artifactDirectory: resolve(root, "artifacts"),
    maxActive: 3,
    projects: [
      {
        id: "test",
        name: "Test Project",
        path: project,
        workflows: [
          {
            id: "default", name: "Default", readOnly: false, qualityCommands: [],
            providers: { claude: { argv: [process.execPath, providerFixture, mode] }, codex: { argv: [process.execPath, providerFixture, mode] } },
          },
          // A second workflow so a session can be shown to belong to the "wrong" one.
          {
            id: "other", name: "Other", readOnly: false, qualityCommands: [],
            providers: { claude: { argv: [process.execPath, providerFixture, mode] }, codex: { argv: [process.execPath, providerFixture, mode] } },
          },
        ],
      },
    ],
  };
  return { root, project, daemon: new DovskyDaemon(config) };
}

async function cleanup(value: Harness): Promise<void> {
  await value.daemon.stop();
  value.daemon.close();
  removeFixtureTree(value.root);
}

async function waitForJob(daemon: DovskyDaemon, jobId: string, states: string[], timeout = 5_000): Promise<JobSummary> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const page = (await daemon.call("jobs.list", { limit: 100 })) as { items: JobSummary[] };
    const job = page.items.find((candidate) => candidate.id === jobId);
    if (job && states.includes(job.state)) return job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Timed out waiting for ${jobId} in ${states.join(",")}`);
}

function writeCharter(project: string, name: string, bus: string): void {
  mkdirSync(resolve(project, ".claude", "agents"), { recursive: true });
  writeFileSync(resolve(project, ".claude", "agents", `${name}.md`), `---\nname: ${name}\n${bus}---\nDo the work.\n`);
  git(project, "add", `.claude/agents/${name}.md`);
  git(project, "commit", "-qm", `charter ${name}`);
}

async function open(daemon: DovskyDaemon, params: Record<string, unknown> = {}): Promise<{ roomId: string; jobIds?: string[]; turnId?: string }> {
  return (await daemon.call(
    "rooms.open",
    { title: "Task", projectId: "test", workflowId: "default", prompt: "do the work", recipients: ["codex"], ...params },
    randomUUID(),
  )) as { roomId: string; jobIds?: string[]; turnId?: string };
}

test("with no sessionId, a second rooms.open call joins the room the first one opened", async () => {
  const value = harness("success");
  try {
    value.daemon.start();
    const first = await open(value.daemon);
    await waitForJob(value.daemon, first.jobIds![0]!, ["succeeded"]);
    const second = await open(value.daemon);
    assert.equal(second.roomId, first.roomId, "the second call must land in the same room, not a fresh one");
    const rooms = value.daemon.database.listRooms(50, null, "test");
    assert.equal(rooms.items.length, 1, "no second room should exist");
  } finally {
    await cleanup(value);
  }
});

test("when the session's only room has a running job, a second rooms.open call opens a new room", async () => {
  const value = harness("success");
  try {
    value.daemon.start();
    await value.daemon.call("daemon.drain", { enabled: true }, randomUUID());
    const first = await open(value.daemon);
    value.daemon.database.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(first.jobIds![0]!);
    const second = await open(value.daemon);
    assert.notEqual(second.roomId, first.roomId);
    const rooms = value.daemon.database.listRooms(50, null, "test");
    assert.equal(rooms.items.length, 2, "the busy room stays, and a second one opens beside it");
    assert.ok(rooms.items.some((room) => room.id === first.roomId));
    assert.ok(rooms.items.some((room) => room.id === second.roomId));
  } finally {
    await cleanup(value);
  }
});

test("with no recipients, the ladder case always opens a new room even when an idle room exists", async () => {
  const value = harness("success");
  writeCharter(value.project, "Argus", "bus:\n  allowed: [claude/quick, codex/hard]\n");
  try {
    value.daemon.start();
    const first = await open(value.daemon);
    await waitForJob(value.daemon, first.jobIds![0]!, ["succeeded"]);
    // The session's only room is now idle; the ladder path must still refuse to join it.
    const second = await open(value.daemon, { recipients: undefined, charter: "Argus" });
    assert.notEqual(second.roomId, first.roomId);
    const job = await waitForJob(value.daemon, second.jobIds![0]!, ["succeeded"]);
    assert.equal(job.provider, "claude", "the ladder, not the idle room's prior provider, picked the recipient");
  } finally {
    await cleanup(value);
  }
});

test("an explicit sessionId for an existing session of the same project and workflow is honoured", async () => {
  const value = harness("success");
  try {
    value.daemon.start();
    const created = (await value.daemon.call("sessions.create", { title: "Named", projectId: "test", workflowId: "default" }, randomUUID())) as { sessionId: string };
    const opened = await open(value.daemon, { sessionId: created.sessionId });
    assert.equal(value.daemon.database.getRoomRow(opened.roomId)?.session_id, created.sessionId);
  } finally {
    await cleanup(value);
  }
});

test("a sessionId belonging to a different project or workflow is rejected with INVALID_REQUEST", async () => {
  const value = harness("success");
  try {
    value.daemon.start();
    const created = (await value.daemon.call("sessions.create", { title: "Named", projectId: "test", workflowId: "default" }, randomUUID())) as { sessionId: string };
    await assert.rejects(
      open(value.daemon, { sessionId: created.sessionId, workflowId: "other" }),
      (error: unknown) => error instanceof DaemonError && error.code === "INVALID_REQUEST",
    );
  } finally {
    await cleanup(value);
  }
});

test("joining an idle room chains the new job to the room's prior job", async () => {
  const value = harness("success");
  try {
    value.daemon.start();
    const first = await open(value.daemon);
    await waitForJob(value.daemon, first.jobIds![0]!, ["succeeded"]);
    const second = await open(value.daemon);
    assert.equal(second.roomId, first.roomId);
    // Only createMessage (not createRoom) ever sets predecessorJobId, so this proves rooms.open actually
    // delegated to it rather than opening a fresh room that happens to share an id by coincidence.
    const job = value.daemon.database.getJob(second.jobIds![0]!);
    assert.equal(job?.predecessorJobId, first.jobIds![0]);
  } finally {
    await cleanup(value);
  }
});
