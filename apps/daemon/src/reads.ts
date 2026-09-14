import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import type { ContentChunk, EvaluationView, EventEnvelope, RoomDetail, RoomSnapshot, TaskView } from "@dovsky/protocol";
import type { DovskyDatabase } from "./database.js";
import { DaemonError } from "./config.js";
import { sanitizeStoredText } from "./sanitize.js";

const PAGE_BYTES = 1024 * 1024;
const LEGACY_BYTES = 2 * 1024 * 1024 - 1024;
const CONTENT_BYTES = 64 * 1024;
const collections = ["tasks", "jobs", "turns", "attempts", "checks", "changes", "artifacts"] as const;
type Collection = typeof collections[number];
type Row = Record<string, unknown>;
type Position = Record<Collection, number>;
interface SnapshotCursor {
  position: Position;
  priorityTasks: number[] | null;
  priorityTaskOffset: number;
  priorityJobs: number[] | null;
  priorityOffset: number;
}

function id(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value || value.length > 128) throw new DaemonError("INVALID_REQUEST", `${key} is required`);
  return value;
}

function integer(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) throw new DaemonError("INVALID_REQUEST", "Invalid read offset or limit");
  return Number(value);
}

function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function positions(value: unknown, roomId: string, jobId: string | null): SnapshotCursor {
  if (value === undefined) return {
    position: Object.fromEntries(collections.map((key) => [key, Number.MAX_SAFE_INTEGER])) as Position,
    priorityTasks: null,
    priorityTaskOffset: 0,
    priorityJobs: null,
    priorityOffset: 0,
  };
  try {
    if (typeof value !== "string" || value.length > 4096) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (cursor.version !== 2 || cursor.roomId !== roomId || cursor.jobId !== jobId) throw new Error();
    for (const key of collections) integer(cursor.position[key], -1, Number.MAX_SAFE_INTEGER);
    if (collections.some((key) => cursor.position[key] === undefined)) throw new Error();
    for (const values of [cursor.priorityTasks, cursor.priorityJobs]) {
      if (!Array.isArray(values) || values.length > 50
        || values.some((row: unknown) => !Number.isSafeInteger(row) || Number(row) <= 0)
        || new Set(values).size !== values.length) throw new Error();
    }
    const priorityTaskOffset = integer(cursor.priorityTaskOffset, -1, cursor.priorityTasks.length);
    const priorityOffset = integer(cursor.priorityOffset, -1, cursor.priorityJobs.length);
    if (priorityTaskOffset < 0 || priorityOffset < 0) throw new Error();
    return {
      position: cursor.position as Position,
      priorityTasks: cursor.priorityTasks as number[],
      priorityTaskOffset,
      priorityJobs: cursor.priorityJobs as number[],
      priorityOffset,
    };
  } catch { throw new DaemonError("INVALID_CURSOR", "Cursor does not belong to this room and job"); }
}

function evaluationPreview(view: EvaluationView | null | undefined): EvaluationView | null {
  if (!view?.report) return view ?? null;
  const shorten = (text: string): string => text.length > 512 ? `${text.slice(0, 512)}…` : text;
  return { ...view, report: { ...view.report,
    candidate: view.report.candidate.map((scenario) => ({ ...scenario, detail: shorten(scenario.detail) })),
    baseline: view.report.baseline?.map((scenario) => ({ ...scenario, detail: shorten(scenario.detail) })) ?? null,
  } };
}

