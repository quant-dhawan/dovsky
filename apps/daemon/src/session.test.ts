import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { DovskyDaemon } from "./daemon.js";

/**
 * A session is the container above rooms. It exists because one workflow was producing one room per
 * task -- 113 rooms for 151 tasks in the live database, 80 of them holding a single job -- which makes
 * the sidebar a flat list nobody can navigate. Grouping is the whole feature, so the load-bearing
 * property is that rooms sharing a (project, workflow) land in ONE session unless told otherwise.
 */
function fixture(context: TestContext): DovskyDaemon {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-session-"));
  const daemon = new DovskyDaemon({
    socketPath: resolve(root, "run", "bus.sock"), databasePath: resolve(root, "state", "bus.db"),
    artifactDirectory: resolve(root, "artifacts"),
    maxActive: 1,
    projects: [{ id: "project", name: "Fixture", path: root, workflows: [
      { id: "change", name: "Change", readOnly: false, qualityCommands: [], providers: { codex: { argv: [process.execPath] } } },
      { id: "review", name: "Review", readOnly: true, qualityCommands: [], providers: { codex: { argv: [process.execPath] } } },
    ] }],
  });
  context.after(async () => { await daemon.stop(); daemon.close(); rmSync(root, { recursive: true, force: true }); });
  return daemon;
}

test("rooms on one workflow share a session instead of each opening their own", (context) => {
  const daemon = fixture(context);
  daemon.database.createRoom("a", "First", "project", "change");
  daemon.database.createRoom("b", "Second", "project", "change");
  daemon.database.createRoom("c", "Other workflow", "project", "review");

  const sessions = daemon.database.listSessions();
  assert.equal(sessions.length, 2, "one session per (project, workflow), not one per room");
  const change = sessions.find((session) => session.workflowId === "change")!;
  assert.equal(change.roomCount, 2);
  assert.equal(daemon.database.roomSummary(daemon.database.db.prepare("SELECT * FROM rooms WHERE id='a'").get()!).sessionId, change.id);
  assert.equal(daemon.database.roomSummary(daemon.database.db.prepare("SELECT * FROM rooms WHERE id='b'").get()!).sessionId, change.id);
  assert.notEqual(daemon.database.roomSummary(daemon.database.db.prepare("SELECT * FROM rooms WHERE id='c'").get()!).sessionId, change.id);
});

test("a room can be placed in a named session, and a session from another workflow is refused", async (context) => {
  const daemon = fixture(context);
  // Drained: this test is about where rooms land, and nothing here needs a provider to run.
  await daemon.call("daemon.drain", { enabled: true }, randomUUID());
  const created = await daemon.call("sessions.create", { title: "Ladder work", projectId: "project", workflowId: "change" }, randomUUID()) as { sessionId: string };
  assert.ok(created.sessionId);

  daemon.database.createRoom("a", "First", "project", "change", created.sessionId);
  assert.equal(daemon.database.roomSummary(daemon.database.db.prepare("SELECT * FROM rooms WHERE id='a'").get()!).sessionId, created.sessionId);
  // A named session must not swallow the rooms that did not ask for it: the next unplaced room on the
  // same workflow opens the default session beside it rather than joining the named one.
  daemon.database.createRoom("b", "Unplaced", "project", "change");
  const change = daemon.database.listSessions().filter((session) => session.workflowId === "change");
  assert.equal(change.length, 2);
  assert.notEqual(daemon.database.roomSummary(daemon.database.db.prepare("SELECT * FROM rooms WHERE id='b'").get()!).sessionId, created.sessionId);

  await assert.rejects(
    daemon.call("rooms.create", { title: "x", projectId: "project", workflowId: "review", prompt: "x", recipients: ["codex"], sessionId: created.sessionId }, randomUUID()),
    /session/i,
    "a session belongs to one workflow; a room may not cross that boundary",
  );
  await assert.rejects(
    daemon.call("rooms.create", { title: "x", projectId: "project", workflowId: "change", prompt: "x", recipients: ["codex"], sessionId: "no-such-session" }, randomUUID()),
    /session/i,
  );
});

test("archiving a room removes it from the default listing without deleting anything", (context) => {
  const daemon = fixture(context);
  daemon.database.createRoom("a", "Kept", "project", "change");
  daemon.database.createRoom("b", "Archived", "project", "change");
  daemon.database.setRoomArchived("b", true);

  assert.deepEqual(daemon.database.listRooms(50, null).items.map((room) => room.id), ["a"]);
  assert.deepEqual(daemon.database.listRooms(50, null, undefined, undefined, undefined, undefined, undefined, true).items.map((room) => room.id).sort(), ["a", "b"]);
  assert.equal(daemon.database.listSessions()[0]!.roomCount, 2, "the room still exists");
  assert.equal(daemon.database.listSessions()[0]!.activeRoomCount, 1, "but it no longer counts as active");

  daemon.database.setRoomArchived("b", false);
  assert.deepEqual(daemon.database.listRooms(50, null).items.map((room) => room.id).sort(), ["a", "b"]);
});

test("pinning is a flag the client groups by, and never reorders the paginated listing", (context) => {
  const daemon = fixture(context);
  // Distinct timestamps so the page order is the ordinary newest-first one and a reorder would be visible.
  daemon.database.createRoom("old", "Old", "project", "change", undefined, "2026-09-01T00:00:00.000Z");
  daemon.database.createRoom("new", "New", "project", "change", undefined, "2026-09-02T00:00:00.000Z");
  daemon.database.setRoomPinned("old", true);

  const page = daemon.database.listRooms(50, null);
  assert.deepEqual(page.items.map((room) => room.id), ["new", "old"], "pinning must not reorder: the cursor encodes only (updatedAt, id)");
  assert.equal(page.items.find((room) => room.id === "old")!.pinned, true);
  assert.equal(page.items.find((room) => room.id === "new")!.pinned, false);
});

test("sessions can be listed for one project and report their newest room activity", (context) => {
  const daemon = fixture(context);
  daemon.database.createRoom("a", "First", "project", "change", undefined, "2026-09-01T00:00:00.000Z");
  daemon.database.createRoom("b", "Second", "project", "change", undefined, "2026-09-03T00:00:00.000Z");
  const [session] = daemon.database.listSessions("project");
  assert.equal(session!.workflowId, "change");
  assert.equal(session!.lastActivityAt, "2026-09-03T00:00:00.000Z");
  assert.deepEqual(daemon.database.listSessions("other-project"), []);
});
