# Change evaluation

Evaluation is enabled for new Dovsky `change` jobs. Other workflows and
historical jobs remain unevaluated. The database migration adds nullable fields;
it does not invent approvals for previous work.

| Level | Requirements |
|---|---|
| Low | Justification, existing quality gates, and any configured model review |
| Medium (default) | Quality gates, scripted scenarios, hard-or-frontier review, human checklist |
| High | Medium plus the same scenario suite on the original baseline and candidate |

Choose by risk and uncertainty, not diff size. Low suits predictable, bounded
edits. Behavior changes normally use medium. Broad execution, persistence, and
routing changes use high when their interactions need comparison.

## Starting work

Create `acceptance.json` with the outcomes you will test:

```json
{
  "criteria": ["Cancelling a running job stops it", "Its recorded output stays readable"],
  "expectedBaselineFailures": []
}
```

```sh
dovsky send "Implement the specified behavior" --project dovsky --workflow change --to codex --acceptance-file acceptance.json
dovsky send "A bounded mechanical edit" --project dovsky --workflow change --to codex --eval low --eval-reason "No behavior change; covered by the existing assertions"
dovsky send "Change execution behavior" --project dovsky --workflow change --to codex --eval high --acceptance-file acceptance.json
dovsky status ROOM
dovsky acceptance-check JOB
```

Keep the acceptance file outside the job's editable tree when practical. The CLI
reads JSON locally and sends only the criteria, never a server-side file path or
command.

The daemon freezes the runner source, quality commands, review requirements,
criteria, and expected baseline failures. Follow-ups, handoffs, retries, and
automatic corrections inherit them; they cannot reduce the level or remove
criteria. Handoffs and retries from older jobs inherit the latest room contract,
not the older source's weaker policy. All evaluated rooms now capture their
initial baseline, even at low/medium risk, so upgrading to high preserves the
original pre-change tree. Older low/medium rooms without a saved baseline fail
closed on upgrade and need a new room; they are never silently rebased.
High corrections retain that original baseline. Start a new room to
change the acceptance contract. Low jobs may explicitly disable optional review
at creation; a required review cannot be disabled later.

An upgrade does not permit declaring expected baseline failures after seeing the
candidate. If a known failing scenario must be repaired, declare it in a new high
room before work starts. Missing or incomplete baseline snapshots block comparison.

## Evidence and acceptance

`succeeded` still means execution and host checks passed. Acceptance is separately
`pending`, `blocked`, `accepted`, or `rejected`. Low work accepts automatically
once its required checks pass. Medium/high require the operator to exercise every
criterion and record observations through the CLI before accepting. Rejection
requires a reason; send an explicit follow-up with that feedback for correction.
Human grades remain routing feedback and cannot satisfy acceptance. The result
form requires an explicit model-quality choice: good, bad, or no grade for a
workflow/environment issue. A chosen grade is recorded atomically with the
acceptance decision. The API's optional `routingGrade` has the same behavior;
omitting it (or sending null) leaves existing grades unchanged. Acceptance is
never silently converted to a grade. Later `job.graded` events carry feedback;
terminal `routing.observation.v1` events remain immutable observations at finish.

The model reviewer receives the diff, criteria, and actual scenario results.
Committing a change does not remove it from review evidence or the room change list.
Evaluated corrections review the entire original-room delta, including code
left by an earlier failed job; a documentation-only retry cannot hide that code.
Legacy review evidence remains unchanged and must not be mistaken for this wider review.
The reviewer does not interactively exercise the UI. A skipped, malformed, inconclusive, or
refuted required review blocks acceptance. Evaluated jobs default to one automatic
correction after refutation, with all checks rerun; exhaustion requires an explicit
follow-up. `--review-rounds 0` disables the automatic correction, not the review.

Acceptance is an operator attestation under the existing single-user trust model.
It records checklist indexes, observations, and the exact tree/evidence identity.
`dovsky acceptance-check` additionally checks the current tree, evidence file, and
whether a newer work job superseded this result. Use it as a deployment gate;
the coordinator does not control deployments performed outside it.

## Scripted comparisons

`eval/scenarios.mjs` is a self-contained, versioned suite. It exercises dispatch
and CLI results, thread resume, cancellation, gate failures, review/correction,
and restart recovery using fixed provider fixtures. No real provider is launched
by the comparisons. Regular model reviews and corrections still consume quota.

The daemon prepares isolated baseline/candidate worktrees with separate workspace
packages. Each frozen project runner owns its build commands; the daemon assumes
no Dovsky package layout. `dependencyRoots` lists installed dependency directories
relative to the project (default `["node_modules"]`). Local workspace links are remapped into each arm.
External installed dependencies are shared. Each scenario uses its own
temporary database and sockets; production state is never an evaluation target.
Workspace command links are remapped even before their build output exists;
the project runner must build those commands before invoking them. Red-before
proofs receive the same dependency roots and retain regression tests added since
the original room baseline by jobs in that room across corrections. Per-job test
manifests are captured before quality gates run, excluding unrelated tests added
between jobs. Proofs reconstruct the exact original dirty snapshot, rather than
comparing a retry against the already-fixed tree. Old jobs without these manifests
cannot contribute tests to new proofs; start a new room when that evidence is missing.
Dirty tracked changes, deletions, and untracked regular files are reconstructed.
Tracked symlinks or incomplete snapshots block evaluation. Medium runs the candidate;
high runs both arms with the same frozen runner. Reports live in job artifacts
and job artifacts. Durations are diagnostic, not statistical benchmarks;
fixture results measure coordinator behavior, not model intelligence or token costs.

Every candidate scenario must pass. Unexpected baseline failures, omitted or
invalid results, and different scenario sets block acceptance. To prove an
intentional change, declare its scenario ID in `expectedBaselineFailures` before
dispatch: it must fail on the original baseline and pass on the candidate. Update
the evaluation suite as an operator before starting the job; workers cannot edit
the protected runner to approve their own changes.

## Verification and rollout

```sh
npm run build
npm run typecheck
npm test
node eval/scenarios.mjs /absolute/path/to/dovsky
node eval/acceptance-smoke.mjs
```

The smoke check exercises low, medium, and high on a disposable full-repository
copy, including synthetic rejection, correction, and acceptance. Its recorded
decisions stay in disposable state and are not a human acceptance of a real change.
The checks need local socket access. No live A/B experiments or model benchmarks
are included in this version.

Enable `evaluation: { enabled: true, defaultLevel: "medium", runner: "eval/scenarios.mjs" }`
on Dovsky's change workflow after the checks pass. Back up the SQLite database
with its backup mechanism before any daemon upgrade. Disabling the workflow
policy affects new rooms; already evaluated work retains its frozen requirements.
Restore an older binary only with its matching pre-upgrade database, after stopping
the newer daemon and preserving its state separately.
