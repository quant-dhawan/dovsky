CREATE TABLE rooms (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            project_id TEXT NOT NULL,
            workflow_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          , session_id TEXT REFERENCES sessions(id), archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0);
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
          , depth INTEGER NOT NULL DEFAULT 0, tier TEXT, model TEXT, effort TEXT, charter TEXT, cwd TEXT, thread_id TEXT, escalated_from TEXT REFERENCES jobs(id), resume_thread_id TEXT, gates_json TEXT, progress_json TEXT, requested_tier TEXT, grade TEXT, grade_note TEXT, cause TEXT, role TEXT NOT NULL DEFAULT 'work' CHECK(role IN ('work','review')), review_of TEXT REFERENCES jobs(id), review_round INTEGER, review_commit TEXT, evidence_complete INTEGER, verdict TEXT, review_json TEXT, review_skipped TEXT, grade_source TEXT, end_fingerprint TEXT, parent_job_id TEXT REFERENCES jobs(id), parent_fingerprint TEXT, evaluation_json TEXT, evaluation_report_json TEXT, evaluation_evidence_hash TEXT, acceptance_json TEXT, evaluation_state TEXT, task_id TEXT REFERENCES tasks(id), predecessor_job_id TEXT REFERENCES jobs(id), predecessor_pending INTEGER NOT NULL DEFAULT 0, requested_model TEXT, reported_model TEXT);
CREATE INDEX jobs_room_idx ON jobs(room_id, created_at);
CREATE INDEX jobs_state_idx ON jobs(state, created_at);
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
            worktree_fingerprint TEXT, argv_json TEXT, input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER,
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
CREATE TABLE "turns" (
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
            , role TEXT NOT NULL DEFAULT 'work');
CREATE INDEX turns_room_idx ON turns(room_id, created_at);
CREATE TABLE routing_policy (
        key TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('claude','codex')),
        workflow_id TEXT NOT NULL,
        charter TEXT,
        tier TEXT NOT NULL,
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , evidence_job_ids TEXT);
CREATE UNIQUE INDEX jobs_review_round_idx ON jobs(review_of, review_round) WHERE review_of IS NOT NULL;
CREATE TABLE "artifacts" (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('result','provider_log','gate_log','export','evidence')),
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          path TEXT NOT NULL
        );
CREATE TABLE tasks (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), provider TEXT NOT NULL,
    latest_job_id TEXT NOT NULL REFERENCES jobs(id), state TEXT NOT NULL, phase TEXT NOT NULL,
    blocker TEXT, next_action TEXT, workdir TEXT, revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
CREATE INDEX jobs_task_idx ON jobs(task_id);
CREATE TABLE task_controls (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL,
    kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
    delivered_at TEXT, delivered_job_id TEXT REFERENCES jobs(id),
    acknowledged_at TEXT, acknowledged_job_id TEXT REFERENCES jobs(id),
    delivery_actor TEXT, acknowledgment_actor TEXT, UNIQUE(task_id,sequence)
  );
CREATE TABLE task_ownership (workdir TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id));
CREATE TABLE event_consumers (id TEXT PRIMARY KEY, room_id TEXT, acknowledged INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0);
CREATE TABLE daemon_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE release_candidates (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, room_id TEXT NOT NULL,
    identity_hash TEXT NOT NULL, data_json TEXT NOT NULL,
    UNIQUE(task_id, identity_hash)
  );
CREATE TABLE release_authorizations (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, room_id TEXT NOT NULL,
    decision_key TEXT NOT NULL UNIQUE, data_json TEXT NOT NULL
  );
CREATE TABLE release_operations (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, room_id TEXT NOT NULL,
    semantic_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN
      ('prepared','executing','verified','not_applied','reconcile_required','cancelled')),
    data_json TEXT NOT NULL
  );
CREATE TABLE release_targets (
    target TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES release_operations(id),
    owner_token TEXT NOT NULL
  );
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
CREATE INDEX rooms_session_idx ON rooms(session_id, updated_at);
PRAGMA user_version=13;
