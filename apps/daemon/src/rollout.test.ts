import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { RolloutGroupView, RolloutCandidateView } from '@dovsky/protocol';
import { FixtureDaemon, removeFixtureTree } from './__fixtures__/runtime-isolation.js';
import { gitBytes } from './git.js';
import type { DaemonConfig } from './config.js';
import type { StoredJob } from './model.js';
import type { StoredRolloutGroup } from './database.js';
import { canonicalIdentity } from './job-delta.js';
import type { FailureInfo } from '@dovsky/protocol';

const provider = new URL('./__fixtures__/rollout-runtime.js', import.meta.url).pathname;
type View = { group: RolloutGroupView | null; candidates: RolloutCandidateView[] };
function fixture(t: TestContext, policy = 'prune', evaluated = false) {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-rollout-')), project = join(root, 'project');
  gitBytes(root, ['init', '-q', project]);
  writeFileSync(join(project, 'tracked.txt'), 'baseline\n');
  writeFileSync(join(project, 'evaluate.mjs'), "console.log(JSON.stringify({scenarios:[{id:'fixture',passed:true,detail:'verified',durationMs:Math.random()}]}));\n");
  gitBytes(project, ['add', '.']);
  gitBytes(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const config: DaemonConfig = { socketPath: join(root, 'run/socket'), databasePath: join(root, 'state/db'), artifactDirectory: join(root, 'artifacts'), maxActive: 3,
    routing: { bandit: { decay: 0.5 } }, projects: [{ id: 'p', name: 'Fixture', path: project, workflows: [
      { id: 'work', name: 'Work', readOnly: false, qualityCommands: [[process.execPath, provider, 'gate', policy]], providers: {
        codex: { argv: [process.execPath, provider, 'work', policy] } },
        review: { enabled: true, provider: 'codex', tier: 'hard', maxCorrections: 2, maxRollouts: 3, small: null },
        ...(evaluated ? { evaluation: { enabled: true, defaultLevel: 'medium' as const, runner: 'evaluate.mjs', dependencyRoots: [] } } : {}) },
      { id: 'review', name: 'Review', readOnly: true, qualityCommands: [], providers: { codex: { argv: [process.execPath, provider, 'review', policy], reviewArgv: [process.execPath, provider, 'review', policy] } } },
    ] }] };
  let daemon = new FixtureDaemon(config);
  t.after(async () => { await daemon.stop(); daemon.close(); removeFixtureTree(root); });
  return { root, project, config, get daemon() { return daemon; }, reopen: async () => {
    await daemon.stop(); daemon.close(); daemon = new FixtureDaemon(config); daemon.start();
  }, create: async (params: Record<string, unknown> = {}) => {
    const out = await daemon.call('rooms.create', { title: 'Rollout', projectId: 'p', workflowId: 'work', prompt: 'Make the original change and repair it', recipients: ['codex'], tier: 'routine', force: true,
      ...(evaluated ? { acceptance: { criteria: ['Fixture passes'] } } : {}), ...params }, randomUUID()) as { roomId: string; jobIds: string[] };
    return out.jobIds[0]!;
  } };
}
async function until<T>(read: () => T | null | false, describe: () => unknown): Promise<T> {
  for (let n = 0; n < 1500; n++) { const value = read(); if (value) return value; await delay(20); }
  assert.fail(JSON.stringify(describe()));
}
const jobs = (daemon: FixtureDaemon): StoredJob[] => daemon.database.db.prepare('SELECT id FROM jobs ORDER BY rowid').all().map(row => daemon.database.getJob(String(row.id))!);
const events = (daemon: FixtureDaemon, type: string) => daemon.database.db.prepare('SELECT * FROM events WHERE type=?').all(type);
const terminalGroup = (daemon: FixtureDaemon) => until(() => {
  const row = daemon.database.db.prepare("SELECT * FROM rollout_groups WHERE state NOT IN ('running','paused','promoting')").get();
  return row ?? null;
}, () => jobs(daemon).map(job => [job.executionKind, job.state, job.failure]));

type Runtime = {
  settleRollout(group: StoredRolloutGroup): void;
  settleRolloutForJob(jobId: string): void;
  runPromotion(job: StoredJob): Promise<void>;
  runEvaluation(job: StoredJob, cwd: string): Promise<FailureInfo | null>;
  schedule(): void;
};
const runtime = (daemon: FixtureDaemon) => daemon as unknown as Runtime;
function holdRanking(daemon: FixtureDaemon) {
  const original = runtime(daemon).settleRollout.bind(daemon);
  runtime(daemon).settleRollout = group => {
    const candidates = daemon.database.rolloutMembers(group.id).filter(job => job.executionKind === 'rollout_candidate');
    if (group.state === 'running' && candidates.length && candidates.every(job => ['succeeded', 'failed', 'cancelled'].includes(job.state))) return;
    original(group);
  };
  return { settle: original, release: () => { runtime(daemon).settleRollout = original; } };
}
const candidatesReady = (daemon: FixtureDaemon) => until(() => {
  const row = daemon.database.db.prepare('SELECT id FROM rollout_groups').get();
  if (!row) return null;
  const group = daemon.database.getRolloutGroup(String(row.id))!;
  return group.candidateIds.length && group.candidateIds.every(id => ['succeeded', 'failed', 'cancelled'].includes(daemon.database.getJob(id)!.state)) ? group : null;
}, () => jobs(daemon).map(job => [job.executionKind, job.state, job.failure]));

test('rollouts.get is a typed read with an empty result before a group exists', async t => {
  const f = fixture(t), id = await f.create();
  assert.deepEqual(await f.daemon.call('rollouts.get', { jobId: id }), { group: null, candidates: [] });
});

test('private candidate deltas reach gates; two candidates are pruned and one promotes full-room evidence', async t => {
  const f = fixture(t, 'prune', true); f.daemon.start(); const id = await f.create();
  const group = await terminalGroup(f.daemon);
  assert.equal(group.state, 'promoted', JSON.stringify({ jobs: jobs(f.daemon).map(job => [job.executionKind, job.state, job.failure]), events: events(f.daemon, 'rollout.failed') }));
  const candidates = jobs(f.daemon).filter(job => job.executionKind === 'rollout_candidate');
  assert.equal(candidates.length, 3); assert.equal(candidates.filter(job => job.state === 'failed').length, 2);
  assert.equal(events(f.daemon, 'rollout.pruned').length, 2);
  const reviewers = jobs(f.daemon).filter(job => job.executionKind === 'rollout_review');
  assert.equal(reviewers.length, 1); assert.equal(reviewers[0]!.reviewOutcome, 'approved');
  const promotion = f.daemon.database.getJob(String(group.promotion_job_id))!;
  assert.equal(promotion.executionKind, 'promotion'); assert.equal(promotion.taskId, id);
  assert.equal(promotion.acceptanceDecision, null);
  assert.equal(readFileSync(join(f.project, 'repair.txt'), 'utf8'), '2\n');
  const evidence = readFileSync(join(f.root, 'artifacts/jobs', promotion.id, 'review-evidence.md'), 'utf8');
  assert.match(evidence, /original worker change/); assert.match(evidence, /repair.txt/);
  assert.equal(f.daemon.database.getJobSummary(promotion.id).review?.jobId, reviewers[0]!.id);
  assert.ok(f.daemon.database.getJobSummary(promotion.id).evaluation?.outstanding.includes('Human acceptance checklist required'));
  const view = await f.daemon.call('rollouts.get', { jobId: id }) as View;
  assert.equal(view.group!.id, group.id); assert.equal(view.candidates.length, 3);
  assert.ok(candidates.every(job => job.taskId === null && job.cwd !== f.project));
  assert.ok(Math.max(...candidates.map(job => Date.parse(job.startedAt!))) < Math.min(...candidates.map(job => Date.parse(job.finishedAt!))));
  const count = Number(f.daemon.database.db.prepare('SELECT count(*) AS n FROM routing_rewards').get()!.n);
  f.daemon.database.gradeJob(promotion.id, 'bad', 'Human override', 'human');
  assert.equal(f.daemon.database.getJob(promotion.promotionOf!)!.gradeSource, 'human');
  assert.equal(f.daemon.database.getJob(promotion.promotionOf!)!.grade, 'bad');
  assert.equal(f.daemon.database.db.prepare('SELECT count(*) AS n FROM routing_rewards').get()!.n, count);
  assert.equal(f.daemon.database.db.prepare('SELECT reward FROM routing_rewards WHERE execution_job_id=?').get(promotion.promotionOf!)!.reward, 0);
  assert.equal(f.daemon.database.db.prepare('SELECT * FROM routing_rewards WHERE execution_job_id=?').get(promotion.id), undefined);
});

test('all candidates are gate-pruned with zero rollout reviewers and one exhaustion/ladder handoff', async t => {
  const f = fixture(t, 'all-pruned'); let ladder = 0;
  const internal = f.daemon as unknown as { ladderAfterFailure(job: StoredJob, reason: string): void };
  const old = internal.ladderAfterFailure.bind(f.daemon);
  internal.ladderAfterFailure = (job, reason) => { if (job.executionKind === 'foreground') ladder++; old(job, reason); };
  f.daemon.start(); const id = await f.create(); const group = await terminalGroup(f.daemon);
  assert.equal(group.state, 'exhausted'); assert.equal(group.reviews_spent, 0);
  assert.equal(events(f.daemon, 'rollout.pruned').length, 3);
  assert.equal(jobs(f.daemon).filter(job => job.executionKind === 'rollout_review').length, 0);
  assert.equal(ladder, 1); runtime(f.daemon).settleRolloutForJob(id); runtime(f.daemon).settleRolloutForJob(id);
  assert.equal(events(f.daemon, 'rollout.exhausted').length, 1); assert.equal(ladder, 1);
  assert.match(f.daemon.database.getJob(id)!.reviewSkipped!, /exhausted/);
  assert.equal(existsSync(join(f.project, 'repair.txt')), false);
});

for (const tie of [false, true]) test(`ranking uses ${tie ? 'age then ID' : 'changed lines then effective arm mean'} and claims one reviewer idempotently`, async t => {
  const f = fixture(t, 'pass'), hold = holdRanking(f.daemon); f.daemon.start(); const id = await f.create();
  const group = await candidatesReady(f.daemon), candidates = group.candidateIds.map(value => f.daemon.database.getJob(value)!);
  assert.equal(existsSync(join(f.project, 'repair.txt')), false);
  assert.deepEqual(canonicalIdentity(f.project), group.canonical);
  assert.ok(candidates.every(job => job.jobDeltaPath && job.endContentHash && readFileSync(join(job.cwd!, 'repair.txt'), 'utf8').trim().length));
  assert.ok(candidates.every(job => (job.sandbox?.application as { canonicalPath: string }).canonicalPath === job.cwd));
  assert.ok(candidates.every(job => f.daemon.database.executionForJob(job.id).leases.every(lease => lease.state === 'exited')));
  const means = new Map(candidates.map((job, n) => [job.id, tie ? 0.5 : [0.99, 0.2, 0.8][n]!]));
  f.daemon.database.routingArmMean = jobId => means.get(jobId) ?? null;
  candidates.forEach((job, n) => {
    f.daemon.database.replaceChanges(job.id, [{ path: 'repair.txt', status: 'added', additions: tie ? 1 : n === 0 ? 5 : 1, deletions: 0 }]);
    if (tie) f.daemon.database.db.prepare('UPDATE jobs SET created_at=? WHERE id=?').run(n === 0 ? '2020-01-02T00:00:00Z' : '2020-01-01T00:00:00Z', job.id);
  });
  hold.settle(group); hold.settle(f.daemon.database.getRolloutGroup(group.id)!);
  const ranked = f.daemon.database.rolloutMembers(group.id).filter(job => job.executionKind === 'rollout_candidate').sort((a, b) => a.rolloutRank! - b.rolloutRank!).map(job => job.id);
  assert.deepEqual(ranked, tie ? [...candidates.slice(1).map(job => job.id).sort(), candidates[0]!.id] : [candidates[2]!.id, candidates[1]!.id, candidates[0]!.id]);
  assert.equal(jobs(f.daemon).filter(job => job.executionKind === 'rollout_review').length, 1);
  assert.equal(f.daemon.database.getRolloutGroup(group.id)!.reviewsSpent, 1);
  assert.equal(events(f.daemon, 'rollout.ranked').length, 1);
  await f.daemon.call('jobs.cancel', { jobId: id }, randomUUID());
});

test('nonapproval spends bounded review rounds without parallel reviewers or individual retries', async t => {
  const f = fixture(t, 'refute'); f.daemon.start(); await f.create();
  const group = await terminalGroup(f.daemon), reviews = jobs(f.daemon).filter(job => job.executionKind === 'rollout_review');
  assert.equal(group.state, 'exhausted'); assert.equal(group.reviews_spent, 2); assert.equal(reviews.length, 2);
  assert.ok(reviews.every(job => job.reviewRetryOf === null && job.attemptCount === 1));
  assert.ok(Date.parse(reviews[1]!.startedAt!) >= Date.parse(reviews[0]!.finishedAt!));
  assert.equal(events(f.daemon, 'rollout.superseded').length, 2);
});

for (const via of ['parent', 'candidate', 'reviewer', 'task']) test(`cancelling via ${via} cancels the whole group and cleans confirmed-absent trees`, async t => {
  const f = fixture(t, 'pass'), hold = holdRanking(f.daemon); f.daemon.start(); const id = await f.create();
  const group = await candidatesReady(f.daemon); hold.settle(group);
  const reviewer = jobs(f.daemon).find(job => job.executionKind === 'rollout_review')!;
  await f.daemon.call(via === 'task' ? 'tasks.cancel' : 'jobs.cancel', via === 'task' ? { taskId: id } : { jobId: via === 'parent' ? id : via === 'candidate' ? group.candidateIds[0] : reviewer.id }, randomUUID());
  assert.equal(f.daemon.database.getRolloutGroup(group.id)!.state, 'cancelled');
  assert.ok(f.daemon.database.rolloutMembers(group.id).every(job => ['succeeded', 'failed', 'cancelled'].includes(job.state)));
  assert.equal(f.daemon.database.getJob(reviewer.id)!.state, 'cancelled');
  assert.equal(events(f.daemon, 'rollout.cancelled').length, 1);
  assert.ok(group.candidateIds.every(candidate => !existsSync(join(f.root, 'artifacts/rollout-worktrees', candidate))));
  assert.equal(existsSync(join(f.project, 'repair.txt')), false);
});

test('pause blocks auxiliary dispatch; resume settles exactly once, including startup recovery', async t => {
  const f = fixture(t, 'pass'), hold = holdRanking(f.daemon); f.daemon.start(); const id = await f.create();
  const group = await candidatesReady(f.daemon); hold.settle(group);
  await f.daemon.call('tasks.controls.create', { taskId: id, kind: 'pause', body: 'Pause the group' }, randomUUID());
  runtime(f.daemon).schedule(); await delay(100);
  assert.equal(f.daemon.database.getRolloutGroup(group.id)!.state, 'paused');
  assert.equal(jobs(f.daemon).find(job => job.executionKind === 'rollout_review')!.state, 'queued');
  assert.equal(f.daemon.database.canReleaseTaskOwnership(id), false);
  await assert.rejects(f.daemon.call('messages.create', { roomId: group.roomId, body: 'Competing task work', recipient: 'codex' }, randomUUID()), { code: 'STATE_CONFLICT' });
  await f.reopen();
  assert.ok(group.candidateIds.every(candidate => existsSync(join(f.root, 'artifacts/rollout-worktrees', candidate))));
  assert.equal(jobs(f.daemon).filter(job => job.executionKind === 'rollout_review').length, 1);
  await f.daemon.call('tasks.controls.create', { taskId: id, kind: 'resume', body: 'Continue' }, randomUUID());
  const done = await terminalGroup(f.daemon); assert.equal(done.state, 'promoted');
  runtime(f.daemon).settleRolloutForJob(id); await f.reopen();
  assert.equal(events(f.daemon, 'rollout.started').length, 1); assert.equal(events(f.daemon, 'rollout.promoted').length, 1);
  assert.equal(jobs(f.daemon).filter(job => job.executionKind === 'promotion').length, 1);
});

test('canonical identity conflict fails promotion before applying any candidate bytes', async t => {
  const f = fixture(t, 'pass'), original = runtime(f.daemon).runPromotion.bind(f.daemon);
  runtime(f.daemon).runPromotion = async job => { writeFileSync(join(f.project, 'operator.txt'), 'operator change\n'); await original(job); };
  f.daemon.start(); await f.create(); const group = await terminalGroup(f.daemon);
  assert.equal(group.state, 'stale');
  const promotion = f.daemon.database.getJob(String(group.promotion_job_id))!;
  assert.equal(promotion.failure?.code, 'rollout_conflict'); assert.equal(promotion.acceptanceDecision, null);
  assert.equal(existsSync(join(f.project, 'repair.txt')), false);
  assert.equal(readFileSync(join(f.project, 'operator.txt'), 'utf8'), 'operator change\n');
  assert.equal(promotion.sandbox?.application, undefined);
});

test('substantive evaluation differences invalidate approval reuse; timing-only differences do not', async t => {
  const f = fixture(t, 'pass', true), original = runtime(f.daemon).runEvaluation.bind(f.daemon);
  runtime(f.daemon).runEvaluation = async (job, cwd) => {
    const failure = await original(job, cwd);
    if (job.executionKind === 'promotion') {
      const report = f.daemon.database.getJob(job.id)!.evaluationReport!;
      f.daemon.database.setEvaluationReport(job.id, { ...report, candidate: report.candidate.map(item => ({ ...item, detail: 'different substantive result' })) });
    }
    return failure;
  };
  f.daemon.start(); await f.create(); const group = await terminalGroup(f.daemon);
  assert.equal(group.state, 'failed');
  const promotion = f.daemon.database.getJob(String(group.promotion_job_id))!;
  assert.equal(promotion.failure?.code, 'review_stale'); assert.equal(promotion.reviewInputHash, null);
  assert.equal(promotion.acceptanceDecision, null); assert.equal(f.daemon.database.getJobSummary(promotion.id).review, null);
});

test('rollout reviewer infrastructure failures consume group budget without individual retry or candidate grade', async t => {
  const f = fixture(t, 'review-crash'); f.daemon.start(); await f.create(); const group = await terminalGroup(f.daemon);
  const reviews = jobs(f.daemon).filter(job => job.executionKind === 'rollout_review');
  assert.equal(group.state, 'exhausted'); assert.equal(reviews.length, 2);
  assert.ok(reviews.every(job => job.reviewOutcome === 'reviewer_failed' && job.reviewRetryOf === null && job.attemptCount === 1));
  assert.ok(jobs(f.daemon).filter(job => job.executionKind === 'rollout_candidate').every(job => job.grade === null));
});

test('active group cancellation retains resources until every real scope is absent', async t => {
  const f = fixture(t, 'hold'); f.daemon.start(); const id = await f.create();
  const group = await until(() => {
    const value = f.daemon.database.rolloutGroupForJob(id);
    return value && value.candidateIds.every(candidate => f.daemon.database.executionForJob(candidate).leases.some(lease => lease.state === 'running')) ? value : null;
  }, () => jobs(f.daemon).map(job => [job.executionKind, job.state]));
  await f.daemon.call('jobs.cancel', { jobId: group.candidateIds[0] }, randomUUID());
  assert.equal(f.daemon.database.getRolloutGroup(group.id)!.state, 'cancelled');
  assert.ok(group.candidateIds.every(candidate => existsSync(join(f.root, 'artifacts/rollout-worktrees', candidate))));
  await until(() => group.candidateIds.every(candidate => f.daemon.database.getJob(candidate)!.state === 'cancelled' && !f.daemon.database.hasUnresolvedExecution(candidate)), () => jobs(f.daemon));
  assert.ok(group.candidateIds.every(candidate => !existsSync(join(f.root, 'artifacts/rollout-worktrees', candidate))));
  assert.equal(f.daemon.database.canReleaseTaskOwnership(id), true);
  assert.equal(f.daemon.database.db.prepare('SELECT * FROM task_ownership WHERE task_id=?').get(id), undefined);
  assert.equal(existsSync(join(f.project, 'repair.txt')), false);
  assert.ok(existsSync(group.baselinePath), 'A committed group baseline remains evidence after cancellation');
});

for (const permissions of ['writable', 'readonly-candidates', 'blocked-parent'] as const) test(`group admission rollback cleans or records every captured path (${permissions})`, async t => {
  if (permissions !== 'writable') assert.notEqual(process.getuid?.(), 0, 'Permission regressions must run unprivileged');
  const f = fixture(t, 'pass'); let inserted = 0;
  const candidateIds: string[] = [];
  const original = f.daemon.database.createJob.bind(f.daemon.database);
  f.daemon.database.createJob = (job, turnId) => {
    if (job.executionKind === 'rollout_candidate') {
      candidateIds.push(job.id);
      if (++inserted === 3) {
        if (permissions === 'readonly-candidates') for (const candidate of candidateIds) chmodSync(join(f.root, 'artifacts/rollout-worktrees', candidate), 0o500);
        if (permissions === 'blocked-parent') chmodSync(join(f.root, 'artifacts/rollout-worktrees'), 0o500);
        throw new Error('fixture admission fault');
      }
    }
    original(job, turnId);
  };
  f.daemon.start(); const id = await f.create();
  await until(() => inserted === 3, () => jobs(f.daemon));
  assert.equal(f.daemon.database.rolloutGroupForJob(id), null);
  assert.equal(jobs(f.daemon).filter(job => job.executionKind === 'rollout_candidate').length, 0);
  assert.equal(events(f.daemon, 'rollout.started').length, 0);
  assert.equal(events(f.daemon, 'rollout.skipped').length, 1, 'Cleanup failure must not suppress the durable admission refusal');
  assert.match(f.daemon.database.getJob(id)!.reviewSkipped!, /fixture admission fault/);
  const skip = JSON.parse(String(events(f.daemon, 'rollout.skipped')[0]!.data_json)) as { reason: string; cleanupErrors?: Array<{ path: string; error: string }> };
  assert.match(skip.reason, /fixture admission fault/);
  if (permissions === 'blocked-parent') {
    assert.equal(skip.cleanupErrors?.length, 3, 'Every candidate cleanup must be attempted despite earlier failures');
    assert.deepEqual(skip.cleanupErrors!.map(value => value.path).sort(), candidateIds.map(candidate => join(f.root, 'artifacts/rollout-worktrees', candidate)).sort());
    assert.ok(skip.cleanupErrors!.every(value => /EACCES|EPERM/.test(value.error)));
    assert.match(f.daemon.database.getJob(id)!.reviewSkipped!, /cleanup failed/);
    chmodSync(join(f.root, 'artifacts/rollout-worktrees'), 0o700);
  } else {
    assert.deepEqual(readdirSync(join(f.root, 'artifacts/rollout-worktrees')), []);
    assert.equal(skip.cleanupErrors, undefined);
  }
  assert.equal(candidateIds.length, 3);
  assert.ok(candidateIds.every(candidate => f.daemon.database.db.prepare('SELECT id FROM turns WHERE job_id=?').get(candidate) === undefined));
  const baselineRoot = join(f.root, 'artifacts/rollout-baselines');
  assert.equal(f.daemon.database.db.prepare('SELECT count(*) AS n FROM rollout_groups WHERE baseline_path LIKE ?').get(baselineRoot + '/%')!.n, 0);
  assert.deepEqual(readdirSync(baselineRoot), [], 'Failed admission must not leave an unreferenced immutable baseline');
  assert.equal(f.daemon.database.db.prepare('SELECT * FROM task_ownership WHERE task_id=?').get(id), undefined);
  runtime(f.daemon).settleRolloutForJob(f.daemon.database.latestReview(id)!.id);
  assert.equal(events(f.daemon, 'rollout.skipped').length, 1);
});

test('candidate application rejects the canonical tree even with a forged worktree lock', async t => {
  const f = fixture(t, 'pass'), hold = holdRanking(f.daemon); f.daemon.start(); const id = await f.create();
  const group = await candidatesReady(f.daemon), candidate = f.daemon.database.getJob(group.candidateIds[0]!)!;
  const before = canonicalIdentity(f.project);
  f.daemon.database.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(candidate.id);
  assert.equal(f.daemon.database.acquireResources(candidate.id, [`worktree:${f.project}`]), true);
  const application = candidate.sandbox!.application as Record<string, unknown>;
  assert.throws(() => f.daemon.database.beginCanonicalApplication(candidate.id, { canonicalPath: f.project, intentPath: String(application.intentPath) + '.forged', baselinePath: String(application.baselinePath), finalPath: String(application.finalPath), expected: before, contentHash: candidate.endContentHash! }), /running foreground/);
  assert.deepEqual(canonicalIdentity(f.project), before);
  f.daemon.database.db.prepare("UPDATE jobs SET state='succeeded' WHERE id=?").run(candidate.id);
  f.daemon.database.releaseResources(candidate.id);
  await f.daemon.call('jobs.cancel', { jobId: id }, randomUUID());
});

test('startup reconciles terminal unclaimed candidates exactly once', async t => {
  const f = fixture(t, 'pass'); holdRanking(f.daemon); f.daemon.start(); const id = await f.create();
  const group = await candidatesReady(f.daemon);
  assert.equal(group.reviewsSpent, 0); assert.equal(jobs(f.daemon).filter(job => job.executionKind === 'rollout_review').length, 0);
  await f.reopen(); const done = await terminalGroup(f.daemon);
  assert.equal(done.state, 'promoted'); assert.equal(done.reviews_spent, 1);
  assert.equal(jobs(f.daemon).filter(job => job.executionKind === 'rollout_review').length, 1);
  runtime(f.daemon).settleRolloutForJob(id); runtime(f.daemon).settleRolloutForJob(String(done.promotion_job_id));
  assert.equal(events(f.daemon, 'rollout.ranked').length, 1); assert.equal(events(f.daemon, 'rollout.winner').length, 1);
  assert.equal(events(f.daemon, 'rollout.promoted').length, 1);
});

test('missing persisted candidate completeness cannot borrow COMPLETE prose or produce a grade', async t => {
  const f = fixture(t, 'pass'), hold = holdRanking(f.daemon); f.daemon.start(); await f.create();
  const group = await candidatesReady(f.daemon);
  for (const id of group.candidateIds) {
    assert.equal(f.daemon.database.getJob(id)!.evidenceComplete, true);
    assert.match(readFileSync(join(f.root, 'artifacts/jobs', id, 'review-evidence.md'), 'utf8'), /^status: COMPLETE$/m);
    f.daemon.database.db.prepare('UPDATE jobs SET evidence_complete=NULL WHERE id=?').run(id);
  }
  hold.release(); hold.settle(group); runtime(f.daemon).schedule();
  const done = await terminalGroup(f.daemon);
  assert.equal(done.state, 'exhausted');
  assert.ok(jobs(f.daemon).filter(job => job.executionKind === 'rollout_review').every(job => job.reviewOutcome === 'inconclusive'));
  assert.ok(group.candidateIds.every(id => f.daemon.database.getJob(id)!.grade === null));
});