// This is the paginated `rooms.snapshot`/`jobs.evidence` counterpart to `CoordinationStore.getTask` in
// coordination.ts: a second, independent place a `tasks` row (and a `checks` row) becomes a client-facing
// view. Both call the shared `sanitizeStoredText` on the same fields so a row written before that sanitizer
// existed still renders clean here too, without rewriting the row itself.
function mapped(database: DovskyDatabase, collection: Collection, row: Row): unknown {
  switch (collection) {
    case "tasks": return {
      id: String(row.id), roomId: String(row.room_id), provider: row.provider as TaskView["provider"],
      latestJobId: String(row.latest_job_id), state: row.state as TaskView["state"], phase: sanitizeStoredText(String(row.phase)),
      blocker: sanitizeStoredText(row.blocker as string | null), nextAction: sanitizeStoredText(row.next_action as string | null),
      workdir: row.workdir as string | null, revision: Number(row.revision),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    } satisfies TaskView;
    case "jobs": {
      const job = database.getJobSummary(String(row.id));
      return { ...job, evaluation: evaluationPreview(job.evaluation) };
    }
    case "turns": return {
      id: row.id, jobId: row.job_id, roomId: row.room_id, author: row.author, recipient: row.recipient,
      body: row.body, bodyTruncated: Number(row.body_length) > 4096, createdAt: row.created_at,
      status: row.status, model: row.model, effort: row.effort, role: row.role,
      // The same immutable row id cursor traversal already orders by, surfaced so a
      // client can page a transcript by a stable key. `createdAt` cannot do this job:
      // it is not unique, and a browser paging backwards needs a total order.
      seq: Number(row.position),
    };
    case "attempts": return {
      id: row.id, jobId: String(row.job_id), turnId: row.turn_id, number: row.number, state: row.state,
      startedAt: row.started_at, finishedAt: row.finished_at, failure: parse(row.failure_json, null),
      hadToolActivity: row.had_tool_activity === null ? null : Number(row.had_tool_activity) === 1,
      worktreeFingerprint: row.worktree_fingerprint, argv: parse(row.argv_json, null),
    };
    case "checks": return {
      id: row.id, jobId: String(row.job_id), command: parse(row.command_json, []), state: row.state,
      exitCode: row.exit_code, summary: sanitizeStoredText(row.summary as string | null),
    };
    case "changes": return { jobId: String(row.job_id), path: row.path, status: row.status, additions: row.additions, deletions: row.deletions };
    case "artifacts": return { id: row.id, jobId: String(row.job_id), kind: row.kind, name: row.name, mediaType: row.media_type, size: row.size };
  }
}

