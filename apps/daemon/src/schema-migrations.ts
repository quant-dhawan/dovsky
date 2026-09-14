import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 18;
/** Dependency-injected test hooks; never read from config, environment or RPC input. */
export interface MigrationHooks {
  afterStatements?(version: number): void;
  afterCommit?(version: number): void;
}
type Transaction = <T>(callback: () => T) => T;

// Frozen historical domains: future protocol changes require a new migration.
const V14_REVIEW = ["approved", "refuted", "inconclusive", "reviewer_failed", "protocol_failed"] as const;
const V16_ROLLOUT = ["running", "paused", "promoting", "promoted", "exhausted", "cancelled", "stale", "failed"] as const;
export const V18_JOB_ENUMS = {
  tier: ["quick", "routine", "hard", "frontier"], requested_tier: ["quick", "routine", "hard", "frontier"],
  effort: ["low", "medium", "high", "xhigh", "max"], grade: ["good", "bad"], grade_source: ["human", "reviewer", "agent"],
  verdict: ["approved", "refuted", "inconclusive"], evaluation_state: ["pending", "blocked", "accepted", "rejected"],
  review_outcome: V14_REVIEW, rollout_outcome: V16_ROLLOUT,
  arm_source: ["explicit", "inherited", "bandit", "ladder-floor", "operator-pinned", "charter-fixed", "legacy_unknown"],
  execution_kind: ["foreground", "review", "rollout_candidate", "rollout_review", "promotion"],
  model_identity: ["reported", "configured_unverified", "mismatch", "legacy_unknown"],
} as const;
const values = (items: readonly string[]): string => items.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
const identifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function enumTriggers(table: string, column: string, domain: readonly string[]): string {
  return ["INSERT", "UPDATE"].map((operation) => `CREATE TRIGGER ${table}_${column}_${operation.toLowerCase()}
    BEFORE ${operation} ON ${table} WHEN NEW.${column} IS NOT NULL AND NEW.${column} NOT IN (${values(domain)})
    BEGIN SELECT RAISE(ABORT, 'invalid ${column}'); END;`).join("\n");
}

function rebuildWithEnums(db: DatabaseSync, table: "jobs" | "attempts", enums: Record<string, readonly string[]>): void {
  for (const [column, domain] of Object.entries(enums)) {
    const bad = db.prepare(`SELECT id,${identifier(column)} AS value FROM ${table} WHERE ${identifier(column)} IS NOT NULL AND ${identifier(column)} NOT IN (${values(domain)}) LIMIT 1`).get();
    if (bad) throw new Error(`Migration 18 refuses (${String(bad.id)}, ${column}, ${JSON.stringify(bad.value)})`);
  }
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (typeof row?.sql !== "string") throw new Error(`Missing historical table ${table}`);
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table);
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND sql IS NOT NULL").all(table);
  const replacement = `${table}_v18`;
  const constraints = Object.entries(enums).map(([column, domain]) => `CHECK(${identifier(column)} IN (${values(domain)}))`);
  const ddl = row.sql.replace(/^CREATE TABLE\s+(?:"[^"]+"|\w+)/i, `CREATE TABLE ${replacement}`).replace(/\)\s*$/, `,\n${constraints.join(",\n")}\n)`);
  db.exec(ddl);
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => identifier(String(column.name))).join(",");
  db.exec(`INSERT INTO ${replacement}(${columns}) SELECT ${columns} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${replacement} RENAME TO ${table};`);
  for (const index of indexes) db.exec(String(index.sql));
  for (const trigger of triggers) {
    if (!/^jobs_(review_outcome|rollout_outcome)_(insert|update)$/.test(String(trigger.name))) db.exec(String(trigger.sql));
  }
}

