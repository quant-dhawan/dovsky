# Task coordination and release controls

Dovsky persists jobs, logical tasks, controls, release operations, and receipts.
Build and verify in an isolated checkout; building source does not deploy it.

## Jobs are executions; tasks are outcomes

`dovsky wait JOB` retains process-status semantics. `dovsky wait-task TASK` returns
success only for a completed logical task. `checkpointed`, `awaiting_decision`,
`blocked`, `unknown`, and `cancelled` are not successful task completion. Legacy
execution records migrate to unknown; old prose is never reclassified as proof.

Use `dovsky tasks ROOM` to find task IDs and `dovsky task TASK` to inspect phase,
blocker, next action, and the control inbox. Room and job commands expose the
latest execution and release receipts.

```sh
dovsky control TASK instruction "Check conflicts before proceeding"
dovsky control TASK pause "Finish the current atomic step and pause"
dovsky checkpoint TASK --job JOB
dovsky ack TASK CONTROL_ID --job JOB
dovsky control TASK resume "Continue after the checkpoint"
dovsky resume TASK
```

Recording a control creates no job. A resume control permits already-queued
work to dispatch; `dovsky resume` explicitly creates an execution if none is
pending. Controls arrive at a worker's checkpoint or in its next prompt, not by
injecting into a running tool. Delivery is separate from ordered explicit ACK.
Provider children receive the owning daemon's socket, not the ambient default.
Mid-turn checkpoint calls remain subject to the provider's sandbox and tool
permissions. If those prevent a local socket call, controls stay pending until
the next supervised execution prompt; receipt is not falsely reported early.

Decision notes are informational: they do not reopen completed work or invalidate
its accepted candidate. They also do not grant or revoke release permission.
For completed tasks, the foreground coordinator may use checkpoint/ACK against
the terminal job without another execution; the receipt explicitly attributes
this to `coordinator`, not to the exited provider. A substantive `instruction`
reopens work and requires new evaluation. Pause blocks release preparation and
dispatch; lifting it preserves the same accepted bytes when no work changed.

Workers finish with one standalone line, for example:

```text
DOVSKY_RESULT: {"outcome":"awaiting_decision","phase":"Release permission","blocker":"Approval missing","nextAction":"Record decision and resume","acknowledgedControls":[]}
```

A checkpoint skips completed-work quality/review gates and releases the provider
slot. Explicit checkpoints retain worktree ownership; a resumed execution keeps
the original protection/evidence baseline. Missing structured output leaves the
task unknown and blocks acceptance. For compatibility, a legacy provider's normal
terminal execution does not reserve a worktree forever. Interrupted ownership is
retained until an explicit recovery decision; queued dependent executions are
cancelled on restart, not blindly resumed.

Read-only continuations also acquire a task/session execution lock. Predecessor
links establish order even at identical timestamps; thread IDs are persisted as
soon as announced and follow-up context is resolved after the predecessor ends.
Changing model or effort does not resume the incompatible prior session.

## Foreground notification acknowledgment

```sh
dovsky events codex-session --room ROOM
dovsky events-ack codex-session --through LAST_EVENT_ID
```

Use a stable consumer ID per foreground session. Events replay until explicitly
acknowledged; cursors persist across reconnects. A consumer cannot change its
room filter or acknowledge beyond delivered events. The coordinator must consume
and convey the events; an idle chat client is not woken automatically.

## Release identity, permission, and proof

`dovsky candidate register --file candidate.json` freezes artifact bytes and binds
repository, base/head commit, source fingerprint, artifact/configuration/migration
hashes, and source evaluation evidence. The source job must belong to this task,
be accepted, and evaluate this exact candidate worktree. Rebase, source edits, or
artifact tampering require a new candidate/evaluation. Unrelated checkouts do not
invalidate an isolated candidate. Arbitrary source acceptance cannot certify an
unrelated release directory.

`dovsky authorization grant --file permission.json` records action/target/task/
repository/candidate scope and its instruction source. This is a cooperative
operator assertion, explicitly `authenticated: false`, not proof of human
identity. A control saying “migrate” does not create this grant. Neither grant nor
control fills in the human acceptance checklist.

Release adapters are fixed **local configuration**, never argv submitted over
RPC. The optional `releaseAdapters` array contains entries shaped as follows:

```json
{
  "id": "candidate-verification",
  "action": "verify",
  "target": "dovsky-staging-verification",
  "cwd": "artifact",
  "argv": ["/absolute/trusted/check-candidate", "{artifactDir}", "{artifactHash}"],
  "preflightArgv": ["/absolute/trusted/read-verification-base"],
  "readbackArgv": ["/absolute/trusted/read-verification-receipt", "{operationId}"],
  "timeoutMs": 30000
}
```

The shown scripts are placeholders to replace with reviewed, target-specific
tools; no adapter is installed automatically. Preflight stdout must equal the
operation's exact `expectedBefore`. The mutation itself must enforce that
predecessor with the target's compare-and-set/fencing mechanism; a preliminary
read alone cannot exclude external writers. Readback outputs JSON with `state`
(`verified`, `not_applied`, or `reconcile_required`) and `detail`.

Before a commit/push/migration/deploy, execute a separately authorized `verify`
operation for the **same candidate**. It must verify artifact/build provenance,
not merely return zero. `dovsky candidate verify ID` only checks integrity/source
acceptance and does not replace this operation. A commit changes candidate
identity; register/evaluate the resulting candidate before pushing. Push refuses
uncommitted candidate changes.

```sh
dovsky operation prepare --file operation.json
dovsky operation execute OPERATION_ID
dovsky operation get OPERATION_ID
dovsky operation reconcile OPERATION_ID
```

One semantic operation ID survives retries. Intent is persisted before dispatch;
unknown/crashed outcomes retain target ownership. No timeout-based lock stealing,
blind migration retry, automatic reverse migration, or database restoration is
performed. Only authoritative readback establishes success or no effect. Clearing
an uncertain operation also requires `settled: true` from the trusted adapter:
it asserts no surviving process/request can later change that outcome. An empty
ledger alone cannot prove this. Cancellation does not kill a dispatched release;
it revokes its grant, blocks subsequent steps, and preserves reconciliation.

Release receipts and mutations, worker checkpoint/ACK, and drain changes are
local-socket-only. Same-UID shell access can
bypass this cooperative executor; credentials/OS isolation would be required to
claim universal enforcement. Sandbox/tool approvals remain independently binding.

## Verification and cutover

Unit/integration tests cover control timing, no false completion, baseline
retention, session causality, isolated sockets, restart quarantine, drain
persistence, migration/backup integrity, artifact verification, grant revocation,
target drift, timeouts, and uncertain outcomes. The frozen evaluation runner also
exercises control delivery/ACK, checkpoint/resume gates, and drain/restart.

The opt-in `node eval/provider-coordination-smoke.mjs --run-claude` additionally
exercises two real Fable-low turns with tools disabled: awaiting decision,
same-thread resume, explicit control ACK, and completion. This does not test
mid-tool interruption or permission to execute external actions.

These checks do not constitute manual product acceptance or a production deployment. Before cutover, exercise
the control/resume/unknown-receipt CLI paths, record real observations, configure and
canary the actual release adapters, and obtain the concrete deployment decision.
