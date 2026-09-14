import { createHash, randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants as fsConstants, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { readRegularFile } from "./file-state.js";
import { DatabaseSync } from "node:sqlite";
import {
  TERMINAL_JOB_STATES,
  isForegroundExecution,
  canTransition,
  evaluationNeedsAttention,
  type ArtifactView,
  type AttemptView,
  type ChangeView,
  type CheckView,
  type Effort,
  type EventEnvelope,
  type FailureCause,
  type FailureInfo,
  type Grade,
  type GradeSource,
  type JobRole,
  type JobState,
  type JobProgress,
  type JobSummary,
  type JobUsageSummary,
  type QueueWaitStats,
  type QuotaWindowReading,
  type Page,
  PULL_REQUEST_STATES,
  type PullRequestState,
  type PullRequestView,
  type ProvisionalResultV1,
  type Provider,
  type ReviewView,
  type RoomDetail,
  type RoomReviewState,
  type RoomSummary,
  type RoutingObservation,
  type RoutingPolicyView,
  type SessionSummary,
  type Tier,
  type TurnView,
  type Verdict,
  type BanditConfig,
  type RoutingArm,
  type EvaluationReport,
  type EvaluationView,
  type RolloutGroupView,
  type RolloutCandidateView,
} from "@dovsky/protocol";
import { DaemonError } from "./config.js";
import { reward, updateArm } from './bandit.js';
import {
  DEFAULT_TIER,
  DEMOTE_GOOD_PROBES,
  DEMOTE_MIN_OBSERVATIONS,
  PROMOTE_PAIRS,
  failureCause,
  nextTier,
  previousTier,
  routingKey,
} from "./routing.js";
import type { EvaluationSpec, JobGates, JobSpec, LegacySnapshot, ReviewSpec, StoredJob, TokenUsage } from "./model.js";
import { evaluationView } from "./evaluation.js";
import { COORDINATION_SCHEMA_SQL, CoordinationStore, taskNeedsHuman, parseTaskResult } from "./coordination.js";
import { RELEASE_SCHEMA_SQL } from "./releases.js";
import { inspectProcessGroup, type ProcessIdentity, type ProcessObservation } from "./execution-lease.js";
import { sanitizeStoredText } from "./sanitize.js";
import { migrateFoundation, SCHEMA_VERSION, type MigrationHooks } from "./schema-migrations.js";
import { quotaCurrent, quotaReading, quotaWindows } from './quota-state.js';
import type { ExecutionEnrollment } from './isolation.js';
import { observeScope, signalScope } from './execution-scope.js';
import { applicationPending, applicationRecord, type CanonicalApplication } from './application-state.js';

export interface JobUsage {
  jobId: string;
  provider: Provider;
  state: JobState;
  model: string | null;
  effort: string | null;
  attempts: number;
  measuredAttempts: number;
  unmeasuredAttempts: number;
  usageComplete: boolean;
  durationMs: number | null;
  queueWaitMs: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  /** input - cached, clamped at 0, summed only over measuredAttempts; null when this job has none. */
  uncachedInputTokens: number | null;
  outputTokens: number | null;
}

export interface UsageTotals {
  jobs: number;
  attempts: number;
  measuredAttempts: number;
  unmeasuredAttempts: number;
  usageComplete: boolean;
  durationMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** Sum of each job's uncachedInputTokens; covers only measuredAttempts of attempts, same as cachedInputTokens. */
  uncachedInputTokens: number;
  outputTokens: number;
}

type Row = Record<string, unknown>;

export interface StoredRolloutGroup extends RolloutGroupView {
  round: number;
  requested: number;
  reviewsBudget: number;
  reviewsSpent: number;
  startCommit: string;
  baselinePath: string;
}

function queueWaitMs(row: Row): number | null {
  if (typeof row.created_at !== "string" || typeof row.started_at !== "string") return null;
  const elapsed = Date.parse(row.started_at) - Date.parse(row.created_at);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function summarizeQueueWait(values: Array<number | null>): QueueWaitStats {
  const samples = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const rank = (percentile: number): number | null => samples[Math.ceil(percentile * samples.length) - 1] ?? null;
  return { p50: rank(0.5), p95: rank(0.95), max: samples.at(-1) ?? null, samples: samples.length };
}
const MAX_QUEUED_PER_ROOM = 20;
const OPERATION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export type ExecutionLeaseState = "prepared" | "running" | "reconcile_required" | "exited";

export interface ExecutionLeaseView {
  scopeUnit: string | null;
  cgroupPath: string | null;
  /** Retained even before an actual gate identity is known. */
  bootId: string | null;
  id: string;
  jobId: string;
  attemptId: string | null;
  kind: string;
  number: number;
  state: ExecutionLeaseState;
  identity: ProcessIdentity | null;
  revision: number;
  preparedAt: string;
  enrolledAt: string | null;
  exitedAt: string | null;
  observation: ProcessObservation | null;
}

function isoNow(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function text(row: Row, name: string): string {
  return String(row[name]);
}

function nullableText(row: Row, name: string): string | null {
  const value = row[name];
  return value === null || value === undefined ? null : String(value);
}

function number(row: Row, name: string): number {
  return Number(row[name]);
}

function leaseIdentity(row: Row): ProcessIdentity | null {
  const pid = row.pid;
  const processGroup = row.process_group;
  const startTicks = nullableText(row, "process_start_ticks");
  const bootId = nullableText(row, "boot_id");
  return typeof pid === "number" && typeof processGroup === "number" && startTicks && bootId
    ? { pid, processGroup, startTicks, bootId }
    : null;
}

function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(JSON.stringify([timestamp, id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null): [string | null, string | null] {
  if (!cursor) return [null, null];
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(value) || value.length !== 2 || value.some((part) => typeof part !== "string")) throw new Error();
    return [value[0] as string, value[1] as string];
  } catch {
    throw new DaemonError("INVALID_CURSOR", "Pagination cursor is invalid");
  }
}

export interface NewJob extends Partial<JobSpec> {
  /** none bypasses both inheritance and task creation, even with parent lineage. */
  taskLink?: 'inherit' | 'none';
  executionKind?: StoredJob['executionKind'];
  armSource?: StoredJob['armSource'];
  resolvedModel?: string | null;
  requestedModel?: string | null;
  modelIdentity?: StoredJob['modelIdentity'];
  rolloutGroupId?: string | null;
  promotionOf?: string | null;
  reviewRetryOf?: string | null;
  taskId?: string | null;
  predecessorJobId?: string | null;
  predecessorPending?: boolean;
  id: string;
  roomId: string;
  provider: Provider;
  projectId: string;
  workflowId: string;
  prompt: string;
  displayPrompt?: string;
  retryOfJobId?: string | null;
  sourceJobId?: string | null;
  escalatedFrom?: string | null;
  resumeThreadId?: string | null;
  createdAt?: string;
  depth?: number;
  role?: JobRole;
  reviewOf?: string | null;
  reviewRound?: number | null;
  reviewCommit?: string | null;
  evidenceComplete?: boolean | null;
  parentJobId?: string | null;
  parentFingerprint?: string | null;
}

export interface OperationReservation {
  principal: string;
  key: string;
  method: string;
  requestHash: string;
  operationId: string;
}

export interface PullRequestReservationInput {
  jobId: string;
  roomId: string;
  repository: string;
  remote: string;
  baseBranch: string;
  branch: string;
  startCommit: string;
  fingerprint: string;
  contentHash: string;
  evidenceHash: string;
  intent: Record<string, unknown>;
}

/** Pairs of jobs that promoted a routing policy row; a human regrade of either side re-checks the promotion. */
interface PromotionEvidence {
  from: Tier;
  pairs: Array<[string, string]>;
}

export class DovskyDatabase {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  routingBandit: BanditConfig | null = null;

  constructor(readonly path: string, private readonly migrationHooks: MigrationHooks = {}, readonly maxQueuedJobs = 200,
    private readonly scopeObserver: (enrollment: ExecutionEnrollment) => ProcessObservation = observeScope,
    private readonly scopeSignaler: (enrollment: ExecutionEnrollment, signal: 'SIGTERM' | 'SIGKILL') => Promise<void> = signalScope) {
    if(!Number.isInteger(maxQueuedJobs)||maxQueuedJobs<1||maxQueuedJobs>10_000)throw new Error('Invalid global queue capacity');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    try { this.migrate(); } catch (error) { this.db.close(); throw error; }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(callback: () => T): T {
    const level = this.transactionDepth;
    const savepoint = `dovsky_${level}`;
    this.transactionDepth += 1;
    let opened = false;
    try {
      this.db.exec(level === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
      opened = true;
      const result = callback();
      this.db.exec(level === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      if (opened) {
        this.db.exec(level === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as Row;
    const version = Number(row.user_version ?? 0);
    if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than this daemon`);
    if (version === 0) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE rooms (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            project_id TEXT NOT NULL,
            workflow_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE jobs (
            id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            provider TEXT NOT NULL CHECK(provider IN ('claude','codex')),
            project_id TEXT NOT NULL,
            workflow_id TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('queued','starting','running','cancel_requested','succeeded','failed','cancelled')),
            prompt TEXT NOT NULL,
            result TEXT,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            failure_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            retry_of_job_id TEXT REFERENCES jobs(id),
            source_job_id TEXT REFERENCES jobs(id)
          );
          CREATE INDEX jobs_room_idx ON jobs(room_id, created_at);
          CREATE INDEX jobs_state_idx ON jobs(state, created_at);
          CREATE TABLE turns (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            author TEXT NOT NULL CHECK(author IN ('human','claude','codex','system')),
            recipient TEXT NOT NULL CHECK(recipient IN ('claude','codex','both','human')),
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','streaming','complete','failed'))
          );
          CREATE INDEX turns_room_idx ON turns(room_id, created_at);
          CREATE TABLE attempts (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
            number INTEGER NOT NULL,
            state TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            failure_json TEXT,
            had_tool_activity INTEGER DEFAULT 0,
            worktree_fingerprint TEXT,
            UNIQUE(job_id, number)
          );
          CREATE TABLE operations (
            idempotency_key TEXT PRIMARY KEY,
            method TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            response_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
            job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            data_json TEXT NOT NULL
          );
          CREATE INDEX events_room_idx ON events(room_id, id);
          CREATE TABLE checks (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            command_json TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending','passed','failed','skipped')),
            exit_code INTEGER,
            summary TEXT
          );
          CREATE TABLE changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('added','modified','deleted','renamed')),
            additions INTEGER,
            deletions INTEGER,
            UNIQUE(job_id, path)
          );
          CREATE TABLE artifacts (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK(kind IN ('result','provider_log','gate_log','export')),
            name TEXT NOT NULL,
            media_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            path TEXT NOT NULL
          );
          CREATE TABLE resource_locks (
            resource TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            acquired_at TEXT NOT NULL
          );
          CREATE TABLE legacy_imports (
            source_job_id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL REFERENCES rooms(id),
            job_id TEXT NOT NULL REFERENCES jobs(id),
            imported_at TEXT NOT NULL
          );
          PRAGMA user_version=1;
        `);
      });
    }
    if (version < 2) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN depth INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=2;");
    }
    if (version < 3) {
      this.db.exec(`
        ALTER TABLE jobs ADD COLUMN tier TEXT;
        ALTER TABLE jobs ADD COLUMN model TEXT;
        ALTER TABLE jobs ADD COLUMN effort TEXT;
        ALTER TABLE jobs ADD COLUMN charter TEXT;
        ALTER TABLE jobs ADD COLUMN cwd TEXT;
        ALTER TABLE jobs ADD COLUMN thread_id TEXT;
        ALTER TABLE jobs ADD COLUMN escalated_from TEXT REFERENCES jobs(id);
        ALTER TABLE attempts ADD COLUMN argv_json TEXT;
        ALTER TABLE attempts ADD COLUMN input_tokens INTEGER;
        ALTER TABLE attempts ADD COLUMN cached_input_tokens INTEGER;
        ALTER TABLE attempts ADD COLUMN output_tokens INTEGER;
        PRAGMA user_version=3;
      `);
    }
    if (version < 4) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN resume_thread_id TEXT; PRAGMA user_version=4;");
    }
    if (version < 5) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN gates_json TEXT; PRAGMA user_version=5;");
    }
    if (version < 6) {
      // Turns recorded without a provider run need a nullable job_id, which SQLite only allows through a table
      // rebuild; foreign keys are off for the swap so attempts' references to turns(id) survive it.
      this.db.exec("PRAGMA foreign_keys=OFF");
      try {
        this.transaction(() => {
          this.db.exec(`
            ALTER TABLE jobs ADD COLUMN progress_json TEXT;
            CREATE TABLE turns_v6 (
              id TEXT PRIMARY KEY,
              job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
              room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
              author TEXT NOT NULL CHECK(author IN ('human','claude','codex','system')),
              recipient TEXT NOT NULL CHECK(recipient IN ('claude','codex','both','human')),
              body TEXT NOT NULL,
              created_at TEXT NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('pending','streaming','complete','failed')),
              model TEXT,
              effort TEXT
            );
            INSERT INTO turns_v6(id,job_id,room_id,author,recipient,body,created_at,status)
              SELECT id,job_id,room_id,author,recipient,body,created_at,status FROM turns;
            DROP TABLE turns;
            ALTER TABLE turns_v6 RENAME TO turns;
            CREATE INDEX turns_room_idx ON turns(room_id, created_at);
            PRAGMA user_version=6;
          `);
        });
      } finally {
        this.db.exec("PRAGMA foreign_keys=ON");
      }
    }
    if (version < 7) this.migrateToVersion7();
    if (version < 8) this.migrateToVersion8();
    if (version < 9) this.transaction(() => this.db.exec(`
      ALTER TABLE jobs ADD COLUMN evaluation_json TEXT;
      ALTER TABLE jobs ADD COLUMN evaluation_report_json TEXT;
      ALTER TABLE jobs ADD COLUMN evaluation_evidence_hash TEXT;
      ALTER TABLE jobs ADD COLUMN acceptance_json TEXT;
      ALTER TABLE jobs ADD COLUMN evaluation_state TEXT;
      PRAGMA user_version=9;
    `));
    if (version < 11) this.migrateToVersion11(version);
    if (version < 12) this.migrateToVersion12();
    if (version < 13) this.migrateToVersion13();
    this.validateCoordinationSchema();
    migrateFoundation(this.db, (callback) => this.transaction(callback), this.migrationHooks);
  }

  /**
   * Schema 13 puts a session above rooms. One workflow was opening one room per task, so the room list
   * became a flat wall nobody could navigate; a session is the container that groups them. The backfill
   * adopts every existing room -- a room left with a null session_id would be invisible to a client that
   * groups by session -- into one default session per (project, workflow), not one per room.
   */
  private migrateToVersion13(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          project_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX sessions_default_idx ON sessions(project_id, workflow_id) WHERE is_default=1;
        ALTER TABLE rooms ADD COLUMN session_id TEXT REFERENCES sessions(id);
        ALTER TABLE rooms ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE rooms ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX rooms_session_idx ON rooms(session_id, updated_at);
      `);
      const groups = this.db
        .prepare("SELECT project_id, workflow_id, min(created_at) AS first_at, max(updated_at) AS last_at FROM rooms GROUP BY project_id, workflow_id")
        .all() as Row[];
      for (const group of groups) {
        const projectId = text(group, "project_id");
        const workflowId = text(group, "workflow_id");
        const sessionId = randomUUID();
        this.db
          .prepare("INSERT INTO sessions(id,title,project_id,workflow_id,is_default,created_at,updated_at) VALUES(?,?,?,?,1,?,?)")
          .run(sessionId, workflowId, projectId, workflowId, text(group, "first_at"), text(group, "last_at"));
        this.db.prepare("UPDATE rooms SET session_id=? WHERE project_id=? AND workflow_id=?").run(sessionId, projectId, workflowId);
      }
      this.db.exec("PRAGMA user_version=13");
    });
  }

  private migrateToVersion12(): void {
    this.transaction(() => this.db.exec(`
      CREATE TABLE execution_leases (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
        command_kind TEXT NOT NULL,
        command_number INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','running','reconcile_required','exited')),
        pid INTEGER,
        process_group INTEGER,
        process_start_ticks TEXT,
        boot_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        prepared_at TEXT NOT NULL,
        enrolled_at TEXT,
        exited_at TEXT,
        observation_json TEXT,
        CHECK((state='prepared' AND pid IS NULL AND process_group IS NULL AND process_start_ticks IS NULL AND boot_id IS NULL) OR
              (state='running' AND pid IS NOT NULL AND process_group IS NOT NULL AND process_start_ticks IS NOT NULL AND boot_id IS NOT NULL) OR
              state IN ('reconcile_required','exited'))
      );
      CREATE INDEX execution_leases_job_idx ON execution_leases(job_id, state, prepared_at);
      PRAGMA user_version=12;
    `));
  }

  private migrateToVersion11(version: number): void {
    this.transaction(() => {
      const columns = new Set(this.db.prepare("PRAGMA table_info(jobs)").all().map((row) => String(row.name)));
      const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
      const coordinationTables = ["tasks", "task_controls", "task_ownership", "event_consumers", "daemon_settings", "release_candidates", "release_authorizations", "release_operations", "release_targets"];
      const present = coordinationTables.filter((table) => tables.has(table));
      const visibilityLayout = ["predecessor_job_id", "requested_model", "reported_model"].every((column) => columns.has(column));
      if (present.length && present.length !== coordinationTables.length) throw new Error("Incomplete coordination schema; migration requires a consistent database backup");
      if (!present.length) {
        if (columns.has("task_id") || columns.has("predecessor_pending") || version === 10 && !visibilityLayout) throw new Error("Unrecognized schema-10 layout; refusing to infer missing coordination data");
        const sql = columns.has("predecessor_job_id")
          ? COORDINATION_SCHEMA_SQL.replace("ALTER TABLE jobs ADD COLUMN predecessor_job_id TEXT REFERENCES jobs(id);", "")
          : COORDINATION_SCHEMA_SQL;
        this.db.exec(`${sql}\n${RELEASE_SCHEMA_SQL}`);
        // Visibility v10 queued causal continuations must retain their predecessor's
        // logical ownership when cooperative tasks are introduced.
        if (visibilityLayout) {
          const queued = this.db.prepare("SELECT id,predecessor_job_id,room_id,provider,created_at FROM jobs WHERE role='work' AND state='queued' AND predecessor_job_id IS NOT NULL ORDER BY created_at,rowid").all();
          const byId = new Map(queued.map((row) => [String(row.id), row]));
          const taskFor = (id: string, visiting = new Set<string>()): string => {
            if (visiting.has(id)) throw new Error("Cyclic predecessor chain in visibility schema");
            visiting.add(id);
            const row = byId.get(id);
            if (!row) {
              const parent = this.db.prepare("SELECT task_id FROM jobs WHERE id=?").get(id);
              if (!parent?.task_id) throw new Error("Missing predecessor task in visibility schema");
              return String(parent.task_id);
            }
            const parent = this.db.prepare("SELECT room_id FROM jobs WHERE id=?").get(String(row.predecessor_job_id));
            if (parent?.room_id !== row.room_id) throw new Error("Predecessor belongs to a different room");
            return taskFor(String(row.predecessor_job_id), visiting);
          };
          for (const row of queued) {
            const taskId = taskFor(String(row.id));
            this.db.prepare("UPDATE jobs SET task_id=?,predecessor_pending=1 WHERE id=?").run(taskId, String(row.id));
            this.db.prepare("UPDATE tasks SET latest_job_id=?,provider=?,state='working',phase='Queued',updated_at=? WHERE id=?")
              .run(String(row.id), String(row.provider), String(row.created_at), taskId);
          }
          for (const row of queued) this.db.prepare("DELETE FROM tasks WHERE id=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE task_id=tasks.id)").run(String(row.id));
        }
      } else if (!["task_id", "predecessor_job_id", "predecessor_pending"].every((column) => columns.has(column))) {
        throw new Error("Incomplete coordination job columns");
      }
      if (!columns.has("requested_model")) {
        this.db.exec("ALTER TABLE jobs ADD COLUMN requested_model TEXT; UPDATE jobs SET requested_model=model;");
      }
      if (!columns.has("reported_model")) this.db.exec("ALTER TABLE jobs ADD COLUMN reported_model TEXT;");
      this.validateCoordinationSchema();
      this.db.exec("PRAGMA user_version=11");
    });
  }

  private validateCoordinationSchema(): void {
    const required: Record<string, string[]> = {
      jobs: ["task_id", "predecessor_job_id", "predecessor_pending", "requested_model", "reported_model"],
      tasks: ["id", "latest_job_id", "state"], task_controls: ["task_id", "sequence", "acknowledged_at"],
      task_ownership: ["workdir", "task_id"], event_consumers: ["id", "acknowledged", "delivered"],
      daemon_settings: ["key", "value"], release_candidates: ["id", "identity_hash", "data_json"],
      release_authorizations: ["id", "decision_key", "data_json"], release_operations: ["id", "state", "data_json"],
      release_targets: ["target", "operation_id", "owner_token"],
    };
    const schemaVersion = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version ?? 0);
    if (schemaVersion >= 12) required.execution_leases = ["id", "job_id", "state", "revision", "prepared_at"];
    for (const [table, names] of Object.entries(required)) {
      const actual = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
      for (const name of names) if (!actual.has(name)) throw new Error(`Incompatible database schema: missing ${table}.${name}`);
    }
  }

  private leaseView(row: Row): ExecutionLeaseView {
    return {
      scopeUnit: nullableText(row,'scope_unit'),
      cgroupPath: nullableText(row,'cgroup_path'),
      bootId: nullableText(row,'boot_id'),
      id: text(row, "id"),
      jobId: text(row, "job_id"),
      attemptId: nullableText(row, "attempt_id"),
      kind: text(row, "command_kind"),
      number: number(row, "command_number"),
      state: text(row, "state") as ExecutionLeaseState,
      identity: leaseIdentity(row),
      revision: number(row, "revision"),
      preparedAt: text(row, "prepared_at"),
      enrolledAt: nullableText(row, "enrolled_at"),
      exitedAt: nullableText(row, "exited_at"),
      observation: parseJson<ProcessObservation | null>(row.observation_json, null),
    };
  }

  getLease(id: string): ExecutionLeaseView | null {
    const row = this.db.prepare("SELECT * FROM execution_leases WHERE id=?").get(id) as Row | undefined;
    return row ? this.leaseView(row) : null;
  }

  private activeLeases(jobId: string): ExecutionLeaseView[] {
    return (this.db.prepare("SELECT * FROM execution_leases WHERE job_id=? AND state IN ('prepared','running','reconcile_required') ORDER BY prepared_at,id").all(jobId) as Row[])
      .map((row) => this.leaseView(row));
  }

  prepareExecutionLease(id: string, jobId: string, attemptId: string | null, kind: string, commandNumber: number): ExecutionLeaseView {
    return this.transaction(() => {
      if (this.hasPendingApplication(jobId)) throw new DaemonError('STATE_CONFLICT', 'Canonical application must be reconciled before another command');
      if (this.activeLeases(jobId).length) throw new DaemonError("STATE_CONFLICT", `Job ${jobId} already has an unresolved execution lease`);
      const job = this.getJob(jobId);
      if (!job) throw new DaemonError("NOT_FOUND", `Job not found: ${jobId}`);
      const preparedAt = isoNow();
      this.db.prepare(
        "INSERT INTO execution_leases(id,job_id,attempt_id,command_kind,command_number,state,prepared_at) VALUES(?,?,?,?,?,'prepared',?)",
      ).run(id, jobId, attemptId, kind, commandNumber, preparedAt);
      this.insertEvent(job.roomId, jobId, "execution.lease.prepared", { leaseId: id, kind, commandNumber }, preparedAt);
      return this.getLease(id)!;
    });
  }

  beginScopedExecutionLease(id: string, intent: { scopeUnit: string; bootId: string }): ExecutionLeaseView {
    if (!/^dovsky-job-[a-zA-Z0-9-]{1,180}\.scope$/.test(intent.scopeUnit)
      || !/^[a-zA-Z0-9-]{1,128}$/.test(intent.bootId)) throw new DaemonError('INVALID_REQUEST', 'Invalid execution scope intent');
    return this.transaction(() => {
      const lease = this.getLease(id);
      if (!lease || lease.state !== 'prepared') throw new DaemonError('STATE_CONFLICT', 'Execution lease is not prepared');
      const observation: ProcessObservation = { state: 'unverifiable', members: [], reason: 'Scope launch intent persisted; actual gate enrollment is pending' };
      this.db.prepare("UPDATE execution_leases SET state='reconcile_required',scope_unit=?,boot_id=?,observation_json=?,revision=revision+1 WHERE id=? AND revision=?")
        .run(intent.scopeUnit, intent.bootId, JSON.stringify(observation), id, lease.revision);
      const job = this.getJob(lease.jobId)!;
      this.insertEvent(job.roomId, job.id, 'execution.lease.launching', { leaseId: id, ...intent }, isoNow());
      return this.getLease(id)!;
    });
  }

  enrollScopedExecutionLease(id: string, enrollment: ExecutionEnrollment): ExecutionLeaseView {
    return this.transaction(() => {
      const lease = this.getLease(id);
      if (!lease || lease.state !== 'reconcile_required' || lease.identity !== null || lease.cgroupPath !== null
        || lease.scopeUnit !== enrollment.scopeUnit || lease.bootId !== enrollment.identity.bootId) {
        throw new DaemonError('STATE_CONFLICT', 'Execution scope enrollment does not match its pending intent');
      }
      const job = this.getJob(lease.jobId)!;
      if (job.state !== 'starting' && job.state !== 'running') throw new DaemonError('STATE_CONFLICT', 'Execution was cancelled before scope enrollment');
      const { identity, scopeUnit, cgroupPath } = enrollment;
      if (!cgroupPath.startsWith('/') || cgroupPath.split('/').includes('..') || !cgroupPath.endsWith('/' + scopeUnit)) {
        throw new DaemonError('INVALID_REQUEST', 'Invalid execution scope cgroup');
      }
      const at = isoNow();
      this.db.prepare("UPDATE execution_leases SET state='running',pid=?,process_group=?,process_start_ticks=?,boot_id=?,cgroup_path=?,enrolled_at=?,revision=revision+1 WHERE id=? AND revision=?")
        .run(identity.pid, identity.processGroup, identity.startTicks, identity.bootId, cgroupPath, at, id, lease.revision);
      this.insertEvent(job.roomId, job.id, 'execution.lease.running', { leaseId: id, identity, scopeUnit, cgroupPath }, at);
      return this.getLease(id)!;
    });
  }

  /** Failed startup may learn the gate identity after cancellation. This never authorizes gate release. */
  recordFailedScopeEnrollment(id: string, enrollment: ExecutionEnrollment): ExecutionLeaseView {
    return this.transaction(() => {
      const lease = this.getLease(id);
      if (!lease || lease.state !== 'reconcile_required' || lease.identity !== null || lease.cgroupPath !== null
        || lease.scopeUnit !== enrollment.scopeUnit || lease.bootId !== enrollment.identity.bootId) {
        throw new DaemonError('STATE_CONFLICT', 'Failed scope enrollment does not match its pending intent');
      }
      const { identity, scopeUnit, cgroupPath } = enrollment;
      if (!cgroupPath.startsWith('/') || cgroupPath.split('/').includes('..') || !cgroupPath.endsWith('/' + scopeUnit)) {
        throw new DaemonError('INVALID_REQUEST', 'Invalid failed execution scope cgroup');
      }
      const at = isoNow();
      this.db.prepare('UPDATE execution_leases SET pid=?,process_group=?,process_start_ticks=?,cgroup_path=?,enrolled_at=?,revision=revision+1 WHERE id=? AND revision=?')
        .run(identity.pid, identity.processGroup, identity.startTicks, cgroupPath, at, id, lease.revision);
      const job = this.getJob(lease.jobId)!;
      this.insertEvent(job.roomId, job.id, 'execution.lease.start_failed', { leaseId: id, identity, scopeUnit, cgroupPath }, at);
      return this.getLease(id)!;
    });
  }

  enrollExecutionLease(id: string, identity: ProcessIdentity, scope?: {unit:string;cgroupPath:string}): ExecutionLeaseView {
    return this.transaction(() => {
      const lease = this.getLease(id);
      if (!lease || lease.state !== "prepared") throw new DaemonError("STATE_CONFLICT", `Execution lease ${id} is not prepared`);
      const enrolledAt = isoNow();
      if(scope&&(!/^[A-Za-z0-9_.-]+\.scope$/.test(scope.unit)||!scope.cgroupPath.startsWith('/')||scope.cgroupPath.split('/').includes('..')||!scope.cgroupPath.endsWith('/'+scope.unit)))throw new DaemonError('INVALID_REQUEST','Invalid execution scope identity');
      const result = this.db.prepare(
        `UPDATE execution_leases SET state='running',pid=?,process_group=?,process_start_ticks=?,boot_id=?,
         enrolled_at=?,scope_unit=?,cgroup_path=?,revision=revision+1 WHERE id=? AND state='prepared'`,
      ).run(identity.pid, identity.processGroup, identity.startTicks, identity.bootId, enrolledAt, scope?.unit??null,scope?.cgroupPath??null,id);
      if (Number(result.changes) !== 1) throw new DaemonError("STATE_CONFLICT", `Execution lease ${id} changed concurrently`);
      const job = this.getJob(lease.jobId)!;
      this.insertEvent(job.roomId, job.id, "execution.lease.running", { leaseId: id, identity }, enrolledAt);
      return this.getLease(id)!;
    });
  }

  settleExecutionLease(id: string): ExecutionLeaseView | null {
    const lease = this.getLease(id);
    if (!lease || lease.state === 'exited') return lease;
    return this.recordLeaseObservation(id, lease.revision, this.observeLease(lease));
  }

  /** Host observation happens before this CAS; this method never observes or signals a process. */
  recordLeaseObservation(id: string, expectedRevision: number, observation: ProcessObservation): ExecutionLeaseView {
    return this.transaction(() => {
      const lease = this.getLease(id);
      if (!lease) throw new DaemonError('NOT_FOUND', `Execution lease not found: ${id}`);
      if (lease.revision !== expectedRevision) throw new DaemonError('STATE_CONFLICT', 'Execution lease revision changed; observe it again');
      if (lease.state === 'exited') return lease;
      const state: ExecutionLeaseState = observation.state === 'absent' ? 'exited' : 'reconcile_required';
      const exitedAt = isoNow();
      const result = this.db.prepare(
        "UPDATE execution_leases SET state=?,exited_at=CASE WHEN ?='exited' THEN ? ELSE exited_at END,observation_json=?,revision=revision+1 WHERE id=? AND revision=?",
      ).run(state, state, exitedAt, JSON.stringify(observation), id, expectedRevision);
      if (Number(result.changes) !== 1) throw new DaemonError('STATE_CONFLICT', 'Execution lease changed while recording observation');
      const job = this.getJob(lease.jobId)!;
      this.insertEvent(job.roomId, job.id, state === "exited" ? "execution.lease.exited" : "execution.lease.reconcile_required", { leaseId: id, observation }, exitedAt);
      // A running job still owns canonical application/gates after command completion.
      return this.getLease(id)!;
    });
  }

  /** Persist a newer valid measurement for this window, without erasing another window. */
  recordQuota(provider: Provider, value: unknown, now = isoNow()): boolean {
    const reading = quotaReading(value);
    if ((provider !== 'claude' && provider !== 'codex') || !reading || !quotaCurrent(reading, now)) return false;
    return this.transaction(() => {
      const row = this.db.prepare('SELECT reading_json FROM provider_quota WHERE provider=?').get(provider) as Row | undefined;
      const windows = quotaWindows(row?.reading_json);
      const previous = windows.find(item => item.windowId === reading.windowId);
      if (previous && Date.parse(previous.recordedAt) >= Date.parse(reading.recordedAt)) return false;
      const next = windows.filter(item => item.windowId !== reading.windowId && quotaCurrent(item, now));
      if (next.length >= 8) return false;
      next.push(reading); next.sort((a, b) => a.windowId.localeCompare(b.windowId));
      const newest = next.reduce((a, b) => a.recordedAt >= b.recordedAt ? a : b);
      this.db.prepare(`INSERT INTO provider_quota(provider,reading_json,recorded_at,window_minutes) VALUES(?,?,?,?)
        ON CONFLICT(provider) DO UPDATE SET reading_json=excluded.reading_json,recorded_at=excluded.recorded_at,window_minutes=excluded.window_minutes`)
        .run(provider, JSON.stringify({ version: 1, windows: next }), newest.recordedAt, newest.windowMinutes);
      return true;
    });
  }

  /** Highest active measured utilization; a malformed/expired row is unavailable. */
  getQuota(provider: Provider, now = isoNow()): QuotaWindowReading | null {
    const row = this.db.prepare('SELECT reading_json FROM provider_quota WHERE provider=?').get(provider) as Row | undefined;
    const readings = quotaWindows(row?.reading_json).filter(reading => quotaCurrent(reading, now));
    readings.sort((a, b) => b.usedPercent - a.usedPercent || b.recordedAt.localeCompare(a.recordedAt));
    return readings[0] ?? null;
  }

  hasUnresolvedLeases(jobId: string): boolean {
    return this.activeLeases(jobId).length > 0;
  }

  /** Daemon-only identity selection; it does not create a home or authorize a resume command. */
  reserveProviderState(jobId: string): string {
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job) throw new DaemonError('NOT_FOUND', `Job not found: ${jobId}`);
      if (!['queued', 'starting', 'running'].includes(job.state)) throw new DaemonError('STATE_CONFLICT', 'Provider state can only be reserved for an active job');
      const metadata = (id: string): { raw: string | null; value: Record<string, unknown> } => {
        const row = this.db.prepare('SELECT sandbox_json FROM jobs WHERE id=?').get(id) as Row | undefined;
        const raw = row ? nullableText(row, 'sandbox_json') : null;
        if (raw === null) return { raw, value: {} };
        try {
          if (Buffer.byteLength(raw) > 65536) throw new Error('oversized');
          const value: unknown = JSON.parse(raw);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
          return { raw, value: value as Record<string, unknown> };
        } catch { throw new DaemonError('STATE_CONFLICT', 'Provider state metadata is unavailable or malformed'); }
      };
      const stateKey = (value: Record<string, unknown>): string | null => {
        if (!Object.hasOwn(value, 'providerStateKey')) return null;
        const key = value.providerStateKey;
        if (typeof key !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(key)) throw new DaemonError('STATE_CONFLICT', 'Provider state key is malformed');
        return key;
      };
      const saved = metadata(job.id), existing = stateKey(saved.value);
      let key = existing;
      if (job.resumeThreadId) {
        const keys = new Set<string>();
        for (const id of new Set([job.predecessorJobId, job.parentJobId, job.retryOfJobId].filter((id): id is string => Boolean(id)))) {
          const source = this.getJob(id);
          if (!source || source.provider !== job.provider || (source.threadId ?? source.resumeThreadId) !== job.resumeThreadId) continue;
          const inherited = stateKey(metadata(id).value);
          if (!inherited) throw new DaemonError('STATE_CONFLICT', 'Legacy resume has no retained provider state; explicit fresh execution is required');
          keys.add(inherited);
        }
        if (keys.size !== 1) throw new DaemonError('STATE_CONFLICT', keys.size ? 'Provider state lineage is ambiguous' : 'Provider state lineage is unavailable');
        key = [...keys][0]!;
        if (existing && existing !== key) throw new DaemonError('STATE_CONFLICT', 'Provider state changed from its recorded lineage');
      } else key ??= randomUUID();
      if (existing === key) return key;
      const updated = this.db.prepare('UPDATE jobs SET sandbox_json=? WHERE id=? AND sandbox_json IS ?')
        .run(JSON.stringify({ ...saved.value, providerStateKey: key }), job.id, saved.raw);
      if (Number(updated.changes) !== 1) throw new DaemonError('STATE_CONFLICT', 'Provider state metadata changed during reservation');
      this.insertEvent(job.roomId, job.id, 'execution.provider_state.reserved', { providerStateKey: key }, isoNow());
      return key;
    });
  }

  hasPendingApplication(jobId: string): boolean {
    const row = this.db.prepare('SELECT sandbox_json FROM jobs WHERE id=?').get(jobId) as Row | undefined;
    return row ? applicationPending(nullableText(row, 'sandbox_json')) : false;
  }

  hasUnresolvedExecution(jobId: string): boolean {
    return this.hasUnresolvedLeases(jobId) || this.hasPendingApplication(jobId);
  }

  canReleaseTaskOwnership(taskId: string): boolean {
    if (this.db.prepare("SELECT id FROM rollout_groups WHERE task_id=? AND state IN ('running','paused','promoting')").get(taskId)) return false;
    return !(this.db.prepare('SELECT id FROM jobs WHERE task_id=? OR rollout_group_id IN (SELECT id FROM rollout_groups WHERE task_id=?)').all(taskId, taskId) as Row[])
      .some(row => this.hasUnresolvedExecution(text(row, 'id')));
  }

  /** Pre-existing operator installations are assumed only until a daemon lock transition invalidates them. */
  canonicalDependenciesAllowed(canonicalPath: string): boolean {
    // Presence, including a malformed value, is a durable refusal. Never silently re-admit an invalidated installation.
    return !this.db.prepare('SELECT value FROM daemon_settings WHERE key=?').get(`dependency-origin:${canonicalPath}`);
  }

  invalidateCanonicalDependencies(jobId: string, canonicalPath: string): void {
    const job = this.getJob(jobId);
    const application = applicationRecord(job?.sandbox?.application);
    if (!job || !application || application.state !== 'pending' || application.canonicalPath !== canonicalPath) {
      throw new DaemonError('STATE_CONFLICT', 'Dependency invalidation requires the matching pending canonical application');
    }
    this.db.prepare('INSERT OR IGNORE INTO daemon_settings(key,value) VALUES(?,?)')
      .run(`dependency-origin:${canonicalPath}`, JSON.stringify({ version: 1, state: 'runtime_invalidated', canonicalPath, jobId, at: isoNow() }));
  }

  /** Reserve before touching canonical contents; no host I/O belongs in this transaction. */
  beginCanonicalApplication(jobId: string, value: Omit<CanonicalApplication, 'state'>): void {
    const application = applicationRecord({ ...value, state: 'pending' });
    if (!application) throw new DaemonError('INVALID_REQUEST', 'Invalid canonical application identity');
    this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job) throw new DaemonError('NOT_FOUND', `Job not found: ${jobId}`);
      const candidate = job.executionKind === 'rollout_candidate' && job.cwd === application.canonicalPath
        && job.sandbox?.rolloutPath === application.canonicalPath
        && ['running', 'paused'].includes(this.getRolloutGroup(job.rolloutGroupId ?? '')?.state ?? '');
      if (job.state !== 'running' || !(isForegroundExecution(job.executionKind) || candidate) || this.hasUnresolvedExecution(jobId)) {
        throw new DaemonError('STATE_CONFLICT', 'Canonical application needs a running foreground or assigned private candidate job and confirmed command absence');
      }
      const owner = this.db.prepare('SELECT job_id FROM resource_locks WHERE resource=?').get(`worktree:${application.canonicalPath}`);
      if (owner?.job_id !== jobId) throw new DaemonError('STATE_CONFLICT', 'Canonical application requires the exact worktree reservation');
      this.db.prepare('UPDATE jobs SET sandbox_json=?,job_delta_path=? WHERE id=?')
        .run(JSON.stringify({ ...job.sandbox, application }), application.finalPath, jobId);
      this.insertEvent(job.roomId, job.id, 'execution.application.pending', application, isoNow());
    });
  }

  /** Caller has verified the complete marker and current canonical content outside SQLite. */
  completeCanonicalApplication(jobId: string, intentPath: string, identity: { fingerprint: string; contentHash: string }): void {
    this.transaction(() => {
      const job = this.getJob(jobId);
      const application = applicationRecord(job?.sandbox?.application);
      if (!job || !application || application.state !== 'pending' || application.intentPath !== intentPath
        || application.contentHash !== identity.contentHash || !/^[a-f0-9]{64}$/.test(identity.fingerprint)) {
        throw new DaemonError('STATE_CONFLICT', 'Canonical application completion does not match its pending identity');
      }
      if (this.hasUnresolvedLeases(jobId)) throw new DaemonError('STATE_CONFLICT', 'Canonical application still has unresolved execution');
      this.db.prepare('UPDATE jobs SET sandbox_json=?,end_content_hash=? WHERE id=?')
        .run(JSON.stringify({ ...job.sandbox, application: { ...application, state: 'complete' } }), identity.contentHash, jobId);
      this.insertEvent(job.roomId, job.id, 'execution.application.complete', { intentPath, identity }, isoNow());
    });
  }

  /** One observation policy for settlement, operator reconciliation and restart. */
  private observeLease(lease:ExecutionLeaseView):ProcessObservation {
    if (this.transactionDepth !== 0) throw new DaemonError('INTERNAL', 'Execution observation must run outside a database transaction');
    if (lease.scopeUnit || lease.cgroupPath) {
      if (lease.scopeUnit && lease.cgroupPath && lease.identity) {
        try { return this.scopeObserver({ scopeUnit: lease.scopeUnit, cgroupPath: lease.cgroupPath, identity: lease.identity }); }
        catch (error) { return { state: 'unverifiable', members: [], reason: String(error) }; }
      }
      return {state:'unverifiable',members:[],reason:'Scoped launch intent has no authoritative gate enrollment; retain startup quarantine'};
    }
    if (lease.state === 'prepared') return { state: 'absent', members: [], reason: 'No launch was attempted' };
    return lease.identity?inspectProcessGroup(lease.identity):{state:'unverifiable',members:[],reason:'This legacy execution has no persisted process identity'};
  }

  executionForJob(jobId: string): { jobId: string; leases: ExecutionLeaseView[]; resources: string[] } {
    if (!this.getJob(jobId)) throw new DaemonError("NOT_FOUND", `Job not found: ${jobId}`);
    return {
      jobId,
      leases: (this.db.prepare("SELECT * FROM execution_leases WHERE job_id=? ORDER BY prepared_at,id").all(jobId) as Row[]).map((row) => this.leaseView(row)),
      resources: (this.db.prepare("SELECT resource FROM resource_locks WHERE job_id=? ORDER BY resource").all(jobId) as Row[]).map((row) => text(row, "resource")),
    };
  }

  async reconcileExecutionLease(id: string, expectedRevision: number, action: "inspect" | "terminate"): Promise<ExecutionLeaseView> {
      if (this.transactionDepth !== 0) throw new DaemonError('INTERNAL', 'Execution reconciliation must run outside a database transaction');
      const lease = this.getLease(id);
      if (!lease) throw new DaemonError("NOT_FOUND", `Execution lease not found: ${id}`);
      if (lease.revision !== expectedRevision) throw new DaemonError("STATE_CONFLICT", "Execution lease revision changed; inspect it again before reconciling");
      if (lease.state === "exited") return lease;
      const identity = lease.identity;
      const scoped=Boolean(lease.scopeUnit||lease.cgroupPath);
      let observation = this.observeLease(lease);
      if (action === "terminate") {
        if (!identity || observation.state !== 'alive' || (scoped && (!lease.scopeUnit || !lease.cgroupPath))) {
          throw new DaemonError('STATE_CONFLICT', 'Only an identity-verified live execution with authoritative cgroup observation can be terminated');
        }
        if (this.getLease(id)?.revision !== expectedRevision) throw new DaemonError('STATE_CONFLICT', 'Execution lease revision changed before signaling');
        const job = this.getJob(lease.jobId)!;
        this.insertEvent(job.roomId, job.id, 'execution.lease.signal_requested',
          { leaseId: id, revision: expectedRevision, scopeUnit: lease.scopeUnit, signal: 'SIGTERM' }, isoNow());
        try {
          if (scoped) await this.scopeSignaler({ identity, scopeUnit: lease.scopeUnit!, cgroupPath: lease.cgroupPath! }, 'SIGTERM');
          else process.kill(-identity.processGroup, 'SIGTERM');
        } catch (error) {
          this.insertEvent(job.roomId, job.id, 'execution.lease.signal_failed',
            { leaseId: id, signal: 'SIGTERM', reason: String(error) }, isoNow());
          throw new DaemonError('STATE_CONFLICT', 'Could not signal the identity-verified execution; retain its fence');
        }
        if (this.getLease(id)?.revision !== expectedRevision) throw new DaemonError('STATE_CONFLICT', 'Execution lease revision changed while signaling');
        observation = this.observeLease(lease);
      }
      const updated = this.recordLeaseObservation(id, expectedRevision, observation);
      this.transaction(() => {
        const job = this.getJob(lease.jobId)!;
        this.insertEvent(job.roomId, job.id, 'execution.lease.reconciled', { leaseId: id, action, observation }, isoNow());
        if (updated.state === 'exited' && TERMINAL_JOB_STATES.has(job.state)) this.releaseResources(job.id);
      });
      return updated;
  }

  recoverInterruptedJobs(readAttemptLog?: (jobId: string, provider: Provider) => { kind: string; command: string } | null): number {
    // Observe host state before opening the write transaction. Only the exact
    // observed lease revision may consume the result below.
    const observations = new Map<string, { revision: number; observation: ProcessObservation }>();
    const interrupted = this.db.prepare("SELECT id FROM jobs WHERE state IN ('starting','running','cancel_requested')").all() as Row[];
    for (const row of interrupted) {
      for (const lease of this.activeLeases(text(row, 'id'))) {
        observations.set(lease.id, { revision: lease.revision, observation: this.observeLease(lease) });
      }
    }
    const now = isoNow();
    const failure: FailureInfo = {
      code: "daemon_restart",
      summary: "Daemon restarted while this attempt was active",
      retryable: true,
      resumable: false,
      exitCode: null,
      signal: null,
      occurredAt: now,
    };
    const cancelled: FailureInfo = {
      ...failure,
      code: "cancelled_by_user",
      summary: "Cancellation was requested before the daemon restarted",
      retryable: false,
    };
    return this.transaction(() => {
      const rows = this.db
        .prepare("SELECT id, room_id, state, provider FROM jobs WHERE state IN ('starting','running','cancel_requested')")
        .all() as Row[];
      for (const row of rows) {
        const jobId = text(row, "id");
        const provider = text(row, "provider") as Provider;
        let leases = this.activeLeases(jobId);
        const wasCancelling = text(row, "state") === "cancel_requested";
        const hasExecutionEvidence = number(this.db.prepare(
          "SELECT count(*) AS total FROM attempts WHERE job_id=? AND state IN ('starting','running','cancel_requested')",
        ).get(jobId) as Row, "total") > 0 || number(this.db.prepare(
          "SELECT count(*) AS total FROM resource_locks WHERE job_id=?",
        ).get(jobId) as Row, "total") > 0;
        const hasRecordedLease = Boolean(this.db.prepare('SELECT id FROM execution_leases WHERE job_id=? LIMIT 1').get(jobId));
        if (!leases.length && !hasRecordedLease && (!wasCancelling || hasExecutionEvidence)) {
          // Schema-11 and older daemons never recorded process identity. Preserve
          // their reservation rather than inventing an identity or releasing a
          // possibly live detached command.
          const legacyId = `legacy:${jobId}`;
          this.db.prepare(
            "INSERT INTO execution_leases(id,job_id,attempt_id,command_kind,command_number,state,revision,prepared_at,observation_json) VALUES(?,?,NULL,'legacy',0,'reconcile_required',0,?,?)",
          ).run(legacyId, jobId, now, JSON.stringify({ state: "unverifiable", members: [], reason: "The interrupted execution predates durable process identity" } satisfies ProcessObservation));
          leases = this.activeLeases(jobId);
        }
        let unresolved = this.hasPendingApplication(jobId);
        for (const lease of leases) {
          const prior = observations.get(lease.id);
          const observation: ProcessObservation = prior?.revision === lease.revision ? prior.observation
            : { state: 'unverifiable', members: [], reason: 'No matching pre-transaction observation; retain execution fence' };
          const state: ExecutionLeaseState = observation.state === "absent" ? "exited" : "reconcile_required";
          this.db.prepare(
            "UPDATE execution_leases SET state=?,exited_at=CASE WHEN ?='exited' THEN ? ELSE exited_at END,observation_json=?,revision=revision+1 WHERE id=? AND revision=? AND state IN ('prepared','running','reconcile_required')",
          ).run(state, state, now, JSON.stringify(observation), lease.id, lease.revision);
          unresolved ||= state !== "exited";
        }
        const next = wasCancelling ? "cancelled" : "failed";
        let info = unresolved
          ? { ...failure, summary: "Daemon restarted; execution remains quarantined until its process group is reconciled" }
          : wasCancelling ? cancelled : failure;
        if (readAttemptLog) {
          let interruptedTool: { kind: string; command: string } | null = null;
          try {
            interruptedTool = readAttemptLog(jobId, provider);
          } catch {
            interruptedTool = null;
          }
          if (interruptedTool) {
            info = {
              ...info,
              summary: `Daemon restarted while ${interruptedTool.kind} ${interruptedTool.command} was running; its outcome was not recorded`,
              interruptedTool,
            };
          }
        }
        this.db
          .prepare(
            "UPDATE jobs SET state=?, failure_json=?, finished_at=?, updated_at=? WHERE id=? AND state IN ('starting','running','cancel_requested')",
          )
          .run(next, JSON.stringify(info), now, now, jobId);
        this.db
          .prepare(
            "UPDATE attempts SET state='failed', failure_json=?, finished_at=? WHERE job_id=? AND state IN ('starting','running','cancel_requested')",
          )
          .run(JSON.stringify(info), now, jobId);
        this.db
          .prepare("UPDATE turns SET status='failed' WHERE job_id=? AND status IN ('pending','streaming')")
          .run(jobId);
        this.insertEvent(text(row, "room_id"), jobId, `job.${next}`, info, now);
        if (!unresolved) this.db.prepare("DELETE FROM resource_locks WHERE job_id=?").run(jobId);
      }
      return rows.length;
    });
  }

  withIdempotency<T>(key: string, method: string, requestHash: string, callback: () => T, principal = "operator"): T {
    return this.transaction(() => {
      this.db
        .prepare("DELETE FROM operations WHERE state='completed' AND created_at < ?")
        .run(new Date(Date.now() - OPERATION_RETENTION_MS).toISOString());
      const existing = this.db
        .prepare("SELECT method, request_hash, response_json,state FROM operations WHERE principal=? AND idempotency_key=?")
        .get(principal, key) as Row | undefined;
      if (existing) {
        if (text(existing, "method") !== method || text(existing, "request_hash") !== requestHash) {
          throw new DaemonError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different request");
        }
        if (existing.state !== "completed") throw new DaemonError("RECONCILE_REQUIRED", "Operation is still pending reconciliation");
        return parseJson<T>(existing.response_json, undefined as T);
      }
      const response = callback();
      this.db
        .prepare(
          "INSERT INTO operations(principal,idempotency_key,method,request_hash,response_json,created_at,reserved_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(principal, key, method, requestHash, JSON.stringify(response), isoNow(), isoNow());
      return response;
    });
  }

  /** Short transaction only. A pending record is never permission to repeat external work. */
  reserveOperation<T>(principal: string, key: string, method: string, requestHash: string):
    { state: "completed"; response: T } | { state: "reserved"; reservation: OperationReservation } {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM operations WHERE principal=? AND idempotency_key=?").get(principal,key);
      if (existing) {
        if (existing.method !== method || existing.request_hash !== requestHash) throw new DaemonError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different request");
        if (existing.state !== 'completed') throw new DaemonError("RECONCILE_REQUIRED", "Operation is pending; reconcile its durable identity before retrying");
        return { state: 'completed', response: JSON.parse(String(existing.response_json)) as T };
      }
      const operationId = randomUUID();
      const timestamp = isoNow();
      this.db.prepare(`INSERT INTO operations(principal,idempotency_key,method,request_hash,created_at,state,reserved_at,operation_id)
        VALUES(?,?,?,?,?,'pending',?,?)`).run(principal,key,method,requestHash,timestamp,timestamp,operationId);
      return { state: 'reserved', reservation: {principal,key,method,requestHash,operationId} };
    });
  }

  completeOperation(reservation: OperationReservation, response: unknown): void {
    const serialized = JSON.stringify(response);
    if (serialized === undefined) throw new DaemonError("INTERNAL", "Operation response must be JSON serializable");
    const {principal,key,method,requestHash,operationId} = reservation;
    const update = this.db.prepare(`UPDATE operations SET state='completed',response_json=? WHERE principal=? AND idempotency_key=?
      AND method=? AND request_hash=? AND operation_id=? AND state='pending'`).run(serialized,principal,key,method,requestHash,operationId);
    if (update.changes !== 1) throw new DaemonError("STATE_CONFLICT", "Operation reservation no longer matches");
  }

  private pullRequestView(row: Row): PullRequestView {
    const state = text(row, "state") as PullRequestState;
    if (!PULL_REQUEST_STATES.includes(state)) throw new DaemonError("STATE_CONFLICT", "Stored pull request state is invalid");
    const rawNumber = row.number;
    const pullNumber = rawNumber === null || rawNumber === undefined ? null : Number(rawNumber);
    if (pullNumber !== null && (!Number.isSafeInteger(pullNumber) || pullNumber <= 0)) throw new DaemonError("STATE_CONFLICT", "Stored pull request number is invalid");
    return {
      jobId: text(row, "job_id"), roomId: text(row, "room_id"), repository: text(row, "repository"), remote: text(row, "remote"),
      baseBranch: text(row, "base_branch"), branch: text(row, "branch"), startCommit: text(row, "start_commit"),
      headSha: nullableText(row, "head_sha"), number: pullNumber, url: nullableText(row, "url"), state,
      fingerprint: text(row, "tree_fingerprint"), contentHash: text(row, "content_hash"), evidenceHash: text(row, "evidence_hash"),
      bodyHash: nullableText(row, "body_sha256"), mergedAt: nullableText(row, "merged_at"), mergeCommit: nullableText(row, "merge_commit"),
      createdAt: text(row, "created_at"), updatedAt: text(row, "updated_at"),
    };
  }

  getPullRequest(jobId: string): PullRequestView | null {
    const row = this.db.prepare("SELECT * FROM pull_requests WHERE job_id=?").get(jobId) as Row | undefined;
    return row ? this.pullRequestView(row) : null;
  }

  private assertPullRequestIdentity(row: Row, input: PullRequestReservationInput): void {
    const stored = this.pullRequestView(row);
    for (const [actual, expected] of [[stored.jobId,input.jobId],[stored.roomId,input.roomId],[stored.repository,input.repository],
      [stored.remote,input.remote],[stored.baseBranch,input.baseBranch],[stored.branch,input.branch],[stored.startCommit,input.startCommit],
      [stored.fingerprint,input.fingerprint],[stored.contentHash,input.contentHash],[stored.evidenceHash,input.evidenceHash]] as const) {
      if (actual !== expected) throw new DaemonError("IDEMPOTENCY_CONFLICT", "Pull request identity changed for this job");
    }
  }

  /** Returns a completed exact replay before mutable acceptance/configuration checks or external preflight. */
  replayCompletedPullRequestOperation(principal:string,key:string,input:{jobId:string;fingerprint:string;evidenceHash:string;draft?:boolean}):PullRequestView|null {
    const operation=this.db.prepare("SELECT * FROM operations WHERE principal=? AND idempotency_key=?").get(principal,key) as Row|undefined;
    if(!operation)return null;
    if(text(operation,"method")!=="github.pr.create")throw new DaemonError("IDEMPOTENCY_CONFLICT","Idempotency key was reused for a different request");
    const row=this.db.prepare("SELECT * FROM pull_requests WHERE job_id=?").get(input.jobId) as Row|undefined;
    if(!row)throw new DaemonError("STATE_CONFLICT","Pull request operation lost its durable identity");
    const stored=this.pullRequestView(row),intent=parseJson<{draft?:unknown}>(row.intent_json,{});
    if(stored.fingerprint!==input.fingerprint||stored.evidenceHash!==input.evidenceHash
      ||input.draft!==undefined&&intent.draft!==input.draft)throw new DaemonError("IDEMPOTENCY_CONFLICT","Pull request request changed for this job");
    if(text(operation,"state")!=="completed")return null;
    const response=parseJson<unknown>(operation.response_json,null);
    if(!response||typeof response!=="object"||Array.isArray(response))throw new DaemonError("STATE_CONFLICT","Completed pull request response is malformed");
    return response as PullRequestView;
  }

  /** Atomically reserves generic RPC idempotency and the durable PR identity before any Git/GitHub work. */
  reservePullRequestOperation(principal: string, key: string, method: string, requestHash: string, input: PullRequestReservationInput):
    { state: "completed"; response: PullRequestView } | { state: "reserved"; reservation: OperationReservation; pullRequest: PullRequestView } {
    return this.transaction(() => {
      const existingOperation = this.db.prepare("SELECT * FROM operations WHERE principal=? AND idempotency_key=?").get(principal,key) as Row | undefined;
      if (existingOperation) {
        if (text(existingOperation,"method") !== method || text(existingOperation,"request_hash") !== requestHash) {
          throw new DaemonError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different request");
        }
        if (text(existingOperation,"state") === "completed") {
          const response=parseJson<unknown>(existingOperation.response_json,null);
          if(!response||typeof response!=="object"||Array.isArray(response))throw new DaemonError("STATE_CONFLICT","Completed pull request response is malformed");
          return { state: "completed", response: response as PullRequestView };
        }
        const row = this.db.prepare("SELECT * FROM pull_requests WHERE job_id=?").get(input.jobId) as Row | undefined;
        if (!row) throw new DaemonError("STATE_CONFLICT", "Pending pull request reservation lost its durable identity");
        this.assertPullRequestIdentity(row,input);
        const operationId=nullableText(existingOperation,"operation_id");
        if(!operationId)throw new DaemonError("STATE_CONFLICT","Pending pull request operation has no durable identity");
        return { state: "reserved", reservation: { principal,key,method,requestHash,operationId }, pullRequest:this.pullRequestView(row) };
      }
      const conflicting = this.db.prepare("SELECT * FROM pull_requests WHERE job_id=? OR (repository=? AND branch=?)").get(input.jobId,input.repository,input.branch) as Row | undefined;
      if (conflicting) { this.assertPullRequestIdentity(conflicting,input); throw new DaemonError("IDEMPOTENCY_CONFLICT", "Pull request already uses a different idempotency reservation"); }
      const operationId=randomUUID(),timestamp=isoNow();
      this.db.prepare(`INSERT INTO operations(principal,idempotency_key,method,request_hash,created_at,state,reserved_at,operation_id)
        VALUES(?,?,?,?,?,'pending',?,?)`).run(principal,key,method,requestHash,timestamp,timestamp,operationId);
      const intent={...input.intent,requestHash};
      this.db.prepare(`INSERT INTO pull_requests(job_id,room_id,repository,remote,base_branch,branch,start_commit,state,tree_fingerprint,content_hash,evidence_hash,intent_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'reserved',?,?,?,?,?,?)`).run(input.jobId,input.roomId,input.repository,input.remote,input.baseBranch,input.branch,input.startCommit,
          input.fingerprint,input.contentHash,input.evidenceHash,JSON.stringify(intent),timestamp,timestamp);
      return {state:"reserved",reservation:{principal,key,method,requestHash,operationId},pullRequest:this.getPullRequest(input.jobId)!};
    });
  }

  recordPullRequestProgress(jobId:string,state:"committed"|"pushed",headSha:string,remoteAbsent=false):PullRequestView {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) throw new DaemonError("STATE_CONFLICT", "Pull request head is invalid");
    return this.transaction(() => {
      const row=this.db.prepare("SELECT * FROM pull_requests WHERE job_id=?").get(jobId) as Row|undefined;
      if(!row)throw new DaemonError("NOT_FOUND","Pull request reservation not found");
      const current=this.pullRequestView(row);
      if((current.state==="committed"||current.state==="reconcile_required")&&state==="committed"&&remoteAbsent){
        this.db.prepare("UPDATE pull_requests SET state='committed',head_sha=?,updated_at=? WHERE job_id=?").run(headSha,isoNow(),jobId);
        return this.getPullRequest(jobId)!;
      }
      if(current.headSha&&current.headSha!==headSha)throw new DaemonError("STATE_CONFLICT","Pull request head changed after publication");
      const allowed:Record<"committed"|"pushed",readonly PullRequestState[]>={
        committed:["reserved","committed"],pushed:["committed","pushed","reconcile_required"],
      };
      if(!allowed[state].includes(current.state)){
        if(["open","merged","closed"].includes(current.state))return current;
        throw new DaemonError("STATE_CONFLICT",`Pull request cannot move from ${current.state} to ${state}`);
      }
      if(current.state===state){
        return current;
      }
      this.db.prepare("UPDATE pull_requests SET state=?,head_sha=?,updated_at=? WHERE job_id=?").run(state,headSha,isoNow(),jobId);
      return this.getPullRequest(jobId)!;
    });
  }

  markPullRequestReconcileRequired(jobId:string):PullRequestView {
    const current=this.getPullRequest(jobId);
    if(!current)throw new DaemonError("NOT_FOUND","Pull request reservation not found");
    if(current.state==="committed"||current.state==="pushed")this.db.prepare("UPDATE pull_requests SET state='reconcile_required',updated_at=? WHERE job_id=?").run(isoNow(),jobId);
    return this.getPullRequest(jobId)!;
  }

  recordPullRequestResult(jobId:string,result:{state:"open"|"merged"|"closed";headSha:string;number:number;url:string;bodyHash?:string|null;mergedAt?:string|null;mergeCommit?:string|null}):PullRequestView {
    if(!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result.headSha)||!Number.isSafeInteger(result.number)||result.number<=0)throw new DaemonError("STATE_CONFLICT","Pull request result identity is invalid");
    return this.transaction(() => {
      const row=this.db.prepare("SELECT * FROM pull_requests WHERE job_id=?").get(jobId) as Row|undefined;
      if(!row)throw new DaemonError("NOT_FOUND","Pull request reservation not found");
      const current=this.pullRequestView(row);
      const mergedAt=result.mergedAt??null,mergeCommit=result.mergeCommit??null;
      const mergeFieldsValid=result.state==="merged"
        ? typeof mergedAt==="string"&&Number.isFinite(Date.parse(mergedAt))&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(mergeCommit??"")
        : mergedAt===null&&mergeCommit===null;
      if(result.url!==`https://github.com/${current.repository}/pull/${result.number}`
        ||result.bodyHash!==undefined&&result.bodyHash!==null&&!/^[0-9a-f]{64}$/.test(result.bodyHash)
        ||!mergeFieldsValid) {
        throw new DaemonError("STATE_CONFLICT","Pull request result fields are invalid");
      }
      if(current.headSha&&current.headSha!==result.headSha)throw new DaemonError("STATE_CONFLICT","Pull request remote head changed");
      if(current.number!==null&&current.number!==result.number||current.url!==null&&current.url!==result.url)throw new DaemonError("STATE_CONFLICT","Pull request remote identity changed");
      const allowed:Record<PullRequestState,readonly ("open"|"merged"|"closed")[]>={
        reserved:[],committed:[],pushed:["open","merged","closed"],reconcile_required:["open","merged","closed"],
        open:["open","merged","closed"],merged:["merged"],closed:["closed"],
      };
      if(!allowed[current.state].includes(result.state))throw new DaemonError("STATE_CONFLICT",`Pull request cannot move from ${current.state} to ${result.state}`);
      const at=isoNow();
      this.db.prepare(`UPDATE pull_requests SET state=?,head_sha=?,number=?,url=?,body_sha256=coalesce(?,body_sha256),merged_at=?,merge_commit=?,updated_at=? WHERE job_id=?`)
        .run(result.state,result.headSha,result.number,result.url,result.bodyHash??null,mergedAt,mergeCommit,at,jobId);
      const wasPublished=["open","merged","closed"].includes(current.state);
      if(!wasPublished&&!this.db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='pull_request.opened' LIMIT 1").get(jobId)) {
        this.insertEvent(current.roomId,jobId,"pull_request.opened",{number:result.number,url:result.url,headSha:result.headSha},at);
      }
      if(current.state==="open"&&result.state==="merged"&&!this.db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='pull_request.merged' LIMIT 1").get(jobId)) {
        this.insertEvent(current.roomId,jobId,"pull_request.merged",{number:result.number,url:result.url,headSha:result.headSha,mergeCommit:result.mergeCommit??null},at);
      }
      return this.getPullRequest(jobId)!;
    });
  }

  createRoom(
    id: string,
    title: string,
    projectId: string,
    workflowId: string,
    sessionId?: string,
    createdAt = isoNow(),
  ): void {
    const session = sessionId === undefined
      ? this.defaultSessionFor(projectId, workflowId, createdAt)
      : this.requireSession(sessionId, projectId, workflowId);
    this.db
      .prepare("INSERT INTO rooms(id,title,project_id,workflow_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, title, projectId, workflowId, session, createdAt, createdAt);
    this.insertEvent(id, null, "room.created", { title, projectId, workflowId, sessionId: session }, createdAt);
  }

  /** The session a room lands in when the caller named none: one per (project, workflow), created on demand. */
  defaultSessionFor(projectId: string, workflowId: string, createdAt = isoNow()): string {
    const existing = this.db
      .prepare("SELECT id FROM sessions WHERE project_id=? AND workflow_id=? AND is_default=1")
      .get(projectId, workflowId) as Row | undefined;
    if (existing) return text(existing, "id");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO sessions(id,title,project_id,workflow_id,is_default,created_at,updated_at) VALUES(?,?,?,?,1,?,?)")
      .run(id, workflowId, projectId, workflowId, createdAt, createdAt);
    return id;
  }

  createSession(title: string, projectId: string, workflowId: string, createdAt = isoNow()): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO sessions(id,title,project_id,workflow_id,is_default,created_at,updated_at) VALUES(?,?,?,?,0,?,?)")
      .run(id, title, projectId, workflowId, createdAt, createdAt);
    return id;
  }

  /** A session belongs to exactly one (project, workflow); a room may not be filed across that boundary. */
  requireSession(sessionId: string, projectId: string, workflowId: string): string {
    const row = this.db.prepare("SELECT project_id, workflow_id FROM sessions WHERE id=?").get(sessionId) as Row | undefined;
    if (!row) throw new DaemonError("INVALID_REQUEST", `Unknown session ${sessionId}`);
    if (text(row, "project_id") !== projectId || text(row, "workflow_id") !== workflowId) {
      throw new DaemonError("INVALID_REQUEST", `Session ${sessionId} belongs to a different project or workflow`);
    }
    return sessionId;
  }

  /**
   * The room in a session that a new task can join: not archived, and with no job left running or queued.
   * A room with a live job is excluded deliberately -- chaining onto it sets `predecessorPending`, which
   * would hold the new task behind work it has nothing to do with, so a busy session gets a second room.
   */
  idleRoomIn(sessionId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT r.id FROM rooms r
         WHERE r.session_id=? AND r.archived=0
           AND NOT EXISTS(SELECT 1 FROM jobs live WHERE live.room_id=r.id
             AND live.state IN ('queued','starting','running','cancel_requested'))
         ORDER BY r.updated_at DESC, r.id DESC LIMIT 1`,
      )
      .get(sessionId) as Row | undefined;
    return row ? text(row, "id") : null;
  }

  listSessions(projectId?: string): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, count(r.id) AS room_count,
                sum(CASE WHEN r.archived=0 THEN 1 ELSE 0 END) AS active_room_count,
                max(r.updated_at) AS last_room_at
         FROM sessions s LEFT JOIN rooms r ON r.session_id=s.id
         WHERE (? IS NULL OR s.project_id=?)
         GROUP BY s.id`,
      )
      .all(projectId ?? null, projectId ?? null) as Row[];
    return rows
      .map((row) => ({
        id: text(row, "id"),
        title: text(row, "title"),
        projectId: text(row, "project_id"),
        workflowId: text(row, "workflow_id"),
        roomCount: number(row, "room_count"),
        activeRoomCount: Number(row.active_room_count ?? 0),
        createdAt: text(row, "created_at"),
        lastActivityAt: typeof row.last_room_at === "string" ? row.last_room_at : text(row, "updated_at"),
      }))
      .sort((left, right) => (left.lastActivityAt < right.lastActivityAt ? 1 : left.lastActivityAt > right.lastActivityAt ? -1 : 0));
  }

  setRoomArchived(roomId: string, archived: boolean): void {
    this.db.prepare("UPDATE rooms SET archived=? WHERE id=?").run(archived ? 1 : 0, roomId);
  }

  setRoomPinned(roomId: string, pinned: boolean): void {
    this.db.prepare("UPDATE rooms SET pinned=? WHERE id=?").run(pinned ? 1 : 0, roomId);
  }

  private migrateToVersion7(): void {
    this.transaction(() => {
      this.db.exec(`
      ALTER TABLE jobs ADD COLUMN requested_tier TEXT;
      ALTER TABLE jobs ADD COLUMN grade TEXT;
      ALTER TABLE jobs ADD COLUMN grade_note TEXT;
      ALTER TABLE jobs ADD COLUMN cause TEXT;
      CREATE TABLE routing_policy (
        key TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('claude','codex')),
        workflow_id TEXT NOT NULL,
        charter TEXT,
        tier TEXT NOT NULL,
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      `);
      this.migrationHooks.afterStatements?.(7);
      this.db.exec("PRAGMA user_version=7");
    });
    this.migrationHooks.afterCommit?.(7);
  }

  private migrateToVersion8(): void {
    this.transaction(() => {
      this.db.exec(`
        ALTER TABLE jobs ADD COLUMN role TEXT NOT NULL DEFAULT 'work' CHECK(role IN ('work','review'));
        ALTER TABLE jobs ADD COLUMN review_of TEXT REFERENCES jobs(id);
        ALTER TABLE jobs ADD COLUMN review_round INTEGER;
        ALTER TABLE jobs ADD COLUMN review_commit TEXT;
        ALTER TABLE jobs ADD COLUMN evidence_complete INTEGER;
        ALTER TABLE jobs ADD COLUMN verdict TEXT;
        ALTER TABLE jobs ADD COLUMN review_json TEXT;
        ALTER TABLE jobs ADD COLUMN review_skipped TEXT;
        ALTER TABLE jobs ADD COLUMN grade_source TEXT;
        ALTER TABLE jobs ADD COLUMN end_fingerprint TEXT;
        ALTER TABLE jobs ADD COLUMN parent_job_id TEXT REFERENCES jobs(id);
        ALTER TABLE jobs ADD COLUMN parent_fingerprint TEXT;
        CREATE UNIQUE INDEX jobs_review_round_idx ON jobs(review_of, review_round) WHERE review_of IS NOT NULL;
        ALTER TABLE turns ADD COLUMN role TEXT NOT NULL DEFAULT 'work';
        ALTER TABLE routing_policy ADD COLUMN evidence_job_ids TEXT;
        CREATE TABLE artifacts_v8 (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('result','provider_log','gate_log','export','evidence')),
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          path TEXT NOT NULL
        );
        INSERT INTO artifacts_v8(id,job_id,kind,name,media_type,size,path) SELECT id,job_id,kind,name,media_type,size,path FROM artifacts;
        DROP TABLE artifacts;
        ALTER TABLE artifacts_v8 RENAME TO artifacts;
        -- Historical grades have no recoverable caller provenance; leave source NULL.
        PRAGMA user_version=8;
      `);
    });
  }

  createJob(input: NewJob, turnId: string): void {
    this.transaction(() => {
      this.requireQueueCapacity(1,input.roomId);
    const now = input.createdAt ?? isoNow();
    const role = input.role ?? "work";
    const executionKind = input.executionKind ?? (role === 'review' ? 'review' : 'foreground');
    const foreground = isForegroundExecution(executionKind);
    const expectedRole = executionKind === 'review' || executionKind === 'rollout_review' ? 'review' : 'work';
    if (role !== expectedRole) throw new DaemonError('INVALID_REQUEST','Execution kind and role disagree');
    if (foreground && input.taskLink === 'none') throw new DaemonError('INVALID_REQUEST','Foreground executions require task admission');
    if (!foreground && input.taskLink === 'inherit') throw new DaemonError('INVALID_REQUEST','Auxiliary executions cannot inherit tasks');
    const detached = !foreground;
    const parentId = input.predecessorJobId ?? input.parentJobId ?? input.retryOfJobId ?? input.reviewOf;
    const parent = parentId ? this.getJob(parentId) : null;
    const taskId = detached ? null : input.taskId ?? parent?.taskId ?? (foreground ? input.id : null);
    if (executionKind === 'promotion' && (!input.promotionOf || !input.rolloutGroupId || !taskId || !this.db.prepare('SELECT id FROM tasks WHERE id=?').get(taskId))) throw new DaemonError('INVALID_REQUEST','Promotion requires a candidate, group and existing task');
    const owned = taskId ? this.db.prepare("SELECT workdir FROM tasks WHERE id=?").get(taskId) : null;
    if (foreground && owned?.workdir && input.cwd && owned.workdir !== input.cwd) throw new DaemonError("WORKTREE_CONFLICT", "Task workdir is fixed; create a new task for a different candidate worktree");
    if (foreground && taskId && this.db.prepare("SELECT id FROM rollout_groups WHERE task_id=? AND state IN ('running','paused','promoting') AND id IS NOT ?").get(taskId,input.rolloutGroupId ?? null)) throw new DaemonError('STATE_CONFLICT','Task is reserved by an active rollout group');
    this.db
      .prepare(
        `INSERT INTO jobs(id,room_id,provider,project_id,workflow_id,state,prompt,created_at,updated_at,retry_of_job_id,source_job_id,depth,
         tier,model,effort,charter,cwd,escalated_from,resume_thread_id,gates_json,requested_tier,
         role,review_of,review_round,review_commit,evidence_complete,review_json,parent_job_id,parent_fingerprint,predecessor_pending,requested_model)
         VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.roomId,
        input.provider,
        input.projectId,
        input.workflowId,
        input.prompt,
        now,
        now,
        input.retryOfJobId ?? null,
        input.sourceJobId ?? null,
        input.depth ?? 0,
        input.tier ?? null,
        input.model ?? null,
        input.effort ?? null,
        input.charter ?? null,
        input.cwd ?? null,
        input.escalatedFrom ?? null,
        input.resumeThreadId ?? null,
        input.gates ? JSON.stringify(input.gates) : null,
        input.requestedTier ?? null,
        role,
        input.reviewOf ?? null,
        input.reviewRound ?? null,
        input.reviewCommit ?? null,
        input.evidenceComplete === undefined || input.evidenceComplete === null ? null : input.evidenceComplete ? 1 : 0,
        input.review ? JSON.stringify(input.review) : null,
        input.parentJobId ?? null,
        input.parentFingerprint ?? null,
        input.predecessorPending ? 1 : 0,
        input.model ?? null,
      );
    this.db.prepare(`UPDATE jobs SET execution_kind=?,arm_source=?,resolved_model=?,requested_model=?,model_identity=?,
      rollout_group_id=?,promotion_of=?,review_retry_of=?,predecessor_job_id=? WHERE id=?`).run(executionKind,input.armSource ?? (input.requestedTier ? 'explicit' : 'legacy_unknown'),input.resolvedModel ?? input.model ?? null,input.requestedModel === undefined ? input.model ?? null : input.requestedModel,input.modelIdentity ?? (input.provider==='codex'&&(input.resolvedModel??input.model)&&input.tier?'configured_unverified':'legacy_unknown'),input.rolloutGroupId ?? null,input.promotionOf ?? null,input.reviewRetryOf ?? null,parentId ?? null,input.id);
    if (taskId) {
      this.db.prepare("INSERT OR IGNORE INTO tasks(id,room_id,provider,latest_job_id,state,phase,workdir,created_at,updated_at,source) VALUES(?,?,?,?,'working','Queued',?,?,?,'reported')")
        .run(taskId, input.roomId, input.provider, input.id, input.cwd ?? null, now, now);
      this.db.prepare("UPDATE jobs SET task_id=? WHERE id=?").run(taskId, input.id);
      if (foreground) this.db.prepare("UPDATE tasks SET latest_job_id=?,provider=?,state='working',phase='Queued',blocker=NULL,next_action=NULL,updated_at=?,revision=revision+1 WHERE id=?").run(input.id, input.provider, now, taskId);
    }
    if (input.evaluation) this.db.prepare("UPDATE jobs SET evaluation_json=?,evaluation_state='pending' WHERE id=?").run(JSON.stringify({ ...input.evaluation, baselineJobId: input.evaluation.baselineJobId ?? input.id }), input.id);
    this.db
      .prepare(
        "INSERT INTO turns(id,job_id,room_id,author,recipient,body,created_at,status,role) VALUES(?,?,?,?,?,?,?,'pending',?)",
      )
      .run(turnId, input.id, input.roomId, "human", input.provider, input.displayPrompt ?? input.prompt, now, role);
    this.db.prepare("UPDATE rooms SET updated_at=? WHERE id=?").run(now, input.roomId);
    this.insertEvent(
      input.roomId,
      input.id,
      "job.queued",
      { provider: input.provider, tier: input.tier ?? null, model: input.model ?? null, effort: input.effort ?? null, role },
      now,
    );
    });
  }


  setThreadId(jobId: string, threadId: string): void {
    this.db.prepare("UPDATE jobs SET thread_id=? WHERE id=?").run(threadId, jobId);
  }

  setReportedModel(jobId: string, model: string, matchesDispatch?: boolean): void {
    this.db.prepare(`UPDATE jobs SET reported_model=?,model_identity=CASE
      WHEN ?=1 OR lower(trim(resolved_model))=lower(trim(?)) THEN 'reported' ELSE 'mismatch' END WHERE id=?`).run(model, matchesDispatch ? 1 : 0, model, jobId);
  }

  setResumeThread(jobId: string, threadId: string, prompt: string): void {
    this.db.prepare("UPDATE jobs SET resume_thread_id=?,prompt=? WHERE id=? AND state='queued'").run(threadId, prompt, jobId);
  }

  setEvaluationReport(jobId: string, report: EvaluationReport): void {
    this.db.prepare("UPDATE jobs SET evaluation_report_json=? WHERE id=?").run(JSON.stringify(report), jobId);
    const job = this.getJob(jobId)!;
    this.insertEvent(job.roomId, jobId, "evaluation.report", report);
  }

  setEvaluationEvidence(jobId: string, hash: string): void {
    this.db.prepare("UPDATE jobs SET evaluation_evidence_hash=? WHERE id=?").run(hash, jobId);
    const job = this.getJob(jobId)!;
    this.insertEvent(job.roomId, jobId, "evaluation.evidence", { hash });
  }

  recordAcceptance(jobId: string, decision: NonNullable<EvaluationView["decision"]>): void {
    this.db.prepare("UPDATE jobs SET acceptance_json=? WHERE id=?").run(JSON.stringify(decision), jobId);
    const job = this.getJob(jobId)!;
    this.insertEvent(job.roomId, jobId, "evaluation.decision", decision);
  }

  /** Most recent work job in a room for a provider, whatever its state; followups inherit its spec. Reviewers are never targets. */
  latestJob(roomId: string, provider: Provider): StoredJob | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE room_id=? AND provider=? AND execution_kind IN ('foreground','promotion') ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(roomId, provider) as Row | undefined;
    return row ? this.storedJob(row) : null;
  }

  /** Reviewer with the highest round for a work job. */
  latestReview(workerJobId: string): StoredJob | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE review_of=? ORDER BY review_round DESC LIMIT 1")
      .get(workerJobId) as Row | undefined;
    return row ? this.storedJob(row) : null;
  }

  getRolloutGroup(id: string): StoredRolloutGroup | null {
    const row = this.db.prepare('SELECT * FROM rollout_groups WHERE id=?').get(id);
    if (!row) return null;
    return { id: String(row.id), roomId: String(row.room_id), taskId: nullableText(row, 'task_id'),
      workerJobId: String(row.parent_job_id), reviewerJobId: String(row.reviewer_job_id), state: row.state as StoredRolloutGroup['state'],
      canonical: { fingerprint: String(row.parent_fingerprint), contentHash: String(row.content_hash) },
      candidateIds: this.rolloutMembers(id).filter(job => job.executionKind === 'rollout_candidate').map(job => job.id),
      winnerJobId: nullableText(row, 'winner_job_id'), promotionJobId: nullableText(row, 'promotion_job_id'),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), round: Number(row.round), requested: Number(row.requested),
      reviewsBudget: Number(row.reviews_budget), reviewsSpent: Number(row.reviews_spent), startCommit: String(row.start_commit), baselinePath: String(row.baseline_path) };
  }

  rolloutGroupForJob(jobId: string): StoredRolloutGroup | null {
    const row = this.db.prepare(`SELECT id FROM rollout_groups WHERE parent_job_id=? OR reviewer_job_id=?
      OR id=(SELECT rollout_group_id FROM jobs WHERE id=?) ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(jobId, jobId, jobId);
    return row ? this.getRolloutGroup(String(row.id)) : null;
  }

  rolloutMembers(groupId: string): StoredJob[] {
    return this.db.prepare('SELECT id FROM jobs WHERE rollout_group_id=? ORDER BY created_at,rowid').all(groupId).map(row => this.getJob(String(row.id))!);
  }

  rolloutView(jobId: string): { group: RolloutGroupView | null; candidates: RolloutCandidateView[] } {
    if (!this.getJob(jobId)) throw new DaemonError('NOT_FOUND', `Job not found: ${jobId}`);
    const stored = this.rolloutGroupForJob(jobId);
    if (!stored) return { group: null, candidates: [] };
    const { round, requested, reviewsBudget, reviewsSpent, startCommit, baselinePath, ...group } = stored;
    return { group, candidates: group.candidateIds.map(id => { const job = this.getJob(id)!;
      return { jobId: id, state: job.state, reviewOutcome: this.latestReview(id)?.reviewOutcome ?? null, contentHash: job.endContentHash }; }) };
  }

  nextReviewRound(workerJobId: string): number {
    const row = this.db.prepare("SELECT coalesce(max(review_round),0)+1 AS next FROM jobs WHERE review_of=?").get(workerJobId) as Row;
    return number(row, "next");
  }

  /**
   * What each provider/tier a charter has run on has actually done: jobs run, jobs a ladder escalated into, and jobs
   * graded good. Keyed `provider/tier` so a ladder's rungs can be looked up directly.
   */
  ladderCounts(charter: string): Map<string, { ran: number; laddered: number; approved: number }> {
    const rows = this.db
      .prepare(
        `SELECT provider, tier,
                count(*) AS ran,
                sum(CASE WHEN escalated_from IS NOT NULL THEN 1 ELSE 0 END) AS laddered,
                sum(CASE WHEN grade='good' THEN 1 ELSE 0 END) AS approved
           FROM jobs WHERE charter=? AND execution_kind IN ('foreground','promotion') AND tier IS NOT NULL GROUP BY provider, tier`,
      )
      .all(charter) as Row[];
    return new Map(
      rows.map((row) => [
        `${text(row, "provider")}/${text(row, "tier")}`,
        { ran: number(row, "ran"), laddered: number(row, "laddered"), approved: number(row, "approved") },
      ]),
    );
  }

  /** Work job created in the room after the given moment, whether a human follow-up or an automatic continuation. */
  laterWorkJob(roomId: string, createdAt: string): StoredJob | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE room_id=? AND execution_kind IN ('foreground','promotion') AND created_at>? ORDER BY created_at LIMIT 1")
      .get(roomId, createdAt) as Row | undefined;
    return row ? this.storedJob(row) : null;
  }

  evidencePath(workerJobId: string): string | null {
    const row = this.db.prepare("SELECT path FROM artifacts WHERE job_id=? AND kind='evidence' AND name='review-evidence.md' LIMIT 1").get(workerJobId) as Row | undefined;
    return row ? text(row, "path") : null;
  }

  setVerdict(jobId: string, verdict: Verdict): void {
    this.db.prepare("UPDATE jobs SET verdict=? WHERE id=?").run(verdict, jobId);
  }

  setReviewOutcome(jobId: string, outcome: StoredJob['reviewOutcome'], verdict: StoredJob['verdictJson'] = null): void {
    this.db.prepare('UPDATE jobs SET review_outcome=?,verdict_json=? WHERE id=?').run(outcome, verdict ? JSON.stringify(verdict) : null, jobId);
  }

  setEndFingerprint(jobId: string, fingerprint: string): void {
    this.db.prepare("UPDATE jobs SET end_fingerprint=? WHERE id=?").run(fingerprint, jobId);
  }

  setReviewSkipped(jobId: string, reason: string | null): void {
    this.db.prepare("UPDATE jobs SET review_skipped=? WHERE id=?").run(reason, jobId);
  }

  getJob(id: string): StoredJob | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Row | undefined;
    return row ? this.storedJob(row) : null;
  }

  getJobSummary(id: string): JobSummary {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new DaemonError("NOT_FOUND", `Job not found: ${id}`);
    return this.jobSummary(row);
  }

  getRoomRow(id: string): Row | null {
    return (this.db.prepare("SELECT * FROM rooms WHERE id=?").get(id) as Row | undefined) ?? null;
  }

  getPendingTurn(jobId: string): Row | null {
    return (
      (this.db
        .prepare("SELECT * FROM turns WHERE job_id=? AND author='human' ORDER BY created_at DESC LIMIT 1")
        .get(jobId) as Row | undefined) ?? null
    );
  }

  /**
   * One page of the queue in arrival order; pass the previous page's last job to read the next one. created_at
   * has millisecond resolution and id is a random UUID, so a created_at tie is broken by rowid (insertion order):
   * breaking it by id dispatched two jobs created in the same millisecond in random order.
   */
  queuedJobs(limit: number, after: StoredJob | null = null): StoredJob[] {
    return (this.db
      .prepare(
        "SELECT * FROM jobs WHERE state='queued' AND (created_at, rowid) > (?, coalesce((SELECT rowid FROM jobs WHERE id=?), 0)) ORDER BY created_at, rowid LIMIT ?",
      )
      .all(after?.createdAt ?? "", after?.id ?? "", limit) as Row[]).map((row) => this.storedJob(row));
  }

  countQueued(): number {
    return number(this.db.prepare("SELECT count(*) AS total FROM jobs WHERE state='queued'").get() as Row, "total");
  }

  queueCapacityReason(additional: number,roomId?:string): string | null {
    if(!Number.isInteger(additional)||additional<0)throw new DaemonError('INVALID_REQUEST','Queue reservation must be a nonnegative integer');
    const queued = this.countQueued();
    if(queued+additional>this.maxQueuedJobs)return `Global queue holds ${queued} jobs and has room for ${Math.max(0,this.maxQueuedJobs-queued)} more (limit ${this.maxQueuedJobs})`;
    if(roomId){const roomQueued=Number(this.db.prepare("SELECT count(*) AS n FROM jobs WHERE room_id=? AND state='queued'").get(roomId)!.n);
      if(roomQueued+additional>MAX_QUEUED_PER_ROOM)return `Room ${roomId} queue holds ${roomQueued} jobs (limit ${MAX_QUEUED_PER_ROOM})`;}
    return null;
  }

  requireQueueCapacity(additional: number,roomId?:string): void {
    const reason = this.queueCapacityReason(additional,roomId);
    if (reason) throw new DaemonError("QUEUE_FULL", `${reason}; wait for some to finish`);
  }

  countActive(): number {
    const row = this.db
      .prepare(`SELECT count(*) AS total FROM (
        SELECT id AS job_id FROM jobs WHERE state IN ('starting','running','cancel_requested')
        UNION
        SELECT DISTINCT job_id FROM execution_leases WHERE state IN ('prepared','running','reconcile_required')
      )`)
      .get() as Row;
    return number(row, "total");
  }

  transitionJob(id: string, expected: JobState[], next: JobState, extra: Partial<{
    failure: FailureInfo | null;
    result: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  }> = {}): void {
    this.transaction(() => {
      const current = this.getJob(id);
      if (!current) throw new DaemonError("NOT_FOUND", `Job not found: ${id}`);
      if (!expected.includes(current.state) || !canTransition(current.state, next)) {
        throw new DaemonError("STATE_CONFLICT", `Cannot transition job ${id} from ${current.state} to ${next}`);
      }
      const now = isoNow();
      const result = this.db
        .prepare(
          `UPDATE jobs SET state=?, failure_json=?, result=COALESCE(?,result), started_at=COALESCE(?,started_at),
           finished_at=?, updated_at=? WHERE id=? AND state=?`,
        )
        .run(
          next,
          extra.failure ? JSON.stringify(extra.failure) : null,
          extra.result ?? null,
          extra.startedAt ?? null,
          extra.finishedAt ?? null,
          now,
          id,
          current.state,
        );
      if (Number(result.changes) !== 1) throw new DaemonError("STATE_CONFLICT", `Job ${id} changed concurrently`);
      this.db.prepare("UPDATE rooms SET updated_at=? WHERE id=?").run(now, current.roomId);
      this.insertEvent(current.roomId, id, `job.${next}`, extra.failure ?? {}, now);
      if (next === 'running' && current.tier && current.role === 'work' && current.executionKind !== 'promotion') {
        this.ensureArms(current.provider, current.workflowId, current.charter, [current.tier]);
        this.db.prepare('UPDATE routing_arms SET last_used_at=? WHERE key=? AND tier=?')
          .run(now, routingKey(current.provider, current.workflowId, current.charter), current.tier);
      }
      if (TERMINAL_JOB_STATES.has(next)) this.observeRouting(id);
    });
  }

  /** Records the raw routing facts of a finished job as an event, then lets the policy for its key evolve. */
  private observeRouting(jobId: string): void {
    const job = this.getJob(jobId);
    if (!job || !TERMINAL_JOB_STATES.has(job.state)) return;
    const cause = failureCause(job.state, job.failure, job.grade);
    this.db.prepare("UPDATE jobs SET cause=? WHERE id=?").run(cause, jobId);
    const tokens = this.db
      .prepare(
        `SELECT SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(CASE WHEN input_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN 1 ELSE 0 END) AS measured_attempts,
                SUM(CASE WHEN input_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN MAX(0, input_tokens - cached_input_tokens) ELSE 0 END) AS uncached_input_tokens
         FROM attempts WHERE job_id=?`,
      )
      .get(jobId) as Row;
    const changed = this.db.prepare("SELECT count(*) AS total FROM changes WHERE job_id=?").get(jobId) as Row;
    const durationMs =
      job.startedAt && job.finishedAt ? Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt)) : null;
    const tokenMeasuredAttempts = Number(tokens.measured_attempts ?? 0);
    const arm = this.listRoutingArms(routingKey(job.provider, job.workflowId, job.charter)).find(arm => arm.tier === job.tier);
    const observation: RoutingObservation = {
      armSource: job.armSource,
      armMean: arm ? arm.alpha / (arm.alpha + arm.beta) : null,
      requestedModel: job.requestedModel,
      reportedModel: job.reportedModel,
      jobId: job.id,
      roomId: job.roomId,
      provider: job.provider,
      projectId: job.projectId,
      workflowId: job.workflowId,
      charter: job.charter,
      cwd: job.cwd,
      requestedTier: job.requestedTier,
      tier: job.tier,
      model: job.model,
      effort: job.effort,
      state: job.state as RoutingObservation["state"],
      failureCode: job.failure?.code ?? null,
      cause,
      inputTokens: tokens.input_tokens === null ? null : number(tokens, "input_tokens"),
      // input - cached, clamped at 0, summed only over attempts that recorded a cache figure; null when none did.
      // Claude's stored input_tokens already includes cache reads/writes, and codex's is assumed to (inferred, not
      // proven) -- see providerLineUsage, apps/daemon/src/daemon.ts:734-755.
      uncachedInputTokens: tokenMeasuredAttempts > 0 ? number(tokens, "uncached_input_tokens") : null,
      outputTokens: tokens.output_tokens === null ? null : number(tokens, "output_tokens"),
      durationMs,
      changedFiles: number(changed, "total"),
      escalatedFrom: job.escalatedFrom,
      retryOfJobId: job.retryOfJobId,
      threadId: job.threadId,
      grade: job.grade,
    };
    this.insertEvent(job.roomId, job.id, "routing.observation.v1", observation, job.finishedAt ?? isoNow());
    if (this.routingBandit?.enabled) this.updateRoutingReward(jobId);
    else if (isForegroundExecution(job.executionKind)) this.evolveRouting({ ...job, cause });
  }

  /**
   * A verdict on a finished job; a bad grade on a green job is a capability failure the gates missed. A reviewer's grade
   * never replaces a human's, and a human grade re-checks any promotion that leaned on this job as evidence. A
   * reviewer refutation on incomplete evidence is recorded as the grade but is no routing cause.
   */
  gradeJob(jobId: string, grade: Grade, note: string | null, source: GradeSource = "human", evidenceComplete = true): JobSummary {
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job) throw new DaemonError("NOT_FOUND", `Job not found: ${jobId}`);
      if (!TERMINAL_JOB_STATES.has(job.state)) throw new DaemonError("STATE_CONFLICT", "Only finished jobs can be graded");
      const priority = { agent: 0, reviewer: 1, human: 2 };
      if (job.gradeSource && priority[source] < priority[job.gradeSource]) return this.getJobSummary(jobId);
      const cause = source === 'agent' ? job.cause : source === "reviewer" && !evidenceComplete ? null : failureCause(job.state, job.failure, grade);
      const now = isoNow();
      this.db
        .prepare("UPDATE jobs SET grade=?, grade_note=?, grade_source=?, cause=?, updated_at=? WHERE id=?")
        .run(grade, note, source, cause, now, jobId);
      this.insertEvent(job.roomId, jobId, "job.graded", { jobId, grade, note, source, evidenceComplete }, now);
      // A human grade is the review the bus skipped, and until now nothing else cleared the flag: a job whose review
      // was skipped kept its room in needsAttention forever, because only a reviewer for that same job cleared it.
      if (source === "human") {
        this.setReviewSkipped(jobId, null);
        if (!this.routingBandit?.enabled) this.recheckPromotions(jobId, job.roomId);
      }
      if (this.routingBandit?.enabled) this.updateRoutingReward(jobId, source !== 'reviewer' || evidenceComplete);
      else if (source !== "agent" && job.executionKind !== 'promotion') this.evolveRouting({ ...job, grade, gradeSource: source, cause });
      if (job.executionKind === 'promotion' && job.promotionOf) {
        const group = this.getRolloutGroup(job.rolloutGroupId ?? '');
        if (group?.state === 'promoted' && group.promotionJobId === job.id && group.winnerJobId === job.promotionOf) {
          this.gradeJob(job.promotionOf, grade, note, source, evidenceComplete);
        }
      }
      return this.getJobSummary(jobId);
    });
  }

  /** Reverts a promotion whose evidence pairs no longer hold after a human graded one of the jobs in them. */
  private recheckPromotions(jobId: string, roomId: string): void {
    const rows = this.db.prepare("SELECT * FROM routing_policy WHERE evidence_job_ids LIKE ?").all(`%${jobId}%`) as Row[];
    for (const row of rows) {
      const evidence = parseJson<PromotionEvidence | null>(row.evidence_job_ids, null);
      if (!evidence) continue;
      const intact = evidence.pairs.filter(([failed, fixed]) => {
        const f = this.getJob(failed);
        const r = this.getJob(fixed);
        return f?.cause === "capability" && r?.grade === "good" && r.gradeSource === "human";
      });
      if (intact.length >= PROMOTE_PAIRS) continue;
      this.setRoutingPolicy(
        text(row, "provider") as Provider,
        text(row, "workflow_id"),
        nullableText(row, "charter"),
        evidence.from,
        `reverted to ${evidence.from}: human grade on ${jobId.slice(0, 8)} superseded the reviewer evidence behind the promotion`,
        roomId,
        jobId,
      );
    }
  }

  seedRoutingPolicy(rows: Array<{ provider: Provider; workflowId: string; charter: string | null; tier: Tier }>, reason: string): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO routing_policy(key,provider,workflow_id,charter,tier,reason,updated_at) VALUES(?,?,?,?,?,?,?)",
    );
    const now = isoNow();
    this.transaction(() => {
      for (const row of rows) {
        insert.run(routingKey(row.provider, row.workflowId, row.charter), row.provider, row.workflowId, row.charter, row.tier, reason, now);
      }
    });
  }

  /** Tier a new job runs at when the request names neither tier, model nor effort. */
  routingTier(provider: Provider, workflowId: string, charter: string | null): Tier {
    const row = this.db.prepare("SELECT tier FROM routing_policy WHERE key=?").get(routingKey(provider, workflowId, charter)) as
      | Row
      | undefined;
    return row ? (text(row, "tier") as Tier) : DEFAULT_TIER;
  }

  ensureArms(provider: Provider, workflowId: string, charter: string | null, tiers: readonly Tier[]): RoutingArm[] {
    const key = routingKey(provider, workflowId, charter);
    const policy = this.db.prepare('SELECT tier,reason FROM routing_policy WHERE key=?').get(key);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO routing_arms
      (key,provider,workflow_id,charter,tier,alpha,pinned,updated_at) VALUES(?,?,?,?,?,?,?,?)`);
    for (const tier of tiers) insert.run(key, provider, workflowId, charter, tier, policy?.tier === tier ? 3 : 1,
      policy?.tier === tier && policy.reason === 'pinned by operator' ? 1 : 0, isoNow());
    return this.listRoutingArms(key).filter(arm => tiers.includes(arm.tier));
  }

  listRoutingArms(key?: string): RoutingArm[] {
    const rows = key === undefined ? this.db.prepare('SELECT * FROM routing_arms ORDER BY key,tier').all()
      : this.db.prepare('SELECT * FROM routing_arms WHERE key=? ORDER BY tier').all(key);
    return rows.map(row => ({ key: text(row, 'key'), provider: text(row, 'provider') as Provider,
      workflowId: text(row, 'workflow_id'), charter: nullableText(row, 'charter'), tier: text(row, 'tier') as Tier,
      alpha: number(row, 'alpha'), beta: number(row, 'beta'), successes: number(row, 'successes'), failures: number(row, 'failures'),
      pinned: Boolean(row.pinned), updatedAt: text(row, 'updated_at'), lastUsedAt: nullableText(row, 'last_used_at') }));
  }

  routingArmMean(jobId: string): number | null {
    const job = this.getJob(jobId);
    if (!job || !job.tier) return null;
    const arm = this.listRoutingArms(routingKey(job.provider, job.workflowId, job.charter)).find(arm => arm.tier === job.tier);
    return arm ? arm.alpha / (arm.alpha + arm.beta) : null;
  }

  recentRoutingDispatches(provider: Provider, workflowId: string, charter: string | null, limit: number): Array<{ tier: Tier | null }> {
    return this.db.prepare(`SELECT tier FROM jobs WHERE provider=? AND workflow_id=? AND charter IS ? AND role='work'
      AND execution_kind IN ('foreground','rollout_candidate') AND started_at IS NOT NULL
      ORDER BY started_at DESC,rowid DESC LIMIT ?`).all(provider, workflowId, charter, limit)
      .reverse().map(row => ({ tier: nullableText(row, 'tier') as Tier | null }));
  }

  /** Replay the effective ledger in its original insertion order; replacement never adds an observation or decay. */
  updateRoutingReward(jobId: string, evidenceComplete = true): void {
    if (!this.routingBandit?.enabled) return;
    this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job || job.tier === null) return;
      if (job.gradeSource === 'agent') return; // Advice cannot add, retract, or replace gate evidence.
      // R3 must grade the originating candidate when promotion evidence is accepted.
      if (job.promotionOf !== null || job.executionKind === 'promotion') return;
      const gradeEvent = job.gradeSource === 'reviewer' ? this.db.prepare(`SELECT data_json FROM events
        WHERE job_id=? AND type='job.graded' ORDER BY id DESC LIMIT 1`).get(job.id) : null;
      const complete = evidenceComplete && (!gradeEvent || JSON.parse(String(gradeEvent.data_json)).evidenceComplete !== false);
      // The provider adapter resolves family aliases before marking the raw announcement as reported.
      const value = complete ? reward({ ...job,
        taskOutcome: job.result === null ? job.taskOutcome ?? null : parseTaskResult(job.result)?.outcome ?? 'unknown',
        reportedModel: job.modelIdentity === 'reported' ? job.resolvedModel : job.reportedModel }) : null;
      const existing = this.db.prepare('SELECT * FROM routing_rewards WHERE execution_job_id=?').get(job.id);
      const source = job.gradeSource === 'human' || job.gradeSource === 'reviewer' ? job.gradeSource : 'gate';
      if (!existing && value === null) return;
      if (existing && existing.reward === value) {
        this.db.prepare('UPDATE routing_rewards SET source=?,model_identity=? WHERE execution_job_id=?').run(source, job.modelIdentity, job.id);
        return;
      }
      const arm = this.ensureArms(job.provider, job.workflowId, job.charter, [job.tier])[0]!;
      const baselineRow = this.db.prepare(`SELECT id,data_json FROM events WHERE type='routing.arm.baseline'
        AND json_extract(data_json,'$.key')=? AND json_extract(data_json,'$.tier')=? ORDER BY id DESC LIMIT 1`).get(arm.key, arm.tier);
      const prior = baselineRow ? JSON.parse(String(baselineRow.data_json)) as { alpha: number; beta: number; historicalThrough?: number }
        : { alpha: Math.max(1, arm.alpha - arm.successes), beta: Math.max(1, arm.beta - arm.failures),
          historicalThrough: Number(this.db.prepare('SELECT coalesce(max(rowid),0) AS n FROM routing_rewards WHERE key=? AND tier=?').get(arm.key, arm.tier)!.n) };
      const baselineId = baselineRow ? Number(baselineRow.id)
        : this.insertEvent(null, null, 'routing.arm.baseline', { key: arm.key, tier: arm.tier, ...prior });
      if (value === null) this.db.prepare('DELETE FROM routing_rewards WHERE execution_job_id=?').run(job.id);
      else this.db.prepare(`INSERT INTO routing_rewards(execution_job_id,key,tier,source,reward,model_identity,recorded_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(execution_job_id) DO UPDATE SET source=excluded.source,reward=excluded.reward,
        model_identity=excluded.model_identity`).run(job.id, arm.key, arm.tier, source, value, job.modelIdentity, isoNow());
      this.insertEvent(job.roomId, job.id, 'routing.reward', { key: arm.key, tier: arm.tier, source, reward: value,
        previous: existing?.reward ?? null, modelIdentity: job.modelIdentity, decay: this.routingBandit!.decay });
      let updated = { ...arm, ...prior, successes: 0, failures: 0 };
      for (const row of this.db.prepare(`SELECT r.rowid AS sequence,r.reward,
        (SELECT json_extract(e.data_json,'$.decay') FROM events e WHERE e.job_id=r.execution_job_id AND e.type='routing.reward' AND e.id>?
          ORDER BY e.id LIMIT 1) AS decay FROM routing_rewards r WHERE r.key=? AND r.tier=? ORDER BY r.rowid`).all(baselineId, arm.key, arm.tier)) {
        updated = updateArm(updated, Number(row.reward) as 0 | 1,
          { decay: Number(row.sequence) <= (prior.historicalThrough ?? 0) ? 1 : Number(row.decay ?? this.routingBandit!.decay) });
      }
      this.db.prepare('UPDATE routing_arms SET alpha=?,beta=?,successes=?,failures=?,updated_at=? WHERE key=? AND tier=?')
        .run(updated.alpha, updated.beta, updated.successes, updated.failures, isoNow(), arm.key, arm.tier);
    });
  }

  unpinRouting(key: string): void {
    this.db.prepare('UPDATE routing_arms SET pinned=0,updated_at=? WHERE key=?').run(isoNow(), key);
    this.db.prepare('DELETE FROM routing_policy WHERE key=?').run(key);
    this.insertEvent(null, null, 'routing.unpinned', { key });
  }

  resetRouting(key: string, tier?: Tier): void {
    for (const arm of this.listRoutingArms(key).filter(arm => tier === undefined || arm.tier === tier)) {
      this.db.prepare('DELETE FROM routing_rewards WHERE key=? AND tier=?').run(key, arm.tier);
      this.db.prepare('UPDATE routing_arms SET alpha=1,beta=1,successes=0,failures=0,updated_at=? WHERE key=? AND tier=?')
        .run(isoNow(), key, arm.tier);
      this.insertEvent(null, null, 'routing.arm.baseline', { key, tier: arm.tier, alpha: 1, beta: 1 });
    }
    this.insertEvent(null, null, 'routing.reset', { key, tier: tier ?? null });
  }

  listRoutingPolicy(): RoutingPolicyView[] {
    const rows = this.db.prepare("SELECT * FROM routing_policy ORDER BY provider, workflow_id, charter").all() as Row[];
    return rows.map((row) => this.routingPolicyView(row));
  }

  setRoutingPolicy(
    provider: Provider,
    workflowId: string,
    charter: string | null,
    tier: Tier,
    reason: string,
    roomId: string | null,
    jobId: string | null,
    evidence: PromotionEvidence | null = null,
  ): RoutingPolicyView {
    const key = routingKey(provider, workflowId, charter);
    return this.transaction(() => {
      const before = this.db.prepare("SELECT tier FROM routing_policy WHERE key=?").get(key) as Row | undefined;
      const now = isoNow();
      this.db
        .prepare(
          `INSERT INTO routing_policy(key,provider,workflow_id,charter,tier,reason,updated_at,evidence_job_ids) VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET tier=excluded.tier, reason=excluded.reason, updated_at=excluded.updated_at,
             evidence_job_ids=excluded.evidence_job_ids`,
        )
        .run(key, provider, workflowId, charter, tier, reason, now, evidence ? JSON.stringify(evidence) : null);
      this.insertEvent(roomId, jobId, "routing.policy", { key, from: before ? text(before, "tier") : null, to: tier, reason }, now);
      if (reason === 'pinned by operator') {
        this.ensureArms(provider, workflowId, charter, [tier]);
        this.db.prepare('UPDATE routing_arms SET pinned=(tier=?),updated_at=? WHERE key=?').run(tier, now, key);
      }
      return this.routingPolicyView(this.db.prepare("SELECT * FROM routing_policy WHERE key=?").get(key) as Row);
    });
  }

  /**
   * Promotion: PROMOTE_PAIRS capability failures at the policy tier, each followed by a linked escalation one tier
   * up that was graded good, since the policy last changed. Demotion: only after DEMOTE_MIN_OBSERVATIONS finished
   * jobs for the key, and only when DEMOTE_GOOD_PROBES jobs one tier down were graded good with none bad since the
   * last change. Environmental failures count for nothing. The provider never changes by itself. Only human grades
   * count as "good"; a reviewer's refutation counts as a capability failure, so it can start a promotion pair but
   * never confirm one, and reviewer jobs themselves are outside every count.
   */
  private evolveRouting(job: StoredJob): void {
    // Routing learns only from runs whose provider identity was observed. A missing announcement or a model
    // protocol failure must not count toward either promotion evidence or demotion volume.
    if (job.reportedModel === null || job.failure?.code === "provider_protocol") return;
    const key = routingKey(job.provider, job.workflowId, job.charter);
    const policy = this.db.prepare("SELECT tier, updated_at FROM routing_policy WHERE key=?").get(key) as Row | undefined;
    const current = policy ? (text(policy, "tier") as Tier) : DEFAULT_TIER;
    const since = policy ? text(policy, "updated_at") : "";
    const scope = (alias: string) => `${alias}provider=? AND ${alias}workflow_id=? AND coalesce(${alias}charter,'-')=?`;
    const scopeArgs = [job.provider, job.workflowId, job.charter ?? "-"];
    const higher = nextTier(current);
    if (higher) {
      const pairs = this.db
        .prepare(
          `SELECT f.id AS failed, MIN(r.id) AS fixed FROM jobs f JOIN jobs r ON r.escalated_from=f.id
           WHERE ${scope("f.")} AND f.execution_kind IN ('foreground','promotion') AND f.tier=? AND f.cause='capability' AND f.created_at>=?
             AND r.tier=? AND r.grade='good' AND r.grade_source='human' AND r.state='succeeded' AND r.execution_kind IN ('foreground','promotion')
             AND f.reported_model IS NOT NULL AND r.reported_model IS NOT NULL
             AND r.provider=f.provider AND r.workflow_id=f.workflow_id AND coalesce(r.charter,'-')=coalesce(f.charter,'-')
           GROUP BY f.id ORDER BY f.created_at`,
        )
        .all(...scopeArgs, current, since, higher) as Row[];
      if (pairs.length >= PROMOTE_PAIRS) {
        const evidence = pairs.map((pair) => `${text(pair, "failed").slice(0, 8)} fixed by ${text(pair, "fixed").slice(0, 8)}`).join("; ");
        this.setRoutingPolicy(
          job.provider,
          job.workflowId,
          job.charter,
          higher,
          `promoted from ${current}: ${pairs.length} capability failures were each fixed by a graded-good retry at ${higher} (${evidence})`,
          job.roomId,
          job.id,
          { from: current, pairs: pairs.map((pair) => [text(pair, "failed"), text(pair, "fixed")]) },
        );
        return;
      }
    }
    const lower = previousTier(current);
    if (!lower) return;
    const observed = this.db
      .prepare(`SELECT count(*) AS total FROM jobs WHERE ${scope("")} AND execution_kind IN ('foreground','promotion')
        AND reported_model IS NOT NULL
        AND coalesce(json_extract(failure_json,'$.code'),'')!='provider_protocol'
        AND state IN ('succeeded','failed','cancelled')`)
      .get(...scopeArgs) as Row;
    if (number(observed, "total") < DEMOTE_MIN_OBSERVATIONS) return;
    const probes = this.db
      .prepare(
        `SELECT SUM(grade='good' AND grade_source='human') AS good,
                SUM((grade='bad' AND grade_source='human') OR cause='capability') AS bad FROM jobs
         WHERE ${scope("")} AND execution_kind IN ('foreground','promotion') AND tier=? AND created_at>=?
           AND reported_model IS NOT NULL
           AND coalesce(json_extract(failure_json,'$.code'),'')!='provider_protocol'
           AND state IN ('succeeded','failed','cancelled')`,
      )
      .get(...scopeArgs, lower, since) as Row;
    if (number(probes, "good") >= DEMOTE_GOOD_PROBES && number(probes, "bad") === 0) {
      this.setRoutingPolicy(
        job.provider,
        job.workflowId,
        job.charter,
        lower,
        `demoted from ${current}: ${number(probes, "good")} graded-good jobs at ${lower} and none bad since the last change`,
        job.roomId,
        job.id,
      );
    }
  }

  private routingPolicyView(row: Row): RoutingPolicyView {
    const provider = text(row, "provider") as Provider;
    const workflowId = text(row, "workflow_id");
    const charter = nullableText(row, "charter");
    const evidence = this.db
      .prepare(
        `SELECT count(*) AS observations, SUM(cause='capability') AS capability_failures,
                SUM(grade='good') AS good, SUM(grade='bad') AS bad
         FROM jobs WHERE provider=? AND workflow_id=? AND coalesce(charter,'-')=? AND execution_kind IN ('foreground','promotion') AND state IN ('succeeded','failed','cancelled')`,
      )
      .get(provider, workflowId, charter ?? "-") as Row;
    return {
      key: text(row, "key"),
      provider,
      workflowId,
      charter,
      tier: text(row, "tier") as Tier,
      reason: text(row, "reason"),
      updatedAt: text(row, "updated_at"),
      observations: number(evidence, "observations"),
      capabilityFailures: Number(evidence.capability_failures ?? 0),
      goodGrades: Number(evidence.good ?? 0),
      badGrades: Number(evidence.bad ?? 0),
    };
  }

  incrementAttempt(jobId: string, attemptId: string, turnId: string, fingerprint: string | null, argv: string[]): number {
    return this.transaction(() => {
      this.db.prepare("UPDATE jobs SET attempt_count=attempt_count+1,updated_at=? WHERE id=?").run(isoNow(), jobId);
      const job = this.getJob(jobId);
      if (!job) throw new DaemonError("NOT_FOUND", `Job not found: ${jobId}`);
      this.db
        .prepare(
          "INSERT INTO attempts(id,job_id,turn_id,number,state,started_at,worktree_fingerprint,argv_json) VALUES(?,?,?,?,'running',?,?,?)",
        )
        .run(attemptId, jobId, turnId, job.attemptCount, isoNow(), fingerprint, JSON.stringify(argv));
      this.insertEvent(job.roomId, jobId, "attempt.started", { attempt: job.attemptCount }, isoNow());
      return job.attemptCount;
    });
  }

  finishAttempt(
    attemptId: string,
    state: "succeeded" | "failed" | "cancelled",
    failure: FailureInfo | null,
    hadToolActivity: boolean,
    usage: TokenUsage | null,
  ): void {
    this.db
      .prepare(
        "UPDATE attempts SET state=?,finished_at=?,failure_json=?,had_tool_activity=?,input_tokens=?,cached_input_tokens=?,output_tokens=? WHERE id=? AND state='running'",
      )
      .run(
        state,
        isoNow(),
        failure ? JSON.stringify(failure) : null,
        hadToolActivity ? 1 : 0,
        usage?.inputTokens ?? null,
        usage?.cachedInputTokens ?? null,
        usage?.outputTokens ?? null,
        attemptId,
      );
  }

  completeTurn(jobId: string, state: "complete" | "failed"): void {
    this.db.prepare("UPDATE turns SET status=? WHERE job_id=? AND author='human'").run(state, jobId);
  }

  addProviderTurn(job: StoredJob, body: string, id: string): void {
    const now = isoNow();
    this.db
      .prepare(
        "INSERT INTO turns(id,job_id,room_id,author,recipient,body,created_at,status,model,effort,role) VALUES(?,?,?,?,?,?,?,'complete',?,?,?)",
      )
      .run(id, job.id, job.roomId, job.provider, "human", body, now, job.model, job.effort, job.role);
    this.db.prepare("UPDATE rooms SET updated_at=? WHERE id=?").run(now, job.roomId);
    this.insertEvent(job.roomId, job.id, "turn.completed", { turnId: id, author: job.provider }, now);
  }

  /** A complete turn that no job produced (`turns.record`): a report written elsewhere, shown in the chat. */
  recordTurn(
    id: string,
    roomId: string,
    author: "human" | Provider,
    body: string,
    model: string | null,
    effort: Effort | null,
  ): void {
    const now = isoNow();
    this.db
      .prepare(
        "INSERT INTO turns(id,job_id,room_id,author,recipient,body,created_at,status,model,effort) VALUES(?,NULL,?,?,?,?,?,'complete',?,?)",
      )
      .run(id, roomId, author, author === "human" ? "both" : "human", body, now, model, effort);
    this.db.prepare("UPDATE rooms SET updated_at=? WHERE id=?").run(now, roomId);
    this.insertEvent(roomId, null, "turn.completed", { turnId: id, author }, now);
  }

  setProgress(job: StoredJob, progress: JobProgress): void {
    this.db.prepare("UPDATE jobs SET progress_json=? WHERE id=?").run(JSON.stringify(progress), job.id);
    this.insertEvent(job.roomId, job.id, "job.progress", progress, progress.at);
  }

  acquireResources(jobId: string, resources: string[]): boolean {
    return this.transaction(() => {
      const now = isoNow();
      for (const resource of resources) {
        const conflict = this.db.prepare("SELECT job_id FROM resource_locks WHERE resource=?").get(resource) as
          | Row
          | undefined;
        if (conflict && text(conflict, "job_id") !== jobId) return false;
      }
      for (const resource of resources) {
        this.db
          .prepare("INSERT OR IGNORE INTO resource_locks(resource,job_id,acquired_at) VALUES(?,?,?)")
          .run(resource, jobId, now);
      }
      return true;
    });
  }

  releaseResources(jobId: string): boolean {
    return this.transaction(() => {
      if (this.hasUnresolvedLeases(jobId) || this.hasPendingApplication(jobId)) return false;
      this.db.prepare("DELETE FROM resource_locks WHERE job_id=?").run(jobId);
      return true;
    });
  }

  releaseTaskOwnershipIfSafe(jobId: string): boolean {
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job || !job.taskId || !isForegroundExecution(job.executionKind) || !TERMINAL_JOB_STATES.has(job.state) || !this.canReleaseTaskOwnership(job.taskId)) return false;
      return Number(this.db.prepare("DELETE FROM task_ownership WHERE task_id=?").run(job.taskId).changes) > 0;
    });
  }

  addArtifact(
    id: string,
    jobId: string,
    kind: ArtifactView["kind"],
    name: string,
    mediaType: string,
    size: number,
    path: string,
  ): void {
    this.db
      .prepare("INSERT INTO artifacts(id,job_id,kind,name,media_type,size,path) VALUES(?,?,?,?,?,?,?)")
      .run(id, jobId, kind, name, mediaType, size, path);
  }

  recordProvisionalResult(jobId: string, provisional: ProvisionalResultV1, path: string): boolean {
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job || job.state !== "running") return false;
      const prior = this.db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='job.provisional_result.v1' LIMIT 1").get(jobId);
      if (prior) return false;
      this.addArtifact(provisional.artifactId, jobId, "result", provisional.name, provisional.mediaType, provisional.size, path);
      this.insertEvent(job.roomId, jobId, "job.provisional_result.v1", provisional, isoNow());
      return true;
    });
  }

  provisionalResult(jobId: string): ProvisionalResultV1 | null {
    const row = this.db.prepare(
      "SELECT data_json FROM events WHERE job_id=? AND type='job.provisional_result.v1' ORDER BY id DESC LIMIT 1",
    ).get(jobId) as Row | undefined;
    return row ? parseJson<ProvisionalResultV1 | null>(row.data_json, null) : null;
  }

  provisionalArtifactContent(jobId: string, provisional: ProvisionalResultV1): unknown {
    const row = this.db.prepare(
      "SELECT path,size FROM artifacts WHERE id=? AND job_id=? AND kind='result' AND name=? LIMIT 1",
    ).get(provisional.artifactId, jobId, provisional.name) as Row | undefined;
    if (!row || number(row, "size") !== provisional.size) throw new DaemonError("INTERNAL", "Provisional artifact registration changed");
    const bytes = readRegularFile(text(row, "path"), 256 * 1024);
    if (bytes.length !== provisional.size || createHash("sha256").update(bytes).digest("hex") !== provisional.sha256) {
      throw new DaemonError("INTERNAL", "Provisional artifact identity changed");
    }
    return JSON.parse(bytes.toString("utf8"));
  }

  /** The name of the gate this job failed on (`protect`, `require-change`, `gate`, or a quality command), or null. */
  failedCheckName(jobId: string): string | null {
    const row = this.db
      .prepare("SELECT command_json FROM checks WHERE job_id=? AND state='failed' ORDER BY rowid DESC LIMIT 1")
      .get(jobId) as Row | undefined;
    if (!row) return null;
    const command = JSON.parse(text(row, "command_json")) as string[];
    return command[0] ?? null;
  }

  /**
   * The stored summary (stderr/stdout tail, already capped at capture time -- see `runGates`'s
   * `outcome.stderr.slice(-500)`) of the last failed check for this job, or null when no check failed
   * for this job, or the failed check carried no summary. Scoped to `jobId` so a caller reading a
   * specific job's failure never picks up a check from a different job or an earlier attempt.
   */
  failedCheckSummary(jobId: string): string | null {
    const row = this.db
      .prepare("SELECT summary FROM checks WHERE job_id=? AND state='failed' ORDER BY rowid DESC LIMIT 1")
      .get(jobId) as Row | undefined;
    return row ? nullableText(row, "summary") : null;
  }

  addCheck(id: string, jobId: string, command: string[], state: CheckView["state"], exitCode: number | null, summary: string | null): void {
    this.db
      .prepare("INSERT INTO checks(id,job_id,command_json,state,exit_code,summary) VALUES(?,?,?,?,?,?)")
      .run(id, jobId, JSON.stringify(command), state, exitCode, summary);
  }

  replaceChanges(jobId: string, changes: ChangeView[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM changes WHERE job_id=?").run(jobId);
      const insert = this.db.prepare(
        "INSERT INTO changes(job_id,path,status,additions,deletions) VALUES(?,?,?,?,?)",
      );
      for (const change of changes) {
        insert.run(jobId, change.path, change.status, change.additions, change.deletions);
      }
      const job = this.getJob(jobId);
      if (job) this.insertEvent(job.roomId, jobId, "changes.replaced", changes.map((change) => ({ ...change, jobId })));
    });
  }

  /**
   * The ordering stays `(updated_at, id)` even though rooms can be pinned. The cursor encodes exactly
   * those two values, so sorting pinned rooms first would make a page boundary disagree with the cursor
   * and silently drop or repeat rooms. `pinned` ships as a field and the client groups by it instead.
   */
  listRooms(
    limit: number,
    cursor: string | null,
    projectId?: string,
    status?: "active" | "queued" | "attention" | "completed",
    provider?: Provider,
    query?: string,
    sessionId?: string,
    includeArchived?: boolean,
  ): Page<RoomSummary> {
    const [cursorTime, cursorId] = decodeCursor(cursor);
    const search = query ? query.toLowerCase() : null;
    const rows = this.db
      .prepare(
        `SELECT r.*, max(j.created_at) AS latest_job
         FROM rooms r LEFT JOIN jobs j ON j.room_id=r.id
         WHERE (? IS NULL OR r.updated_at < ? OR (r.updated_at=? AND r.id<?)) AND (? IS NULL OR r.project_id=?)
           AND (? IS NULL OR r.session_id=?) AND (? OR r.archived=0)
           AND (? IS NULL OR EXISTS(SELECT 1 FROM jobs by_provider WHERE by_provider.room_id=r.id AND by_provider.provider=?))
           AND (? IS NULL OR instr(lower(r.title), ?) > 0)
           AND (
             ? IS NULL
             OR (?='queued' AND EXISTS(SELECT 1 FROM jobs queued_job WHERE queued_job.room_id=r.id AND queued_job.state='queued'))
             OR (?='active' AND EXISTS(SELECT 1 FROM jobs active_job WHERE active_job.room_id=r.id AND active_job.state IN ('starting','running','cancel_requested')))
             OR (?='attention' AND (
               EXISTS(SELECT 1 FROM tasks attention_task WHERE attention_task.room_id=r.id AND ${taskNeedsHuman("attention_task")})
               OR EXISTS(SELECT 1 FROM jobs attention_job WHERE attention_job.room_id=r.id AND attention_job.execution_kind IN ('foreground','promotion') AND attention_job.state IN ('failed','cancelled'))
               OR EXISTS(SELECT 1 FROM jobs attention_job WHERE attention_job.id=(SELECT latest.id FROM jobs latest WHERE latest.room_id=r.id AND latest.execution_kind IN ('foreground','promotion') ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1)
                 AND (attention_job.evaluation_state IN ('blocked','rejected') OR (attention_job.evaluation_state='pending' AND attention_job.state='succeeded' AND attention_job.evaluation_evidence_hash IS NOT NULL
                   AND (json_extract(attention_job.evaluation_json,'$.reviewRequired')=0 OR (SELECT reviewer.verdict FROM jobs reviewer WHERE reviewer.review_of=attention_job.id ORDER BY reviewer.review_round DESC LIMIT 1)='approved'))))))
             OR (?='completed' AND EXISTS(SELECT 1 FROM jobs completed_job WHERE completed_job.room_id=r.id)
               AND NOT EXISTS(SELECT 1 FROM tasks incomplete_task WHERE incomplete_task.room_id=r.id AND incomplete_task.state!='completed')
               AND NOT EXISTS(SELECT 1 FROM jobs incomplete_job WHERE incomplete_job.room_id=r.id AND incomplete_job.execution_kind IN ('foreground','promotion') AND incomplete_job.evaluation_json IS NULL AND incomplete_job.state!='succeeded')
               AND coalesce((SELECT latest.evaluation_state FROM jobs latest WHERE latest.room_id=r.id AND latest.execution_kind IN ('foreground','promotion') ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1),'accepted')='accepted')
           )
         GROUP BY r.id ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`,
      )
      .all(
        cursorTime,
        cursorTime,
        cursorTime,
        cursorId,
        projectId ?? null,
        projectId ?? null,
        sessionId ?? null,
        sessionId ?? null,
        includeArchived ? 1 : 0,
        provider ?? null,
        provider ?? null,
        search,
        search,
        status ?? null,
        status ?? null,
        status ?? null,
        status ?? null,
        status ?? null,
        limit + 1,
      ) as Row[];
    const items: RoomSummary[] = [];
    let bytes = 1024;
    for (const row of rows.slice(0, limit)) {
      const item = this.roomSummary(row);
      const size = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (bytes + size > 1024 * 1024) {
        if (!items.length) throw new DaemonError("RESPONSE_TOO_LARGE", "Room summary exceeds the read limit");
        break;
      }
      items.push(item);
      bytes += size;
    }
    const last = items.at(-1);
    return { items, nextCursor: rows.length > items.length && last ? encodeCursor(last.updatedAt, last.id) : null };
  }

  listJobs(limit: number, cursor: string | null, roomId?: string, state?: JobState, provider?: Provider): Page<JobSummary> {
    const [cursorTime, cursorId] = decodeCursor(cursor);
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE (? IS NULL OR created_at < ? OR (created_at=? AND id<?)) AND (? IS NULL OR room_id=?) AND (? IS NULL OR state=?)
         AND (? IS NULL OR provider=?)
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        cursorTime,
        cursorTime,
        cursorTime,
        cursorId,
        roomId ?? null,
        roomId ?? null,
        state ?? null,
        state ?? null,
        provider ?? null,
        provider ?? null,
        limit + 1,
      ) as Row[];
    const items = rows.slice(0, limit).map((row) => this.jobSummary(row));
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  getRoom(id: string): RoomDetail {
    const room = this.getRoomRow(id);
    if (!room) throw new DaemonError("NOT_FOUND", `Room not found: ${id}`);
    const jobs = (this.db.prepare("SELECT * FROM jobs WHERE room_id=? ORDER BY created_at").all(id) as Row[]).map((row) =>
      this.jobSummary(row),
    );
    const turns = (this.db.prepare("SELECT * FROM turns WHERE room_id=? ORDER BY created_at").all(id) as Row[]).map(
      (row): TurnView => ({
        id: text(row, "id"),
        jobId: nullableText(row, "job_id"),
        roomId: text(row, "room_id"),
        author: text(row, "author") as TurnView["author"],
        recipient: text(row, "recipient") as TurnView["recipient"],
        body: text(row, "body"),
        createdAt: text(row, "created_at"),
        status: text(row, "status") as TurnView["status"],
        model: nullableText(row, "model"),
        effort: nullableText(row, "effort") as TurnView["effort"],
        role: text(row, "role") as JobRole,
      }),
    );
    const attempts = (this.db
      .prepare("SELECT a.* FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE j.room_id=? ORDER BY a.started_at")
      .all(id) as Row[]).map(
      (row): AttemptView => ({
        id: text(row, "id"),
        jobId: text(row, "job_id"),
        turnId: text(row, "turn_id"),
        number: number(row, "number"),
        state: text(row, "state") as JobState,
        startedAt: nullableText(row, "started_at"),
        finishedAt: nullableText(row, "finished_at"),
        failure: parseJson<FailureInfo | null>(row.failure_json, null),
        hadToolActivity: row.had_tool_activity === null ? null : number(row, "had_tool_activity") === 1,
        worktreeFingerprint: nullableText(row, "worktree_fingerprint"),
        argv: parseJson<string[] | null>(row.argv_json, null),
      }),
    );
    // Independent of reads.ts's `mapped()`/coordination.ts's `getTask` (the paginated snapshot and the
    // inbox): this is the legacy full-room read's own mapping of the same `checks` table, so it goes
    // through the same shared sanitizer rather than trusting the stored summary.
    const checks = (this.db
      .prepare("SELECT c.* FROM checks c JOIN jobs j ON j.id=c.job_id WHERE j.room_id=? ORDER BY c.rowid")
      .all(id) as Row[]).map(
      (row): CheckView => ({
        id: text(row, "id"),
        jobId: text(row, "job_id"),
        command: parseJson<string[]>(row.command_json, []),
        state: text(row, "state") as CheckView["state"],
        exitCode: row.exit_code === null ? null : number(row, "exit_code"),
        summary: sanitizeStoredText(nullableText(row, "summary")),
      }),
    );
    const changes = (this.db
      .prepare("SELECT c.* FROM changes c JOIN jobs j ON j.id=c.job_id WHERE j.room_id=? ORDER BY c.path")
      .all(id) as Row[]).map(
      (row): ChangeView => ({
        jobId: text(row, "job_id"),
        path: text(row, "path"),
        status: text(row, "status") as ChangeView["status"],
        additions: row.additions === null ? null : number(row, "additions"),
        deletions: row.deletions === null ? null : number(row, "deletions"),
      }),
    );
    const artifacts = (this.db
      .prepare("SELECT a.* FROM artifacts a JOIN jobs j ON j.id=a.job_id WHERE j.room_id=? ORDER BY a.rowid")
      .all(id) as Row[]).map(
      (row): ArtifactView => ({
        id: text(row, "id"),
        jobId: text(row, "job_id"),
        kind: text(row, "kind") as ArtifactView["kind"],
        name: text(row, "name"),
        mediaType: text(row, "media_type"),
        size: number(row, "size"),
      }),
    );
    return { room: this.roomSummary(room), jobs, turns, attempts, checks, changes, artifacts, tasks: new CoordinationStore(this).list(id) };
  }

  listEvents(roomId: string | null, sinceId: number, limit: number): EventEnvelope[] {
    return (this.db
      .prepare("SELECT * FROM events WHERE id>? AND (? IS NULL OR room_id=?) ORDER BY id LIMIT ?")
      .all(sinceId, roomId, roomId, limit) as Row[]).map(
      (row): EventEnvelope => ({
        id: number(row, "id"),
        roomId: nullableText(row, "room_id"),
        jobId: nullableText(row, "job_id"),
        type: text(row, "type"),
        occurredAt: text(row, "occurred_at"),
        data: parseJson<unknown>(row.data_json, {}),
      }),
    );
  }

  jobLogs(jobId: string): Array<{ name: string; kind: string; content: string }> {
    if (!this.getJob(jobId)) throw new DaemonError("NOT_FOUND", `Job not found: ${jobId}`);
    const rows = this.db
      .prepare("SELECT name,kind,path FROM artifacts WHERE job_id=? AND kind IN ('provider_log','gate_log') ORDER BY rowid")
      .all(jobId) as Row[];
    return rows.map((row) => ({
      name: text(row, "name"),
      kind: text(row, "kind"),
      content: readFileSync(text(row, "path"), "utf8"),
    }));
  }

  /** Tokens and wall time per job, with explicit coverage when only some attempts reported usage. */
  usage(jobId?: string): { jobs: JobUsage[]; totals: UsageTotals; queueWait: QueueWaitStats } {
    const rows = this.db
      .prepare(
        `SELECT j.id, j.provider, j.state, j.attempt_count, j.created_at, j.started_at, j.finished_at, j.model, j.effort,
                COUNT(a.id) AS attempts,
                SUM(CASE WHEN a.input_tokens IS NOT NULL AND a.cached_input_tokens IS NOT NULL AND a.output_tokens IS NOT NULL THEN 1 ELSE 0 END) AS measured_attempts,
                SUM(a.input_tokens) AS input_tokens, SUM(a.cached_input_tokens) AS cached_input_tokens, SUM(a.output_tokens) AS output_tokens,
                SUM(CASE WHEN a.input_tokens IS NOT NULL AND a.cached_input_tokens IS NOT NULL AND a.output_tokens IS NOT NULL THEN MAX(0, a.input_tokens - a.cached_input_tokens) ELSE 0 END) AS uncached_input_tokens
         FROM jobs j LEFT JOIN attempts a ON a.job_id=j.id
         WHERE (? IS NULL OR j.id=?) GROUP BY j.id ORDER BY j.created_at DESC`,
      )
      .all(jobId ?? null, jobId ?? null) as Row[];
    const totals: UsageTotals = {
      jobs: rows.length,
      attempts: 0,
      measuredAttempts: 0,
      unmeasuredAttempts: 0,
      usageComplete: true,
      durationMs: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
    };
    const jobs = rows.map((row): JobUsage => {
      const started = nullableText(row, "started_at");
      const finished = nullableText(row, "finished_at");
      const durationMs = started && finished ? Math.max(0, Date.parse(finished) - Date.parse(started)) : null;
      const tokens = (column: string): number | null => (row[column] === null ? null : number(row, column));
      const measuredAttempts = Number(row.measured_attempts ?? 0);
      const usage = {
        attempts: number(row, "attempts"),
        measuredAttempts,
        unmeasuredAttempts: number(row, "attempts") - measuredAttempts,
        usageComplete: number(row, "attempts") === measuredAttempts,
        durationMs,
        queueWaitMs: queueWaitMs(row),
        inputTokens: tokens("input_tokens"),
        cachedInputTokens: tokens("cached_input_tokens"),
        // input - cached, clamped at 0, summed only over measuredAttempts; null when this job has none. See the
        // cache-inclusion note in observeRouting (this file); the derivation site is providerLineUsage
        // (apps/daemon/src/daemon.ts:734-755).
        uncachedInputTokens: measuredAttempts > 0 ? number(row, "uncached_input_tokens") : null,
        outputTokens: tokens("output_tokens"),
      };
      totals.durationMs += durationMs ?? 0;
      totals.attempts += usage.attempts;
      totals.measuredAttempts += usage.measuredAttempts;
      totals.unmeasuredAttempts += usage.unmeasuredAttempts;
      totals.usageComplete &&= usage.usageComplete;
      totals.inputTokens += usage.inputTokens ?? 0;
      totals.cachedInputTokens += usage.cachedInputTokens ?? 0;
      totals.uncachedInputTokens += usage.uncachedInputTokens ?? 0;
      totals.outputTokens += usage.outputTokens ?? 0;
      return {
        jobId: text(row, "id"),
        provider: text(row, "provider") as Provider,
        state: text(row, "state") as JobState,
        model: nullableText(row, "model"),
        effort: nullableText(row, "effort"),
        ...usage,
      };
    });
    return { jobs, totals, queueWait: summarizeQueueWait(jobs.map(job => job.queueWaitMs)) };
  }

  queueWaitStats(since: string): QueueWaitStats {
    const rows = this.db.prepare("SELECT created_at,started_at FROM jobs WHERE julianday(started_at)>=julianday(?)").all(since) as Row[];
    return summarizeQueueWait(rows.map(queueWaitMs));
  }

  insertEvent(roomId: string | null, jobId: string | null, type: string, data: unknown, at = isoNow()): number {
    const result = this.db
      .prepare("INSERT INTO events(room_id,job_id,type,occurred_at,data_json) VALUES(?,?,?,?,?)")
      .run(roomId, jobId, type, at, JSON.stringify(data));
    const id = Number(result.lastInsertRowid);
    if (roomId && (type.startsWith("task.") || type.startsWith("release."))) this.db.prepare("UPDATE rooms SET updated_at=? WHERE id=?").run(at, roomId);
    if (roomId && (/^job\.(queued|succeeded|failed|cancelled|graded)$/.test(type) || type.startsWith("task.") || type.startsWith("review.") || type.startsWith("evaluation."))) {
      const rows = this.db.prepare("SELECT * FROM jobs WHERE room_id=? AND evaluation_json IS NOT NULL").all(roomId) as Row[];
      for (const row of rows) {
        const view = evaluationView(this.storedJob(row), this.reviewView(row));
        this.db.prepare("UPDATE jobs SET evaluation_state=? WHERE id=?").run(view!.state, text(row, "id"));
        this.db.prepare("INSERT INTO events(room_id,job_id,type,occurred_at,data_json) VALUES(?,?,'evaluation.updated',?,?)").run(roomId, text(row, "id"), at, JSON.stringify(view));
      }
      if (rows.length) this.db.prepare("UPDATE rooms SET updated_at=? WHERE id=?").run(at, roomId);
    }
    return id;
  }

  integrityCheck(): string {
    const row = this.db.prepare("PRAGMA quick_check").get() as Row;
    return String(Object.values(row)[0]);
  }

  diagnostics(): {
    schema: { version: number | null; expected: number; ok: boolean };
    database: { path: string; writable: boolean; error: string | null };
  } {
    let version: number | null = null;
    try {
      const value = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
      if (Number.isInteger(value) && value >= 0) version = value;
    } catch {}
    let probe: DatabaseSync | null = null;
    let transaction = false;
    let writable = false;
    let error: string | null = null;
    try {
      accessSync(this.path, fsConstants.R_OK | fsConstants.W_OK);
      accessSync(dirname(this.path), fsConstants.R_OK | fsConstants.W_OK);
      probe = new DatabaseSync(this.path);
      const row = probe.prepare("PRAGMA quick_check").get() as Row;
      if (String(Object.values(row)[0]) !== "ok") throw new Error("Database quick_check failed");
      probe.exec("BEGIN IMMEDIATE");
      transaction = true;
      probe.exec("ROLLBACK");
      transaction = false;
      writable = true;
    } catch (cause) {
      error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 400);
    } finally {
      if (transaction) { try { probe?.exec("ROLLBACK"); } catch {} }
      try { probe?.close(); } catch {}
    }
    return {
      schema: { version, expected: SCHEMA_VERSION, ok: version === SCHEMA_VERSION },
      database: { path: this.path, writable, error },
    };
  }

  exportData(roomId?: string): Record<string, unknown> {
    const coordination = {
      ...Object.fromEntries(["tasks", "release_candidates", "release_authorizations", "release_operations"].map((table) => [table,
        this.db.prepare(`SELECT * FROM ${table} WHERE (? IS NULL OR room_id=?)`).all(roomId ?? null, roomId ?? null)])),
      task_controls: this.db.prepare("SELECT c.* FROM task_controls c JOIN tasks t ON t.id=c.task_id WHERE (? IS NULL OR t.room_id=?)").all(roomId ?? null, roomId ?? null),
      task_ownership: this.db.prepare("SELECT o.* FROM task_ownership o JOIN tasks t ON t.id=o.task_id WHERE (? IS NULL OR t.room_id=?)").all(roomId ?? null, roomId ?? null),
      release_targets: this.db.prepare("SELECT t.* FROM release_targets t JOIN release_operations o ON o.id=t.operation_id WHERE (? IS NULL OR o.room_id=?)").all(roomId ?? null, roomId ?? null),
      event_consumers: this.db.prepare("SELECT * FROM event_consumers WHERE (? IS NULL OR room_id=?)").all(roomId ?? null, roomId ?? null),
    };
    if (!roomId) {
      const tables = ["rooms", "jobs", "turns", "attempts", "events", "checks", "changes"] as const;
      return {
        ...coordination,
        ...Object.fromEntries(tables.map((table) => [table, this.db.prepare(`SELECT * FROM ${table}`).all()])),
        artifacts: this.db.prepare("SELECT id,job_id,kind,name,media_type,size FROM artifacts").all(),
      };
    }
    if (!this.getRoomRow(roomId)) throw new DaemonError("NOT_FOUND", `Room not found: ${roomId}`);
    return {
      ...coordination,
      rooms: this.db.prepare("SELECT * FROM rooms WHERE id=?").all(roomId),
      jobs: this.db.prepare("SELECT * FROM jobs WHERE room_id=?").all(roomId),
      turns: this.db.prepare("SELECT * FROM turns WHERE room_id=?").all(roomId),
      attempts: this.db
        .prepare("SELECT a.* FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE j.room_id=?")
        .all(roomId),
      events: this.db.prepare("SELECT * FROM events WHERE room_id=?").all(roomId),
      checks: this.db
        .prepare("SELECT c.* FROM checks c JOIN jobs j ON j.id=c.job_id WHERE j.room_id=?")
        .all(roomId),
      changes: this.db
        .prepare("SELECT c.* FROM changes c JOIN jobs j ON j.id=c.job_id WHERE j.room_id=?")
        .all(roomId),
      artifacts: this.db
        .prepare(
          "SELECT a.id,a.job_id,a.kind,a.name,a.media_type,a.size FROM artifacts a JOIN jobs j ON j.id=a.job_id WHERE j.room_id=?",
        )
        .all(roomId),
    };
  }

  importLegacy(snapshot: LegacySnapshot, ids: { roomId: string; jobId: string; turnIds: string[]; attemptIds: string[] }): boolean {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT 1 FROM legacy_imports WHERE source_job_id=?").get(snapshot.sourceJobId);
      if (existing) return false;
      const createdAt = snapshot.room.createdAt ?? snapshot.job.createdAt ?? isoNow();
      const updatedAt = snapshot.room.updatedAt ?? snapshot.job.finishedAt ?? createdAt;
      this.db
        .prepare("INSERT INTO rooms(id,title,project_id,workflow_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run(ids.roomId, snapshot.room.title, snapshot.room.projectId, snapshot.room.workflowId, createdAt, updatedAt);
      const job = snapshot.job;
      this.db
        .prepare(
          `INSERT INTO jobs(id,room_id,provider,project_id,workflow_id,state,prompt,result,attempt_count,failure_json,
           created_at,updated_at,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          ids.jobId,
          ids.roomId,
          job.provider,
          snapshot.room.projectId,
          snapshot.room.workflowId,
          job.state,
          job.prompt ?? "",
          job.result ?? null,
          snapshot.attempts?.length ?? 0,
          job.failure ? JSON.stringify(job.failure) : null,
          job.createdAt ?? createdAt,
          job.finishedAt ?? updatedAt,
          job.startedAt ?? null,
          job.finishedAt ?? null,
        );
      for (const [index, turn] of (snapshot.turns ?? []).entries()) {
        this.db
          .prepare(
            "INSERT INTO turns(id,job_id,room_id,author,recipient,body,created_at,status) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            ids.turnIds[index] as string,
            ids.jobId,
            ids.roomId,
            turn.author,
            turn.recipient,
            turn.body,
            turn.createdAt ?? createdAt,
            turn.status ?? "complete",
          );
      }
      const fallbackTurnId = ids.turnIds[0];
      for (const [index, attempt] of (snapshot.attempts ?? []).entries()) {
        const turnId = fallbackTurnId;
        if (!turnId) break;
        this.db
          .prepare(
            `INSERT INTO attempts(id,job_id,turn_id,number,state,started_at,finished_at,failure_json,had_tool_activity,worktree_fingerprint)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            ids.attemptIds[index] as string,
            ids.jobId,
            turnId,
            attempt.number,
            attempt.state,
            attempt.startedAt ?? null,
            attempt.finishedAt ?? null,
            attempt.failure ? JSON.stringify(attempt.failure) : null,
            attempt.hadToolActivity === null ? null : attempt.hadToolActivity ? 1 : 0,
            attempt.worktreeFingerprint ?? null,
          );
      }
      for (const event of snapshot.events ?? []) {
        this.insertEvent(ids.roomId, ids.jobId, event.type, event.data ?? {}, event.occurredAt ?? createdAt);
      }
      this.insertEvent(ids.roomId, ids.jobId, "legacy.imported", { sourceJobId: snapshot.sourceJobId }, isoNow());
      this.db
        .prepare("INSERT INTO legacy_imports(source_job_id,room_id,job_id,imported_at) VALUES(?,?,?,?)")
        .run(snapshot.sourceJobId, ids.roomId, ids.jobId, isoNow());
      return true;
    });
  }

  roomSummary(row: Row): RoomSummary {
    const id = text(row, "id");
    const counts = this.db
      .prepare("SELECT state,count(*) AS total FROM jobs WHERE room_id=? GROUP BY state")
      .all(id) as Row[];
    const jobCounts = Object.fromEntries(counts.map((count) => [text(count, "state"), number(count, "total")])) as RoomSummary["jobCounts"];
    // A failed work job, a refutation nobody has answered yet (no later work job in the room), or a succeeded
    // work job whose review was skipped, needs a human.
    const attention = this.db
      .prepare(
        `SELECT count(*) AS total FROM jobs w WHERE w.room_id=? AND w.execution_kind IN ('foreground','promotion') AND (w.state IN ('failed','cancelled')
           OR (w.grade='bad' AND w.grade_source='reviewer'
               AND NOT EXISTS(SELECT 1 FROM jobs later WHERE later.room_id=w.room_id AND later.execution_kind IN ('foreground','promotion') AND later.created_at>w.created_at))
           OR (w.state='succeeded' AND w.review_skipped IS NOT NULL))`,
      )
      .get(id) as Row;
    const reviewer = this.db
      .prepare("SELECT state, review_outcome FROM jobs WHERE room_id=? AND execution_kind='review' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(id) as Row | undefined;
    let review: RoomReviewState | null = null;
    if (reviewer) {
      const state = text(reviewer, "state") as JobState;
      review = TERMINAL_JOB_STATES.has(state) ? ((nullableText(reviewer, "review_outcome") as RoomReviewState | null) ?? "reviewer_failed") : "pending";
    }
    const latestWork = this.db.prepare("SELECT * FROM jobs WHERE room_id=? AND execution_kind IN ('foreground','promotion') ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id) as Row | undefined;
    const evaluation = latestWork ? evaluationView(this.storedJob(latestWork), this.reviewView(latestWork)) : null;
    const taskCounts = Object.fromEntries(this.db.prepare("SELECT state,count(*) AS total FROM tasks WHERE room_id=? GROUP BY state").all(id).map((count) => [text(count, "state"), number(count, "total")])) as NonNullable<RoomSummary["taskCounts"]>;
    const taskAttention = this.db.prepare(`SELECT 1 FROM tasks t WHERE t.room_id=? AND ${taskNeedsHuman("t")} LIMIT 1`).get(id);
    const preview = this.db.prepare("SELECT id FROM tasks WHERE room_id=? ORDER BY CASE state WHEN 'awaiting_decision' THEN 0 WHEN 'blocked' THEN 1 WHEN 'checkpointed' THEN 2 WHEN 'working' THEN 3 ELSE 4 END,updated_at DESC,rowid DESC LIMIT 1").get(id);
    const tasks = preview ? [new CoordinationStore(this).getTask(text(preview, "id"))] : [];
    return {
      id,
      title: text(row, "title"),
      projectId: text(row, "project_id"),
      sessionId: text(row, "session_id"),
      archived: Boolean(row.archived),
      pinned: Boolean(row.pinned),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
      jobCounts,
      tasks,
      taskCounts,
      needsAttention: Boolean(taskAttention) || number(attention, "total") > 0 || (evaluation ? evaluationNeedsAttention(evaluation) : false),
      review,
      evaluation: evaluation ? { ...evaluation, report: null } : null,
    };
  }

  /** The latest review of a work job as its `review` field: a reviewer job, a skip reason, or nothing. */
  private reviewView(row: Row): ReviewView | null {
    if (text(row, "role") !== "work") return null;
    let reviewer = this.db
      .prepare("SELECT * FROM jobs WHERE review_of=? ORDER BY review_round DESC LIMIT 1")
      .get(text(row, "id")) as Row | undefined;
    if (!reviewer && row.execution_kind === 'promotion' && row.review_input_hash) {
      reviewer = this.db.prepare(`SELECT j.* FROM jobs j JOIN rollout_groups g ON g.id=?
        WHERE g.state='promoted' AND g.promotion_job_id=? AND g.winner_job_id=? AND j.review_of=g.winner_job_id
        AND j.execution_kind='rollout_review' AND j.state='succeeded' AND j.review_outcome='approved'
        AND j.review_input_hash=? ORDER BY j.review_round DESC LIMIT 1`).get(String(row.rollout_group_id), String(row.id), String(row.promotion_of), String(row.review_input_hash)) as Row | undefined;
    }
    if (reviewer) {
      return {
        jobId: text(reviewer, "id"),
        provider: text(reviewer, "provider") as Provider,
        tier: nullableText(reviewer, "tier") as Tier | null,
        model: nullableText(reviewer, "model"),
        effort: nullableText(reviewer, "effort") as ReviewView["effort"],
        state: text(reviewer, "state") as JobState,
        verdict: nullableText(reviewer, "verdict") as Verdict | null,
        outcome: nullableText(reviewer, 'review_outcome') as StoredJob['reviewOutcome'],
        reasons: parseJson<StoredJob['verdictJson']>(reviewer.verdict_json, null)?.reasons ?? [],
        round: number(reviewer, "review_round"),
        skipped: nullableText(row, 'review_skipped'),
      };
    }
    const skipped = nullableText(row, "review_skipped");
    if (!skipped) return null;
    return { jobId: null, provider: null, tier: null, model: null, effort: null, state: null, verdict: null, round: 0, skipped };
  }

  private jobSummary(row: Row): JobSummary {
    const result = nullableText(row, "result");
    return {
      executionKind: text(row,'execution_kind') as StoredJob['executionKind'],
      reviewOutcome: nullableText(row,'review_outcome') as StoredJob['reviewOutcome'],
      verdictJson: parseJson<StoredJob['verdictJson']>(row.verdict_json,null),
      armSource: text(row,'arm_source') as StoredJob['armSource'],
      resolvedModel: nullableText(row,'resolved_model'),
      modelIdentity: text(row,'model_identity') as StoredJob['modelIdentity'],
      rolloutGroupId: nullableText(row,'rollout_group_id'),
      promotionOf: nullableText(row,'promotion_of'),
      taskId: nullableText(row, "task_id"),
      task: row.task_id ? new CoordinationStore(this).getTask(String(row.task_id)) : null,
      requestedModel: nullableText(row, "requested_model"),
      reportedModel: nullableText(row, "reported_model"),
      predecessorJobId: nullableText(row, "predecessor_job_id"),
      usage: this.jobUsageSummary(row),
      id: text(row, "id"),
      roomId: text(row, "room_id"),
      provider: text(row, "provider") as Provider,
      state: text(row, "state") as JobState,
      workflowId: text(row, "workflow_id"),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
      startedAt: nullableText(row, "started_at"),
      finishedAt: nullableText(row, "finished_at"),
      currentAttempt: number(row, "attempt_count"),
      failure: parseJson<FailureInfo | null>(row.failure_json, null),
      resultPreview: result ? result.slice(0, 240) : null,
      tier: nullableText(row, "tier") as JobSummary["tier"],
      model: nullableText(row, "model"),
      effort: nullableText(row, "effort") as JobSummary["effort"],
      charter: nullableText(row, "charter"),
      escalatedFrom: nullableText(row, "escalated_from"),
      progress: parseJson<JobProgress | null>(row.progress_json, null),
      grade: nullableText(row, "grade") as Grade | null,
      gradeSource: nullableText(row, "grade_source") as GradeSource | null,
      gradeNote: nullableText(row, "grade_note"),
      role: text(row, "role") as JobRole,
      reviewOf: nullableText(row, "review_of"),
      reviewRound: row.review_round === null ? null : number(row, "review_round"),
      verdict: nullableText(row, "verdict") as Verdict | null,
      review: this.reviewView(row),
      evaluation: evaluationView(this.storedJob(row), this.reviewView(row)),
    };
  }

  private storedJob(row: Row): StoredJob {
    return {
      executionKind: text(row,'execution_kind') as StoredJob['executionKind'],
      reviewOutcome: nullableText(row,'review_outcome') as StoredJob['reviewOutcome'],
      verdictJson: parseJson<StoredJob['verdictJson']>(row.verdict_json,null),
      reviewRetryOf: nullableText(row,'review_retry_of'),
      armSource: text(row,'arm_source') as StoredJob['armSource'],
      resolvedModel: nullableText(row,'resolved_model'),
      modelIdentity: text(row,'model_identity') as StoredJob['modelIdentity'],
      rolloutGroupId: nullableText(row,'rollout_group_id'),
      rolloutRank: row.rollout_rank == null ? null : number(row,'rollout_rank'),
      rolloutOutcome: nullableText(row,'rollout_outcome') as StoredJob['rolloutOutcome'],
      promotionOf: nullableText(row,'promotion_of'),
      executionBaselinePath: nullableText(row,'execution_baseline_path'),
      endContentHash: nullableText(row,'end_content_hash'),
      reviewInputHash: nullableText(row,'review_input_hash'),
      sandbox: parseJson<Record<string,unknown> | null>(row.sandbox_json,null),
      jobDeltaPath: nullableText(row,'job_delta_path'),
      taskId: nullableText(row, "task_id"),
      taskOutcome: row.task_id ? new CoordinationStore(this).getTask(String(row.task_id)).state : null,
      predecessorJobId: nullableText(row, "predecessor_job_id"),
      evaluation: parseJson<EvaluationSpec | null>(row.evaluation_json, null),
      evaluationReport: parseJson<EvaluationReport | null>(row.evaluation_report_json, null),
      acceptanceDecision: parseJson<EvaluationView["decision"]>(row.acceptance_json, null),
      evaluationEvidenceHash: nullableText(row, "evaluation_evidence_hash"),
      id: text(row, "id"),
      roomId: text(row, "room_id"),
      provider: text(row, "provider") as Provider,
      projectId: text(row, "project_id"),
      workflowId: text(row, "workflow_id"),
      state: text(row, "state") as JobState,
      prompt: text(row, "prompt"),
      result: nullableText(row, "result"),
      attemptCount: number(row, "attempt_count"),
      failure: parseJson<FailureInfo | null>(row.failure_json, null),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
      startedAt: nullableText(row, "started_at"),
      finishedAt: nullableText(row, "finished_at"),
      retryOfJobId: nullableText(row, "retry_of_job_id"),
      depth: number(row, "depth"),
      sourceJobId: nullableText(row, "source_job_id"),
      tier: nullableText(row, "tier") as StoredJob["tier"],
      model: nullableText(row, "model"),
      effort: nullableText(row, "effort") as StoredJob["effort"],
      charter: nullableText(row, "charter"),
      cwd: nullableText(row, "cwd"),
      gates: parseJson<JobGates | null>(row.gates_json, null),
      threadId: nullableText(row, "thread_id"),
      resumeThreadId: nullableText(row, "resume_thread_id"),
      requestedModel: nullableText(row, "requested_model"),
      reportedModel: nullableText(row, "reported_model"),
      escalatedFrom: nullableText(row, "escalated_from"),
      requestedTier: nullableText(row, "requested_tier") as StoredJob["requestedTier"],
      grade: nullableText(row, "grade") as Grade | null,
      gradeSource: nullableText(row, "grade_source") as GradeSource | null,
      gradeNote: nullableText(row, "grade_note"),
      cause: nullableText(row, "cause") as FailureCause | null,
      role: text(row, "role") as JobRole,
      review: parseJson<ReviewSpec | null>(row.review_json, null),
      reviewOf: nullableText(row, "review_of"),
      reviewRound: row.review_round === null ? null : number(row, "review_round"),
      reviewCommit: nullableText(row, "review_commit"),
      evidenceComplete: row.evidence_complete === null ? null : number(row, "evidence_complete") === 1,
      verdict: nullableText(row, "verdict") as Verdict | null,
      reviewSkipped: nullableText(row, "review_skipped"),
      endFingerprint: nullableText(row, "end_fingerprint"),
      parentJobId: nullableText(row, "parent_job_id"),
      parentFingerprint: nullableText(row, "parent_fingerprint"),
      predecessorPending: number(row, "predecessor_pending") === 1,
    };
  }

  private jobUsageSummary(row: Row): JobUsageSummary {
    const aggregate = this.db.prepare(
      `SELECT COUNT(*) AS attempts,
              SUM(CASE WHEN input_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN 1 ELSE 0 END) AS measured_attempts,
              SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(CASE WHEN input_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN MAX(0, input_tokens - cached_input_tokens) ELSE 0 END) AS uncached_input_tokens
         FROM attempts WHERE job_id=?`,
    ).get(text(row, "id")) as Row;
    const attempts = number(aggregate, "attempts");
    const measuredAttempts = Number(aggregate.measured_attempts ?? 0);
    const started = nullableText(row, "started_at");
    const finished = nullableText(row, "finished_at");
    return {
      attempts,
      measuredAttempts,
      unmeasuredAttempts: attempts - measuredAttempts,
      usageComplete: attempts === measuredAttempts,
      durationMs: started && finished ? Math.max(0, Date.parse(finished) - Date.parse(started)) : null,
      queueWaitMs: queueWaitMs(row),
      inputTokens: aggregate.input_tokens === null ? null : number(aggregate, "input_tokens"),
      cachedInputTokens: aggregate.cached_input_tokens === null ? null : number(aggregate, "cached_input_tokens"),
      // input - cached, clamped at 0, summed only over measuredAttempts; null when this job has none. See the
      // cache-inclusion note in observeRouting (this file); the derivation site is providerLineUsage
      // (apps/daemon/src/daemon.ts:734-755).
      uncachedInputTokens: measuredAttempts > 0 ? number(aggregate, "uncached_input_tokens") : null,
      outputTokens: aggregate.output_tokens === null ? null : number(aggregate, "output_tokens"),
    };
  }
}
