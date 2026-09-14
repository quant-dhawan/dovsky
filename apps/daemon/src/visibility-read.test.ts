import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ContentChunk, EventEnvelope, RoomSnapshot } from "@dovsky/protocol";
import { DovskyDaemon } from "./daemon.js";

test("daemon dispatch preserves bounded large-room, Unicode, binary and oversized-event reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "dovsky-visible-read-"));
  const artifacts = join(root, "artifacts");
  const daemon = new DovskyDaemon({ socketPath: join(root, "run", "bus.sock"), databasePath: join(root, "state", "bus.db"),
    artifactDirectory: artifacts, maxActive: 1, projects: [] });
  try {
    // Exercise dispatch without starting a scheduler or a provider.
    daemon.database.createRoom("room", "Long history", "project", "workflow");
    daemon.database.createRoom("other", "Other", "project", "workflow");
    daemon.database.createJob({ id: "job", roomId: "room", provider: "codex", projectId: "project", workflowId: "workflow", prompt: "test" }, "prompt");
    const body = "漢字🙂".repeat(9000);
    const insert = daemon.database.db.prepare("INSERT INTO turns(id,job_id,room_id,author,recipient,body,created_at,status,role) VALUES(?,'job','room','codex','human',?,'2026-09-09','complete','work')");
    for (let i = 0; i < 60; i++) insert.run(`turn-${i}`, body);
    const binary = Buffer.from([0, 255, 128, 1, 254]);
    const file = join(artifacts, "bytes.bin");
    writeFileSync(file, binary);
    daemon.database.addArtifact("bytes", "job", "evidence", "bytes.bin", "application/octet-stream", binary.length, file);
    const largeEvent = daemon.database.insertEvent("room", "job", "evaluation.report", { detail: "x".repeat(300000) });
    await assert.rejects(daemon.call("rooms.get", { roomId: "room" }), /rooms.snapshot/);
    const ids = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await daemon.call("rooms.snapshot", { roomId: "room", limit: 7, ...(cursor ? { cursor } : {}) }) as RoomSnapshot;
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
      assert.ok(page.eventCursor >= largeEvent);
      assert.ok(page.turns.length <= 7);
      for (const turn of page.turns) {
        assert.equal(ids.has(turn.id), false);
        ids.add(turn.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(ids.size, 61);
    const evidence = await daemon.call("jobs.evidence", { roomId: "room", jobId: "job" }) as RoomSnapshot;
    assert.deepEqual(evidence.jobs.map((job) => job.id), ["job"]);
    const pieces: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const chunk = await daemon.call("turns.read", { roomId: "room", turnId: "turn-0", offset, limit: 65535 }) as ContentChunk;
      pieces.push(Buffer.from(chunk.data, "base64"));
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
    assert.equal(Buffer.concat(pieces).toString("utf8"), body);
    const artifact = await daemon.call("artifacts.read", { roomId: "room", artifactId: "bytes" }) as ContentChunk;
    assert.deepEqual(Buffer.from(artifact.data, "base64"), binary);
    await assert.rejects(daemon.call("artifacts.read", { roomId: "other", artifactId: "bytes" }), /not found/i);
    const events = await daemon.call("events.page", { roomId: "room", afterId: largeEvent - 1 }) as EventEnvelope[];
    assert.equal(events[0]?.id, largeEvent);
    assert.equal(events[0]?.type, "room.refresh_required");
    assert.deepEqual(events[0]?.data, { originalType: "evaluation.report" });
    assert.ok(Buffer.byteLength(JSON.stringify(events)) < 1024 * 1024);
    await assert.rejects(daemon.call("console.files", {}), /Unknown RPC method/);
    await assert.rejects(daemon.call("memory.write", {}), /Unknown RPC method/);
  } finally {
    await daemon.stop();
    daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});