export function roomSnapshot(database: DovskyDatabase, params: Record<string, unknown>, selected = false): RoomSnapshot {
  const roomId = id(params, "roomId");
  const jobId = selected ? id(params, "jobId") : null;
  const limit = integer(params.limit, 50, 100);
  if (!limit) throw new DaemonError("INVALID_REQUEST", "Read limit must be positive");
  const cursor = positions(params.cursor, roomId, jobId);
  const position = cursor.position;
  return database.transaction(() => {
    const room = database.getRoomRow(roomId);
    if (!room) throw new DaemonError("NOT_FOUND", "Room not found");
    if (jobId && database.getJobSummary(jobId).roomId !== roomId) throw new DaemonError("NOT_FOUND", "Job not found in this room");
    if (cursor.priorityJobs === null) {
      const scope = jobId ? "AND id=?" : "";
      const scopeParams = jobId ? [roomId, jobId] : [roomId];
      const maximum = Number(database.db.prepare(`SELECT coalesce(max(rowid),0) AS position FROM jobs WHERE room_id=? ${scope}`).get(...scopeParams)!.position);
      if (!Number.isSafeInteger(maximum) || maximum >= Number.MAX_SAFE_INTEGER) throw new DaemonError("RESPONSE_TOO_LARGE", "Job history exceeds the safe cursor range");
      position.jobs = maximum ? maximum + 1 : 0;
      cursor.priorityJobs = (database.db.prepare(`SELECT rowid AS position FROM jobs WHERE room_id=? ${scope}
        AND state IN ('queued','starting','running','cancel_requested') ORDER BY rowid DESC LIMIT 50`).all(...scopeParams) as Row[])
        .map((row) => Number(row.position));
      if (jobId) {
        position.tasks = 0;
        cursor.priorityTasks = [];
      } else {
        const maximumTask = Number(database.db.prepare("SELECT coalesce(max(rowid),0) AS position FROM tasks WHERE room_id=?").get(roomId)!.position);
        if (!Number.isSafeInteger(maximumTask) || maximumTask >= Number.MAX_SAFE_INTEGER) throw new DaemonError("RESPONSE_TOO_LARGE", "Task history exceeds the safe cursor range");
        position.tasks = maximumTask ? maximumTask + 1 : 0;
        cursor.priorityTasks = (database.db.prepare(`SELECT rowid AS position FROM tasks WHERE room_id=?
          AND state IN ('working','checkpointed','awaiting_decision','blocked') ORDER BY rowid DESC LIMIT 50`).all(roomId) as Row[])
          .map((row) => Number(row.position));
      }
    }
    const summary = database.roomSummary(room);
    const { tasks: _summaryTasks, ...boundedSummary } = summary;
    const snapshot: RoomSnapshot = {
      // Scenario reports belong to selected jobs; duplicating a maximum-sized report in
      // the room summary can prevent even a single job from fitting its evidence page.
      room: { ...boundedSummary, evaluation: summary.evaluation ? { ...summary.evaluation, report: null } : null },
      tasks: [], jobs: [], turns: [], attempts: [], checks: [], changes: [], artifacts: [],
      eventCursor: Number(database.db.prepare("SELECT coalesce(max(id),0) AS id FROM events").get()!.id), nextCursor: null,
    };
    let bytes = Buffer.byteLength(JSON.stringify(snapshot)) + 32768;
    if (bytes > PAGE_BYTES) throw new DaemonError("RESPONSE_TOO_LARGE", "Room metadata exceeds the bounded read limit");
    const fetchedChangePositions = new Map<string, Set<number>>();
    for (const collection of collections) {
      if (!position[collection]) continue;
      if (collection === "tasks") {
        const items: Array<{ item: TaskView; position: number }> = [];
        const add = (row: Row): boolean => {
          const item = mapped(database, collection, row) as TaskView;
          const size = Buffer.byteLength(JSON.stringify(item)) + 1;
          if (size > PAGE_BYTES - 2048) throw new DaemonError("RESPONSE_TOO_LARGE", "A tasks record exceeds the read limit");
          if (bytes + size > PAGE_BYTES) return false;
          items.push({ item, position: Number(row.position) });
          bytes += size;
          return true;
        };
        while (cursor.priorityTaskOffset < cursor.priorityTasks!.length && items.length < limit) {
          const priority = cursor.priorityTasks![cursor.priorityTaskOffset]!;
          const row = database.db.prepare("SELECT rowid AS position,* FROM tasks WHERE room_id=? AND rowid=?").get(roomId, priority) as Row | undefined;
          if (row && !add(row)) break;
          cursor.priorityTaskOffset += 1;
        }
        if (cursor.priorityTaskOffset === cursor.priorityTasks!.length && items.length < limit) {
          const exclusions = cursor.priorityTasks!.length ? `AND rowid NOT IN (${cursor.priorityTasks!.map(() => "?").join(",")})` : "";
          const rows = database.db.prepare(`SELECT rowid AS position,* FROM tasks WHERE room_id=? AND rowid<?
            ${exclusions} ORDER BY rowid DESC LIMIT ?`)
            .all(roomId, position.tasks, ...cursor.priorityTasks!, limit - items.length + 1) as Row[];
          let consumed = 0;
          for (const row of rows.slice(0, limit - items.length)) {
            if (!add(row)) break;
            consumed += 1;
            position.tasks = Number(row.position);
          }
          if (consumed === rows.length) position.tasks = 0;
        }
        snapshot.tasks = items.sort((left, right) => left.position - right.position).map(({ item }) => item);
        continue;
      }
      if (collection === "jobs") {
        const items: Array<{ item: unknown; position: number }> = [];
        const add = (row: Row): boolean => {
          const item = mapped(database, collection, row);
          const size = Buffer.byteLength(JSON.stringify(item)) + 1;
          if (size > PAGE_BYTES - 2048) throw new DaemonError("RESPONSE_TOO_LARGE", "A jobs record exceeds the read limit; inspect its registered evidence artifact");
          if (bytes + size > PAGE_BYTES) return false;
          items.push({ item, position: Number(row.position) });
          bytes += size;
          return true;
        };
        while (cursor.priorityOffset < cursor.priorityJobs!.length && items.length < limit) {
          const priority = cursor.priorityJobs![cursor.priorityOffset]!;
          const row = database.db.prepare(`SELECT rowid AS position,id FROM jobs WHERE room_id=? AND rowid=? ${jobId ? "AND id=?" : ""}`)
            .get(...(jobId ? [roomId, priority, jobId] : [roomId, priority])) as Row | undefined;
          if (row && !add(row)) break;
          cursor.priorityOffset += 1;
        }
        if (cursor.priorityOffset === cursor.priorityJobs!.length && items.length < limit) {
          const exclusions = cursor.priorityJobs!.length ? `AND rowid NOT IN (${cursor.priorityJobs!.map(() => "?").join(",")})` : "";
          const rows = database.db.prepare(`SELECT rowid AS position,id FROM jobs WHERE room_id=? AND rowid<?
            ${jobId ? "AND id=?" : ""} ${exclusions} ORDER BY rowid DESC LIMIT ?`)
            .all(...(jobId
              ? [roomId, position.jobs, jobId, ...cursor.priorityJobs!, limit - items.length + 1]
              : [roomId, position.jobs, ...cursor.priorityJobs!, limit - items.length + 1])) as Row[];
          let consumed = 0;
          for (const row of rows.slice(0, limit - items.length)) {
            if (!add(row)) break;
            consumed += 1;
            position.jobs = Number(row.position);
          }
          if (consumed === rows.length) position.jobs = 0;
        }
        snapshot.jobs = items.sort((left, right) => left.position - right.position).map(({ item }) => item) as RoomSnapshot["jobs"];
        continue;
      }
      const direct = collection === "turns";
      // Column names come only from the fixed collection enum above. Large turn bodies stay in SQLite.
      const columns = collection === "turns"
        ? "t.id,t.job_id,t.room_id,t.author,t.recipient,substr(t.body,1,4096) AS body,length(t.body) AS body_length,t.created_at,t.status,t.model,t.effort,t.role"
        : collection === "checks"
          ? "t.id,t.job_id,t.command_json,t.state,t.exit_code,substr(t.summary,1,4096) AS summary"
          : "t.*";
      const rows = database.db.prepare(`SELECT t.rowid AS position,${columns} FROM ${collection} t
        ${direct ? "" : "JOIN jobs j ON j.id=t.job_id"}
        WHERE ${direct ? "t" : "j"}.room_id=? AND t.rowid<?
        ${jobId ? "AND t.job_id=?" : ""}
        ORDER BY t.rowid DESC LIMIT ?`).all(...(jobId ? [roomId, position[collection], jobId, limit + 1] : [roomId, position[collection], limit + 1])) as Row[];
      const items: unknown[] = [];
      for (const row of rows.slice(0, limit)) {
        const item = mapped(database, collection, row);
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (size > PAGE_BYTES - 2048) throw new DaemonError("RESPONSE_TOO_LARGE", `A ${collection} record exceeds the read limit; inspect its registered evidence artifact`);
        if (bytes + size > PAGE_BYTES) break;
        items.push(item);
        if (collection === "changes") {
          const owner = String(row.job_id);
          const positions = fetchedChangePositions.get(owner) ?? new Set<number>();
          positions.add(Number(row.position));
          fetchedChangePositions.set(owner, positions);
        }
        bytes += size;
        position[collection] = Number(row.position);
      }
      if (items.length === rows.length) position[collection] = 0;
      // Chronological lists match the legacy UI. Cursor traversal itself uses immutable row IDs.
      Object.assign(snapshot, { [collection]: items.reverse() });
    }
    if (collections.some((key) => position[key] > 0)) {
      snapshot.nextCursor = Buffer.from(JSON.stringify({ version: 2, roomId, jobId, position,
        priorityTasks: cursor.priorityTasks, priorityTaskOffset: cursor.priorityTaskOffset,
        priorityJobs: cursor.priorityJobs, priorityOffset: cursor.priorityOffset })).toString("base64url");
    }
    snapshot.completeChangesFor = [...new Set([...snapshot.jobs.map((job) => job.id), ...snapshot.changes.map((change) => change.jobId!)])]
      .filter((owner) => Number(database.db.prepare("SELECT count(*) AS total FROM changes WHERE job_id=?").get(owner)!.total)
        === snapshot.changes.filter((change) => change.jobId === owner).length);
    snapshot.resetChangesFor = [...fetchedChangePositions]
      .filter(([owner, positions]) => positions.has(Number(database.db.prepare("SELECT max(rowid) AS position FROM changes WHERE job_id=?").get(owner)!.position)))
      .map(([owner]) => owner);
    if (snapshot.nextCursor && collections.every((key) => (snapshot[key]?.length ?? 0) === 0)) {
      throw new DaemonError("RESPONSE_TOO_LARGE", "Evidence metadata cannot fit a page; inspect its registered artifact");
    }
    return snapshot;
  });
}