export function migrateFoundation(db: DatabaseSync, transaction: Transaction, hooks: MigrationHooks = {}): void {
  const starting = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  if (starting < 13 || starting > SCHEMA_VERSION) throw new Error(`Foundation requires schema 13–18, received ${starting}`);
  const migrate = (version: number, body: () => void): void => {
    if (starting >= version) return;
    transaction(() => { body(); hooks.afterStatements?.(version); db.exec(`PRAGMA user_version=${version}`); });
    hooks.afterCommit?.(version);
  };
  migrate(14, () => db.exec(`
    ALTER TABLE jobs ADD COLUMN review_outcome TEXT;
    ALTER TABLE jobs ADD COLUMN verdict_json TEXT;
    ALTER TABLE jobs ADD COLUMN review_retry_of TEXT REFERENCES jobs(id);
    UPDATE jobs SET review_outcome=CASE WHEN role='review' AND state IN ('failed','cancelled') THEN
        CASE WHEN json_extract(CASE WHEN json_valid(failure_json) THEN failure_json ELSE '{}' END,'$.code')='review_protocol' THEN 'protocol_failed' ELSE 'reviewer_failed' END
      WHEN role='review' AND verdict IN (${values(V14_REVIEW.slice(0, 3))}) THEN verdict
      WHEN role='review' AND state='succeeded' THEN 'protocol_failed' ELSE NULL END;
    ${enumTriggers("jobs", "review_outcome", V14_REVIEW)}
    CREATE INDEX jobs_review_outcome_idx ON jobs(review_of,review_outcome);
  `));
  migrate(15, () => db.exec(`
    ALTER TABLE jobs ADD COLUMN arm_source TEXT NOT NULL DEFAULT 'legacy_unknown';
    ALTER TABLE jobs ADD COLUMN resolved_model TEXT;
    ALTER TABLE jobs ADD COLUMN model_identity TEXT NOT NULL DEFAULT 'legacy_unknown';
    -- model was the stored dispatch choice; never reconstruct it from today's tier table.
    UPDATE jobs SET resolved_model=model,
      model_identity=CASE WHEN length(trim(model))>0 AND length(trim(reported_model))>0
          AND lower(trim(model))=lower(trim(reported_model)) THEN 'reported'
        WHEN provider='codex' AND length(trim(model))>0 AND reported_model IS NULL
          AND tier IN ('quick','routine','hard','frontier') THEN 'configured_unverified'
        ELSE 'legacy_unknown' END;
    CREATE TABLE routing_arms (
      key TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('claude','codex')), workflow_id TEXT NOT NULL,
      charter TEXT, tier TEXT NOT NULL CHECK(tier IN ('quick','routine','hard','frontier')),
      alpha REAL NOT NULL DEFAULT 1 CHECK(alpha>0), beta REAL NOT NULL DEFAULT 1 CHECK(beta>0),
      successes INTEGER NOT NULL DEFAULT 0 CHECK(successes>=0), failures INTEGER NOT NULL DEFAULT 0 CHECK(failures>=0),
      pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)), updated_at TEXT NOT NULL, last_used_at TEXT,
      PRIMARY KEY(key,tier)
    );
    CREATE TABLE routing_rewards (
      execution_job_id TEXT PRIMARY KEY REFERENCES jobs(id), key TEXT NOT NULL, tier TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('human','reviewer','gate')), reward INTEGER NOT NULL CHECK(reward IN (0,1)),
      model_identity TEXT NOT NULL CHECK(model_identity IN ('reported','configured_unverified')),
      recorded_at TEXT NOT NULL, FOREIGN KEY(key,tier) REFERENCES routing_arms(key,tier)
    );
    INSERT INTO routing_arms(key,provider,workflow_id,charter,tier,alpha,pinned,updated_at)
      SELECT key,provider,workflow_id,charter,tier,3,
        CASE WHEN reason='pinned by operator' AND evidence_job_ids IS NULL THEN 1 ELSE 0 END,updated_at FROM routing_policy;
    INSERT OR IGNORE INTO routing_arms(key,provider,workflow_id,charter,tier,updated_at)
      SELECT provider||'/'||workflow_id||'/'||coalesce(charter,'-'),provider,workflow_id,charter,tier,updated_at FROM jobs
      WHERE role='work' AND tier IN ('quick','routine','hard','frontier') AND model_identity IN ('reported','configured_unverified');
    -- Historical human labels may themselves be backfills. Seed observed execution outcomes,
    -- never historical human authority, and retain one replaceable contribution per execution.
    INSERT INTO routing_rewards(execution_job_id,key,tier,source,reward,model_identity,recorded_at)
      SELECT id,provider||'/'||workflow_id||'/'||coalesce(charter,'-'),tier,'gate',
        CASE WHEN state='succeeded' THEN 1 ELSE 0 END,model_identity,updated_at FROM jobs
      WHERE role='work' AND tier IN ('quick','routine','hard','frontier')
        AND model_identity IN ('reported','configured_unverified') AND coalesce(grade_source,'')!='agent'
        AND ((state='succeeded' AND cause IS NULL AND failure_json IS NULL AND coalesce(grade,'')!='bad')
          OR (state='failed' AND cause='capability'
            AND json_extract(CASE WHEN json_valid(failure_json) THEN failure_json ELSE '{}' END,'$.code')='quality_gate'));
    UPDATE routing_arms SET
      successes=(SELECT count(*) FROM routing_rewards r WHERE r.key=routing_arms.key AND r.tier=routing_arms.tier AND reward=1),
      failures=(SELECT count(*) FROM routing_rewards r WHERE r.key=routing_arms.key AND r.tier=routing_arms.tier AND reward=0),
      last_used_at=(SELECT max(recorded_at) FROM routing_rewards r WHERE r.key=routing_arms.key AND r.tier=routing_arms.tier);
    UPDATE routing_arms SET alpha=alpha+successes,beta=beta+failures;
  `));
  migrate(16, () => db.exec(`
    CREATE TABLE rollout_groups (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), task_id TEXT REFERENCES tasks(id),
      parent_job_id TEXT NOT NULL REFERENCES jobs(id), reviewer_job_id TEXT NOT NULL REFERENCES jobs(id),
      round INTEGER NOT NULL, requested INTEGER NOT NULL CHECK(requested BETWEEN 1 AND 3),
      reviews_budget INTEGER NOT NULL, reviews_spent INTEGER NOT NULL DEFAULT 0,
      start_commit TEXT NOT NULL, parent_fingerprint TEXT NOT NULL, content_hash TEXT NOT NULL,
      baseline_path TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN (${values(V16_ROLLOUT)})),
      winner_job_id TEXT REFERENCES jobs(id), promotion_job_id TEXT REFERENCES jobs(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX rollout_groups_active_task_idx ON rollout_groups(task_id) WHERE task_id IS NOT NULL AND state IN ('running','paused','promoting');
    ALTER TABLE jobs ADD COLUMN execution_kind TEXT NOT NULL DEFAULT 'foreground';
    UPDATE jobs SET execution_kind='review' WHERE role='review';
    ALTER TABLE jobs ADD COLUMN rollout_group_id TEXT REFERENCES rollout_groups(id);
    ALTER TABLE jobs ADD COLUMN rollout_rank INTEGER;
    ALTER TABLE jobs ADD COLUMN rollout_outcome TEXT;
    ALTER TABLE jobs ADD COLUMN promotion_of TEXT REFERENCES jobs(id);
    ALTER TABLE jobs ADD COLUMN execution_baseline_path TEXT;
    ALTER TABLE jobs ADD COLUMN end_content_hash TEXT;
    ALTER TABLE jobs ADD COLUMN review_input_hash TEXT;
    ${enumTriggers("jobs", "rollout_outcome", V16_ROLLOUT)}
    CREATE INDEX jobs_rollout_idx ON jobs(rollout_group_id,execution_kind);
  `));
  migrate(17, () => db.exec(`
    CREATE TABLE pull_requests (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id), room_id TEXT NOT NULL REFERENCES rooms(id),
      repository TEXT NOT NULL, remote TEXT NOT NULL, base_branch TEXT NOT NULL, branch TEXT NOT NULL,
      start_commit TEXT NOT NULL, head_sha TEXT, number INTEGER, url TEXT,
      state TEXT NOT NULL CHECK(state IN ('reserved','committed','pushed','open','merged','closed','reconcile_required')),
      merged_at TEXT, merge_commit TEXT, tree_fingerprint TEXT NOT NULL, content_hash TEXT NOT NULL,
      evidence_hash TEXT NOT NULL, body_sha256 TEXT, intent_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(repository,branch)
    );
  `));
  if (starting < 18) {
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      migrate(18, () => {
        db.exec(`
          ALTER TABLE jobs ADD COLUMN sandbox_json TEXT;
          ALTER TABLE jobs ADD COLUMN job_delta_path TEXT;
          ALTER TABLE execution_leases ADD COLUMN scope_unit TEXT;
          ALTER TABLE execution_leases ADD COLUMN cgroup_path TEXT;
          ALTER TABLE release_operations ADD COLUMN scope_unit TEXT;
          ALTER TABLE release_operations ADD COLUMN cgroup_path TEXT;
          ALTER TABLE release_operations ADD COLUMN pid INTEGER;
          ALTER TABLE release_operations ADD COLUMN process_group INTEGER;
          ALTER TABLE release_operations ADD COLUMN process_start_ticks TEXT;
          ALTER TABLE release_operations ADD COLUMN boot_id TEXT;
          ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy_unknown' CHECK(source IN ('reported','backfill','legacy_unknown'));
          UPDATE tasks SET source='backfill' WHERE state='unknown' AND phase='legacy execution; outcome not reported';
          CREATE TABLE operations_v18 (
            principal TEXT NOT NULL DEFAULT 'operator', idempotency_key TEXT NOT NULL, method TEXT NOT NULL,
            request_hash TEXT NOT NULL, response_json TEXT, created_at TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'completed' CHECK(state IN ('pending','completed')),
            reserved_at TEXT NOT NULL, operation_id TEXT,
            PRIMARY KEY(principal,idempotency_key), CHECK(state!='completed' OR response_json IS NOT NULL)
          );
          INSERT INTO operations_v18(principal,idempotency_key,method,request_hash,response_json,created_at,state,reserved_at)
            SELECT 'operator',idempotency_key,method,request_hash,response_json,created_at,'completed',created_at FROM operations;
          DROP TABLE operations; ALTER TABLE operations_v18 RENAME TO operations;
          CREATE TABLE provider_quota (
            provider TEXT PRIMARY KEY CHECK(provider IN ('claude','codex')), reading_json TEXT NOT NULL,
            recorded_at TEXT NOT NULL, window_minutes REAL NOT NULL CHECK(window_minutes>0)
          );
        `);
        rebuildWithEnums(db, "jobs", V18_JOB_ENUMS);
        rebuildWithEnums(db, "attempts", { state: ["running", "succeeded", "failed", "cancelled"] });
        db.exec("CREATE INDEX jobs_started_idx ON jobs(started_at)");
        const violations = db.prepare("PRAGMA foreign_key_check").all();
        if (violations.length) throw new Error(`Migration 18 foreign-key violations: ${JSON.stringify(violations)}`);
      });
    } finally { db.exec("PRAGMA foreign_keys=ON"); }
  }
}
