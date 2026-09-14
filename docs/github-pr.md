# GitHub pull-request leaf

This module is the deterministic, side-effect-bounded PR adapter used by the
daemon integration. It does not persist SQLite rows and does not authenticate
to GitHub itself; the daemon records each returned state through its durable
reserve/run/complete operation contract.

## Preconditions

The caller supplies an accepted job, the original evaluated-room fingerprint
and evidence hash, the immutable start commit, and the foundation
`DeltaArtifact`. The adapter rejects unaccepted work and invalid repository,
identity, title, or path inputs. It applies only baseline-to-final delta entries
to a detached worktree; the operator worktree is never the commit target.
The supplied start commit must exactly match the delta's immutable baseline
manifest, while the Git fingerprint and content hash must match its final
manifest; the evidence hash must be the SHA-256 of the supplied evidence text.
These bindings are checked before probing or creating any temporary/worktree
state.

The branch is deterministic: `dovsky/<room-id first 8>-<job-id first 8>`. The
daemon performs the read-only preflight, then atomically reserves `pr:<jobId>`
and the immutable PR identity before calling the mutating leaf. It persists
`committed`, `pushed`, and the final remote state before acknowledging the RPC.
A completed exact retry is replayed from the operation ledger without
contacting GitHub again.

Publication also requires a clean original coordination baseline. This keeps
pre-job tracked or untracked changes out of the detached PR commit instead of
silently publishing a tree whose recorded fingerprint describes different
content.

## Read-only probe order

Before any local worktree, commit, push, or PR write, the adapter executes:

1. `gh auth status --hostname github.com`;
2. `gh pr list --repo OWNER/REPO --head BRANCH --state all --json ...`;
3. the bounded `remoteBranchHead` Git helper, which captures the exact
   `refs/heads/BRANCH` object id without routing Git through the GitHub command
   runner.

An unauthenticated CLI is `NOT_CONFIGURED`. More than one listed PR is
ambiguous and fails closed. An existing PR is returned for reconciliation
without probing the remote branch. If a remote branch exists
without a PR (for example, after a crash following push), its exact head is
captured and the adapter creates the PR directly, with no second push or
worktree. The command runner always uses argv and `shell:false`; no command or
body text is interpreted as a shell program.

The create leaf optionally reports `onCommitted(headSha)` after the local
commit identity is captured and before push, then `onPushed(headSha)` after a
successful push or an already-existing exact remote branch and before PR
creation. Callbacks may be synchronous or asynchronous; failures propagate and
the normal cleanup/reconciliation rules still apply. A caller that already
performed the exact `probePullRequest` may pass that probe to create; its branch
must still match the deterministic job/room branch and it is not repeated.

## Local commit and body

For a new branch, the leaf creates a detached worktree at the captured start
commit, materialises the supplied delta (including binary bytes, deletes,
modes, directories, and symlinks), stages all changes, and commits with fixed
name/email supplied by project configuration. The commit message includes the
job, room, start commit, tree fingerprint, evidence hash, and branch.

The body contains acceptance, checked criteria, gate results, review, identity,
evaluation, and bounded review evidence. Stored text is terminal-control
sanitised. Evidence is clipped at 60 KiB with an explicit marker and the final
body is limited to 65,536 bytes.

After the push, `gh pr create` receives explicit `--repo`, `--base`, `--head`,
`--title`, and `--body-file` arguments, plus `--draft` when requested. Its
success output is parsed as the exact `https://github.com/OWNER/REPO/pull/N`
URL, where `N` must be a positive safe integer; arbitrary output is rejected.
Existing `gh pr list` records must contain a valid positive number, matching
URL, 40/64-hex head, and one of `OPEN`, `MERGED`, or `CLOSED`; these map to
`open`, `merged`, or `closed` respectively. A failed create after a successful
push is deliberately reported as reconciliation required; it is never retried
blindly. Worktree cleanup is attempted in a finally block, while an
unremovable worktree remains an observable cleanup failure for the daemon to
reconcile.

`statusPullRequest` performs auth first, then bounded `gh pr view` with a fixed
`--repo`, targeting the persisted number when present or branch otherwise. It
requires one JSON object containing only number, state, URL, head SHA, draft,
merge time, and merge commit (`{oid}`) fields; it normalizes merge timestamps,
extracts the merge commit OID, and maps the three GitHub states using the same
strict identity checks.

## Daemon integration

The daemon re-checks acceptance immediately before dispatch and reconciles the
returned remote PR/branch state after a crash. It uses the immutable
`apps/daemon/src/job-delta.ts` contract rather than a second dirty-delta
implementation. The CLI sends `github.pr.create` with idempotency key
`pr:<jobId>` and reports success only when `github.pr.status` says `merged`.
`doctor` reports GitHub authentication for every enabled project.

For headless services, place `GH_TOKEN=...` in the optional mode-0600
`~/.config/dovsky/github.env` file referenced by the systemd unit. The
example configuration includes the disabled-by-default project `github` block.
