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