function content(database: DovskyDatabase, artifactDirectory: string, params: Record<string, unknown>, artifact: boolean): ContentChunk {
  const roomId = id(params, "roomId");
  const contentId = id(params, artifact ? "artifactId" : "turnId");
  const offset = integer(params.offset, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(params.limit, CONTENT_BYTES, CONTENT_BYTES);
  if (!limit) throw new DaemonError("INVALID_REQUEST", "Read limit must be positive");
  let bytes: Buffer;
  let totalBytes: number;
  let mediaType = "text/plain; charset=utf-8";
  let name: string | undefined;
  if (!artifact) {
    const row = database.db.prepare("SELECT length(CAST(body AS BLOB)) AS size,substr(CAST(body AS BLOB),?,?) AS chunk FROM turns WHERE id=? AND room_id=?")
      .get(offset + 1, limit, contentId, roomId) as Row | undefined;
    if (!row) throw new DaemonError("NOT_FOUND", "Turn not found in this room");
    totalBytes = Number(row.size);
    bytes = Buffer.from(row.chunk as Uint8Array);
  } else {
    const row = database.db.prepare("SELECT a.path,a.media_type,a.name FROM artifacts a JOIN jobs j ON j.id=a.job_id WHERE a.id=? AND j.room_id=?")
      .get(contentId, roomId) as Row | undefined;
    if (!row) throw new DaemonError("NOT_FOUND", "Artifact not found in this room");
    let fd: number | undefined;
    try {
      const path = realpathSync(String(row.path));
      const within = relative(realpathSync(artifactDirectory), path);
      if (!within || within === ".." || within.startsWith("../") || isAbsolute(within)) throw new DaemonError("FORBIDDEN", "Artifact is outside registered storage");
      fd = openSync(path, "r");
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new DaemonError("NOT_FOUND", "Artifact is not a regular file");
      totalBytes = stat.size;
      bytes = Buffer.alloc(Math.min(limit, Math.max(0, totalBytes - offset)));
      bytes = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, offset));
      mediaType = String(row.media_type);
      name = String(row.name);
    } catch (error) {
      if (error instanceof DaemonError) throw error;
      throw new DaemonError("NOT_FOUND", "Artifact content is unavailable");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  if (offset > totalBytes) throw new DaemonError("INVALID_REQUEST", "Offset is beyond the content length");
  return { id: contentId, offset, nextOffset: offset + bytes.length < totalBytes ? offset + bytes.length : null,
    totalBytes, encoding: "base64", data: bytes.toString("base64"), mediaType, ...(name ? { name } : {}) };
}

export function readView(database: DovskyDatabase, artifactDirectory: string, method: string, params: Record<string, unknown>): unknown {
  if (method === "rooms.snapshot" || method === "jobs.evidence") return roomSnapshot(database, params, method === "jobs.evidence");
  if (method === "events.page") {
    const roomId = id(params, "roomId");
    const afterId = integer(params.afterId, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(params.limit, 100, 100);
    if (!limit) throw new DaemonError("INVALID_REQUEST", "Read limit must be positive");
    const rows = database.db.prepare("SELECT id,room_id,job_id,type,occurred_at,length(CAST(data_json AS BLOB)) AS size FROM events WHERE room_id=? AND id>? ORDER BY id LIMIT ?")
      .all(roomId, afterId, limit) as Row[];
    const events: EventEnvelope[] = [];
    let bytes = 2;
    for (const row of rows) {
      const oversized = Number(row.size) > 256 * 1024;
      const event: EventEnvelope = {
        id: Number(row.id), roomId, jobId: row.job_id === null ? null : String(row.job_id), occurredAt: String(row.occurred_at),
        type: oversized ? "room.refresh_required" : String(row.type),
        data: oversized ? { originalType: row.type } : parse(database.db.prepare("SELECT data_json FROM events WHERE id=?").get(Number(row.id))!.data_json, null),
      };
      const size = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (bytes + size > PAGE_BYTES - 2048) break;
      bytes += size;
      events.push(event);
    }
    return events;
  }
  return content(database, artifactDirectory, params, method === "artifacts.read");
}

export function legacyRoom(database: DovskyDatabase, roomId: string): RoomDetail {
  const detail = database.getRoom(roomId);
  if (Buffer.byteLength(JSON.stringify(detail)) > LEGACY_BYTES) {
    throw new DaemonError("RESPONSE_TOO_LARGE", "Room exceeds the legacy read limit; use rooms.snapshot or GET /api/v1/rooms/:roomId/snapshot and paged content reads");
  }
  return detail;
}
