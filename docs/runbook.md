# Operations runbook

## Prepare an isolated candidate

Never build in a directory loaded by a running service. In a clean candidate checkout:

```sh
npm ci
npm run build
npm run typecheck
npm test
DOVSKY_REQUIRE_SANDBOX=1 node --test eval/scenarios.test.mjs
DOVSKY_REQUIRE_SANDBOX=1 node eval/acceptance-smoke.mjs
```

Native checks require Linux user namespaces, bubblewrap, and a usable systemd
user manager. They use disposable repositories, sockets, homes, and scopes; they
do not call Claude or Codex services.

## Configure and stage

1. Copy `deploy/config.example.json` to `~/.config/dovsky/config.json`.
2. Set the directory mode to `0700` and the file mode to `0600`.
3. Replace placeholder project paths and review every fixed provider/release argv.
4. Build the exact checkout to be installed.
5. Copy `deploy/systemd/dovsky-daemon.service` to `~/.config/systemd/user/` only
   during an approved installation window, then reload the user manager.

Configuration resolves from `--config`, then `DOVSKY_CONFIG`, then
`~/.config/dovsky/config.json`. State defaults to `${DOVSKY_HOME:-~/.dovsky}`;
`DOVSKY_SOCKET` overrides the socket path. There is no HTTP bridge or tunnel.

## Import predecessor records

Confirm the predecessor has no active jobs. Preview before applying:

```sh
node packages/legacy-import/dist/cli.js --source ~/.agentbus/jobs
node packages/legacy-import/dist/cli.js --source ~/.agentbus/jobs --apply
```

The source is read-only. Import is content-addressed and safe to repeat.

## Verify a staged daemon

After an approved start or restart:

```sh
dovsky health
dovsky doctor
node deploy/verify.mjs
```

`doctor` checks source identity, schema, database writes, sandbox availability,
scope state, configured providers, GitHub authentication where enabled, and
release state. The deploy verifier requires the daemon's source to match the
checkout HEAD and performs no provider job or publication.

## Upgrades and rollback

Before switching binaries:

1. Prepare and verify an immutable candidate directory.
2. Drain new work and wait for active work to settle.
3. Inspect every unresolved execution or release scope.
4. Stop the writer and create a verified SQLite backup.
5. Switch the service only to the prepared candidate.

Retain the previous binary and its matching pre-upgrade database. Never run an
older daemon against a newer schema. Preserve uncertain scopes and operation
records; do not infer settlement from a timeout or missing receipt.

`dovsky execution show JOB` inspects an execution lease. Use
`dovsky execution reconcile JOB --expect REVISION` to record a fresh observation;
add `--terminate` only for an explicitly authorized, identity-matched scope.

Release operations use the same conservative rule. Mutation timeouts never
auto-kill a committing operation. Use an exact configured adapter's readback to
reconcile, and use explicit termination only with a current authorization grant.

## Evaluation and review

Change workflows default to medium evaluation. Supply observable outcomes in an
acceptance JSON file, use low only with a bounded justification, and use high when
baseline/candidate comparison is needed. `dovsky acceptance-check JOB` must pass
on the exact release tree; execution success or a grade is not acceptance.

`dovsky status ROOM` shows review state. `dovsky review JOB` reruns review from
stored evidence; `dovsky followup ROOM --from-review` resumes from the latest
refutation. A malformed or inconclusive required review blocks acceptance.

## Permission boundary

Repository tests do not constitute manual product acceptance or deployment.
Before public publication or live cutover, record the exact candidate, manifest,
scrub result, backup/rollback artifact, target settings, and explicit operator
approval. The opt-in provider smoke also remains separate because it contacts a
subscription-backed service.
