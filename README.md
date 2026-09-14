# Dovsky

Dovsky is a local-first control plane for human-led Claude Code and Codex CLI work. A single daemon owns process execution and SQLite state; the terminal client makes jobs, failures, results, changes, and handoffs inspectable.

## Repository boundaries

- `apps/daemon` — sole database writer and provider process owner
- `packages/protocol` — versioned domain and wire contracts
- `packages/legacy-import` — idempotent importer for the legacy spool
- `bin/dovsky` — CLI client for the daemon socket
- `deploy/systemd` — user-service templates and verifier

Runtime state, raw transcripts, configuration, and secrets stay outside Git under `${DOVSKY_HOME:-~/.dovsky}`. The predecessor `~/.agentbus` spool is treated as read-only migration input.

## Safety model

Only configured projects and workflows can be started through the local daemon socket. Terminal states are immutable; cancellation is compare-and-set; mutation requests are idempotent; and concurrent writes to the same worktree are rejected. Keep the socket restricted to the local operator.

## Development

Requires Node.js 24 or newer.
Build/test in an isolated checkout, not the running daemon's source directory.

```sh
npm ci
npm run build
npm run typecheck
npm test
```

## Operations

For logical task outcomes, control delivery/ACK, durable foreground events, and
release receipts, see [task coordination](docs/task-coordination.md). Building
source never deploys it; [the runbook](docs/runbook.md) keeps staging,
verification, migration, and rollback explicit.

Dovsky change jobs default to medium evaluation: tests, scripted scenarios,
model review, then explicit human acceptance. Supply a JSON file with
`{"criteria":["An observable outcome to exercise"]}` via `--acceptance-file`.
Use `--eval low --eval-reason "..."` for bounded work, or `--eval high` for
baseline comparisons. `dovsky acceptance-check JOB` exits zero only for an accepted
job whose working tree and evidence still match. Execution success and human
grades alone are not acceptance. See [the evaluation policy](docs/evaluation.md).

Copy `deploy/config.example.json` to `~/.config/dovsky/config.json`, replace the
placeholder home directory, and keep it mode `0600`. Build before starting the user service in
`deploy/systemd/`.

The legacy spool is imported without launching providers:

```sh
node packages/legacy-import/dist/cli.js --source ~/.agentbus/jobs --apply
```

The import is content-addressed and safe to run again. See
[`docs/runbook.md`](docs/runbook.md) for staging, cutover, verification, and rollback.

## License

Dovsky is licensed under the Functional Source License 1.1, ALv2 Future License
(`FSL-1.1-ALv2`). Each released version becomes available under Apache-2.0 on
the second anniversary of that version's publication. See [LICENSE](LICENSE).
