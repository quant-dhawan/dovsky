import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { Provider, RoutingArm, Tier } from '@dovsky/protocol';
import { FixtureDaemon, removeFixtureTree } from './__fixtures__/runtime-isolation.js';
import { gitBytes } from './git.js';
import { resolveBandit, type DaemonConfig } from './config.js';
import type { StoredJob } from './model.js';

const providerFixture = new URL('./__fixtures__/review-runtime.js', import.meta.url).pathname;
function fixture(t: TestContext, mode = 'json', provider: Provider = 'claude', verdict = 'approved') {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-review-routing-'));
  const project = join(root, 'project');
  gitBytes(root, ['init', '-q', project]);
  writeFileSync(join(project, 'tracked.txt'), 'baseline\n');
  gitBytes(project, ['add', '.']);
  gitBytes(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const config: DaemonConfig = { socketPath: join(root, 'run/socket'), databasePath: join(root, 'state/db'),
    artifactDirectory: join(root, 'artifacts'), maxActive: 3,
    routing: { bandit: { decay: 0.5 } }, projects: [{ id: 'p', name: 'Fixture', path: project, workflows: [
      { id: 'work', name: 'Work', readOnly: false, qualityCommands: [], providers: {
        codex: { argv: [process.execPath, providerFixture, 'work', 'codex'] },
        claude: { argv: [process.execPath, providerFixture, 'work', 'claude'] },
      }, review: { enabled: true, provider, tier: 'hard', maxCorrections: 0, small: null } },
      { id: 'review', name: 'Review', readOnly: true, qualityCommands: [], providerTimeoutMs: 1000,
        providers: { [provider]: { argv: [process.execPath, providerFixture, 'invalid', provider],
          reviewArgv: [process.execPath, providerFixture, mode, provider, verdict] } } },
    ] }] };
  let daemon = new FixtureDaemon(config);
  t.after(async () => { await daemon.stop(); daemon.close(); removeFixtureTree(root); });
  return { root, project, config, get daemon() { return daemon; }, reopen: async () => {
    await daemon.stop(); daemon.close(); daemon = new FixtureDaemon(config); return daemon;
  } };
}
async function create(daemon: FixtureDaemon, params: Record<string, unknown> = {}) {
  const value = await daemon.call('rooms.create', { title: 'Fixture', projectId: 'p', workflowId: 'work', prompt: 'Make a change',
    recipients: ['codex'], force: true, ...params }, randomUUID()) as { roomId: string; jobIds: string[] };
  return { roomId: value.roomId, jobId: value.jobIds[0]! };
}
async function settled(daemon: FixtureDaemon, workerId: string): Promise<StoredJob[]> {
  for (let n = 0; n < 750; n++) {
    const reviews = daemon.database.db.prepare('SELECT id FROM jobs WHERE review_of=? ORDER BY review_round').all(workerId)
      .map(row => daemon.database.getJob(String(row.id))!);
    if (reviews.length && reviews.every(job => ['succeeded', 'failed', 'cancelled'].includes(job.state))) return reviews;
    await delay(20);
  }
  assert.fail(`Review did not settle: ${JSON.stringify(daemon.database.db.prepare('SELECT id,state,failure_json FROM jobs').all())}`);
}
const events = (daemon: FixtureDaemon, type: string) => daemon.database.db.prepare('SELECT data_json FROM events WHERE type=? ORDER BY id').all(type)
  .map(row => JSON.parse(String(row.data_json)) as Record<string, unknown>);
const arm = (daemon: FixtureDaemon, tier: Tier = 'routine') => daemon.database.listRoutingArms('codex/work/-').find(value => value.tier === tier)!;
const counts = (value: RoutingArm) => [value.alpha, value.beta, value.successes, value.failures];

async function finishedWorker(daemon: FixtureDaemon): Promise<string> {
  const { jobId } = await create(daemon, { tier: 'routine', review: 'none' });
  daemon.database.transitionJob(jobId, ['queued'], 'starting', { startedAt: new Date().toISOString() });
  daemon.database.transitionJob(jobId, ['starting'], 'running');
  daemon.database.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(jobId);
  daemon.database.transitionJob(jobId, ['running'], 'succeeded', { finishedAt: new Date().toISOString() });
  return jobId;
}
function reviewerFor(f: ReturnType<typeof fixture>, workerId: string, extra: Partial<StoredJob> = {}): string {
  const id = randomUUID(), worker = f.daemon.database.getJob(workerId)!;
  f.daemon.database.createJob({ id, roomId: worker.roomId, projectId: 'p', workflowId: 'review', provider: 'codex',
    role: 'review', executionKind: 'review', reviewOf: workerId, reviewRound: 1,
    reviewCommit: gitBytes(f.project, ['rev-parse', 'HEAD']).toString().trim(), evidenceComplete: true,
    prompt: 'Frozen fixture evidence', tier: 'hard', model: 'gpt-5.6-terra', effort: 'xhigh',
    review: { target: 'codex', tier: 'hard', corrections: 0 }, ...extra }, randomUUID());
  return id;
}

for (const provider of ['claude', 'codex'] as const) test(`${provider} structured review runs schema argv and grades the worker exactly once`, async t => {
  const f = fixture(t, 'json', provider); f.daemon.start();
  const { jobId } = await create(f.daemon, { tier: 'routine' });
  const reviews = await settled(f.daemon, jobId);
  assert.equal(reviews.length, 1); assert.equal(reviews[0]!.reviewOutcome, 'approved');
  assert.equal(reviews[0]!.verdictJson?.confidence, 0.9);
  const worker = f.daemon.database.getJob(jobId)!;
  assert.equal(worker.grade, 'good'); assert.equal(worker.gradeSource, 'reviewer');
  assert.equal(worker.armSource, 'explicit'); assert.equal(worker.requestedModel, null);
  assert.equal(worker.modelIdentity, 'configured_unverified');
  assert.deepEqual(counts(arm(f.daemon)), [3, 1, 1, 0]);
  const before = counts(arm(f.daemon)); f.daemon.database.updateRoutingReward(jobId);
  assert.deepEqual(counts(arm(f.daemon)), before);
  assert.equal(f.daemon.database.getJobSummary(jobId).review?.outcome, 'approved');
  const argv = JSON.parse(String(f.daemon.database.db.prepare('SELECT argv_json FROM attempts WHERE job_id=?').get(reviews[0]!.id)!.argv_json)) as string[];
  assert.ok(argv.includes(provider === 'claude' ? '--json-schema' : '--output-schema'));
  assert.equal(events(f.daemon, 'review.fallback').length, 0);
});

for (const mode of ['json', 'empty', 'prose'] as const) test(`${mode} refutation persists reasons without inventing a protocol failure`, async t => {
  const f = fixture(t, mode, 'codex', 'refuted'); f.daemon.start();
  const { jobId } = await create(f.daemon, { tier: 'routine' });
  const [review] = await settled(f.daemon, jobId);
  assert.equal(review!.reviewOutcome, 'refuted'); assert.equal(review!.failure, null);
  const worker = f.daemon.database.getJob(jobId)!;
  assert.equal(worker.grade, 'bad'); assert.equal(worker.gradeSource, 'reviewer');
  if (mode === 'json') {
    assert.equal(review!.verdictJson!.reasons.length, 2);
    assert.match(worker.gradeNote!, /changed.txt:2 — First defect/);
  } else if (mode === 'empty') assert.equal(review!.verdictJson!.reasonsMissing, true);
  assert.equal(events(f.daemon, 'review.fallback').length, mode === 'prose' ? 1 : 0);
  assert.deepEqual(counts(arm(f.daemon)), [2, 2, 0, 1]);
});

for (const mode of ['last', 'invalid', 'last-invalid', 'last-link'] as const) test(`Codex ${mode} final output has a fail-closed durable outcome`, async t => {
  const f = fixture(t, mode, 'codex'); f.daemon.start();
  const { jobId, roomId } = await create(f.daemon, { tier: 'routine' });
  const reviews = await settled(f.daemon, jobId);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.reviewOutcome, mode === 'last' ? 'approved' : 'protocol_failed');
  if (mode !== 'last') {
    assert.equal(reviews[0]!.failure?.code, 'review_protocol');
    assert.equal(f.daemon.database.getJob(jobId)!.grade, null);
    assert.equal(events(f.daemon, 'review.failed')[0]!.retried, false);
    assert.equal(f.daemon.database.roomSummary(f.daemon.database.getRoomRow(roomId)!).needsAttention, true);
    assert.deepEqual(counts(arm(f.daemon)), [3, 1, 0, 0]);
  }
});

for (const mode of ['crash', 'hang'] as const) test(`${mode} reviewer retries once at the same tier and never grades the worker`, async t => {
  const f = fixture(t, mode, 'codex'); f.daemon.start();
  const { jobId, roomId } = await create(f.daemon, { tier: 'routine' });
  const reviews = await settled(f.daemon, jobId);
  assert.equal(reviews.length, 2);
  assert.equal(reviews[1]!.reviewRetryOf, reviews[0]!.id);
  assert.deepEqual(reviews.map(job => [job.tier, job.reviewRound, job.reviewOutcome, job.attemptCount]),
    [['hard', 1, 'reviewer_failed', 1], ['hard', 2, 'reviewer_failed', 1]]);
  assert.equal(reviews[0]!.prompt, reviews[1]!.prompt);
  assert.equal(f.daemon.database.getJob(jobId)!.grade, null);
  assert.match(f.daemon.database.getJob(jobId)!.reviewSkipped!, /^reviewer /);
  assert.deepEqual(events(f.daemon, 'review.failed').map(event => event.retried), [true, false]);
  assert.equal(f.daemon.database.roomSummary(f.daemon.database.getRoomRow(roomId)!).review, 'reviewer_failed');
  assert.equal(f.daemon.database.roomSummary(f.daemon.database.getRoomRow(roomId)!).needsAttention, true);
  assert.equal(f.daemon.database.db.prepare('SELECT count(*) AS n FROM routing_rewards').get()!.n, 0);
});

test('default arm selection, allowed pins, explicit and inherited attribution, CLI reset/unpin shapes and job-origin denial', async t => {
  const f = fixture(t);
  const first = await create(f.daemon, { review: 'none' });
  assert.equal(f.daemon.database.getJob(first.jobId)!.armSource, 'bandit');
  await f.daemon.call('routing.set', { key: 'codex/work/-', tier: 'hard' }, randomUUID());
  const pinned = await create(f.daemon, { review: 'none' });
  assert.equal(f.daemon.database.getJob(pinned.jobId)!.tier, 'hard');
  assert.equal(f.daemon.database.getJob(pinned.jobId)!.armSource, 'operator-pinned');
  const explicit = await create(f.daemon, { tier: 'quick', review: 'none' });
  assert.equal(f.daemon.database.getJob(explicit.jobId)!.armSource, 'explicit');
  const followup = await f.daemon.call('messages.create', { roomId: explicit.roomId, body: 'Follow up', recipient: 'codex' }, randomUUID()) as { jobIds: string[] };
  assert.equal(f.daemon.database.getJob(followup.jobIds[0]!)!.armSource, 'inherited');
  assert.equal(f.daemon.database.getJob(followup.jobIds[0]!)!.tier, 'quick');
  const params = { provider: 'codex', workflowId: 'work', charter: null };
  await f.daemon.call('routing.unpin', params, randomUUID());
  assert.equal(f.daemon.database.listRoutingArms('codex/work/-').some(arm => arm.pinned), false);
  await f.daemon.call('routing.reset', { ...params, tier: 'routine' }, randomUUID());
  assert.deepEqual(counts(arm(f.daemon)), [1, 1, 0, 0]);
  f.daemon.database.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(first.jobId);
  for (const method of ['routing.set', 'routing.unpin', 'routing.reset']) {
    await assert.rejects(f.daemon.call(method, params, randomUUID(), { kind: 'job', jobId: first.jobId }), { code: 'FORBIDDEN' });
  }
  const listing = await f.daemon.call('routing.list', {}) as { arms: Array<RoutingArm & { mean: number; n: number; cost: number }> };
  assert.ok(listing.arms.every(arm => arm.mean > 0 && arm.mean < 1 && Number.isFinite(arm.n) && arm.cost > 0));
});

test('effective rewards replace older contributions with decay, survive restart, and ignore repeated/lower-priority grades', async t => {
  const f = fixture(t);
  const ids: string[] = [];
  for (let n = 0; n < 2; n++) {
    const { jobId } = await create(f.daemon, { tier: 'routine', review: 'none' }); ids.push(jobId);
    const db = f.daemon.database;
    db.transitionJob(jobId, ['queued'], 'starting', { startedAt: new Date().toISOString() });
    db.transitionJob(jobId, ['starting'], 'running');
    db.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(jobId);
    db.transitionJob(jobId, ['running'], 'succeeded', { finishedAt: new Date().toISOString() });
    db.gradeJob(jobId, 'good', 'review', 'reviewer');
  }
  assert.deepEqual(counts(arm(f.daemon)), [3, 1, 2, 0]);
  await f.daemon.call('jobs.grade', { jobId: ids[0], grade: 'bad' }, randomUUID());
  assert.deepEqual(counts(arm(f.daemon)), [2.5, 1.5, 1, 1]);
  const before = counts(arm(f.daemon));
  f.daemon.database.updateRoutingReward(ids[0]!);
  f.daemon.database.updateRoutingReward(ids[1]!);
  f.daemon.database.gradeJob(ids[0]!, 'good', 'lower priority', 'reviewer');
  await f.daemon.call('jobs.grade', { jobId: ids[0], grade: 'bad' }, randomUUID());
  assert.deepEqual(counts(arm(f.daemon)), before);
  await f.reopen(); f.daemon.database.updateRoutingReward(ids[0]!); f.daemon.database.updateRoutingReward(ids[1]!);
  assert.deepEqual(counts(arm(f.daemon)), before);
  assert.equal(f.daemon.database.db.prepare('SELECT count(*) AS n FROM routing_rewards').get()!.n, 2);
  assert.equal(f.daemon.database.routingArmMean(ids[0]!), 2.5 / 4);
  const observation = events(f.daemon, 'routing.observation.v1')[0]!;
  assert.equal(observation.armSource, 'explicit'); assert.equal(observation.armMean, 0.75);
});

test('single-rung ladders widen, fixed charters do not, and the disabled switch retains legacy policy', async t => {
  const f = fixture(t);
  mkdirSync(join(f.project, '.claude/agents'), { recursive: true });
  writeFileSync(join(f.project, '.claude/agents/Wide.md'), '---\nbus:\n  allowed: [codex/quick]\n---\nFixture');
  writeFileSync(join(f.project, '.claude/agents/Fixed.md'), '---\nbus:\n  allowed: [codex/hard]\n  fixed: true\n---\nFixture');
  await f.daemon.call('routing.set', { key: 'codex/work/Wide', tier: 'hard' }, randomUUID());
  const wide = await create(f.daemon, { charter: 'Wide', review: 'none' });
  assert.equal(f.daemon.database.getJob(wide.jobId)!.tier, 'hard');
  const fixed = await create(f.daemon, { charter: 'Fixed', review: 'none' });
  assert.equal(f.daemon.database.getJob(fixed.jobId)!.tier, 'hard');
  assert.equal(f.daemon.database.getJob(fixed.jobId)!.armSource, 'charter-fixed');
  f.config.routing = { bandit: { enabled: false } }; f.daemon.database.routingBandit = resolveBandit(f.config);
  const legacy = await create(f.daemon, { charter: 'Wide', review: 'none' });
  assert.equal(f.daemon.database.getJob(legacy.jobId)!.tier, 'quick');
});

test('structured approval on incomplete evidence is inconclusive and leaves the arm unchanged', async t => {
  const f = fixture(t, 'json', 'codex'), workerId = await finishedWorker(f.daemon);
  reviewerFor(f, workerId, { evidenceComplete: false }); f.daemon.start();
  const [reviewer] = await settled(f.daemon, workerId);
  assert.equal(reviewer!.reviewOutcome, 'inconclusive'); assert.equal(reviewer!.verdict, 'inconclusive');
  assert.equal(reviewer!.verdictJson!.verdict, 'approved');
  assert.equal(f.daemon.database.getJob(workerId)!.grade, null);
  assert.deepEqual(counts(arm(f.daemon)), [3, 1, 0, 0]);
});

test('restart settles interrupted review, retries frozen evidence once, and does not repeat settlement on another start', async t => {
  const f = fixture(t, 'json', 'codex'), workerId = await finishedWorker(f.daemon);
  const id = reviewerFor(f, workerId), db = f.daemon.database;
  db.transitionJob(id, ['queued'], 'starting'); db.transitionJob(id, ['starting'], 'running');
  db.prepareExecutionLease('recovered-review-lease', id, null, 'provider', 1);
  db.db.prepare("UPDATE execution_leases SET state='exited',exited_at=? WHERE id=?").run(new Date().toISOString(), 'recovered-review-lease');
  f.daemon.start();
  const reviews = await settled(f.daemon, workerId);
  assert.equal(reviews.length, 2); assert.equal(reviews[0]!.failure?.code, 'daemon_restart');
  assert.equal(reviews[0]!.reviewOutcome, 'reviewer_failed');
  assert.equal(reviews[1]!.reviewRetryOf, id); assert.equal(reviews[1]!.reviewOutcome, 'approved');
  assert.equal(reviews[1]!.prompt, reviews[0]!.prompt);
  const before = counts(arm(f.daemon)); await f.reopen(); f.daemon.start();
  assert.equal(events(f.daemon, 'review.retried').length, 1);
  assert.deepEqual(counts(arm(f.daemon)), before);
});

test('restart review failure with a full queue is terminal and visible to the operator', async t => {
  const f = fixture(t, 'json', 'codex'), workerId = await finishedWorker(f.daemon);
  const id = reviewerFor(f, workerId), db = f.daemon.database;
  db.transitionJob(id, ['queued'], 'starting'); db.prepareExecutionLease('capacity-review-lease', id, null, 'provider', 1);
  db.db.prepare("UPDATE execution_leases SET state='exited',exited_at=? WHERE id=?").run(new Date().toISOString(), 'capacity-review-lease');
  for (let n = 0; n < 20; n++) db.createJob({ id: `queued-${n}`, roomId: db.getJob(workerId)!.roomId,
    projectId: 'p', workflowId: 'work', provider: 'codex', prompt: 'Queued fixture' }, randomUUID());
  await f.daemon.call('daemon.drain', { enabled: true }, randomUUID()); f.daemon.start();
  assert.equal(db.latestReview(workerId)!.id, id);
  assert.equal(db.getJob(id)!.reviewOutcome, 'reviewer_failed');
  assert.equal(events(f.daemon, 'review.retried').length, 0);
  assert.equal(events(f.daemon, 'review.failed')[0]!.retried, false);
  assert.equal(db.getJob(workerId)!.grade, null); assert.ok(db.getJob(workerId)!.reviewSkipped);
});

test('auxiliary rollout reviewer failure never starts an individual retry or grades its worker', async t => {
  const f = fixture(t, 'crash', 'codex'), workerId = await finishedWorker(f.daemon);
  reviewerFor(f, workerId, { executionKind: 'rollout_review' }); f.daemon.start();
  const reviews = await settled(f.daemon, workerId);
  assert.equal(reviews.length, 1); assert.equal(reviews[0]!.reviewOutcome, 'reviewer_failed');
  assert.equal(events(f.daemon, 'review.failed')[0]!.retried, false);
  assert.equal(f.daemon.database.getJob(workerId)!.grade, null);
  assert.equal(f.daemon.database.getJob(workerId)!.reviewSkipped, null);
});

test('persisted incomplete, agent, environmental and mismatched evidence cannot reward even after replay', async t => {
  const f = fixture(t), db = f.daemon.database;
  const incomplete = await finishedWorker(f.daemon);
  db.gradeJob(incomplete, 'bad', 'incomplete', 'reviewer', false);
  db.updateRoutingReward(incomplete); assert.equal(arm(f.daemon).failures, 0);
  const mismatch = await finishedWorker(f.daemon); db.setReportedModel(mismatch, 'different-model');
  db.gradeJob(mismatch, 'good', 'human', 'human');
  const advice = await finishedWorker(f.daemon); db.gradeJob(advice, 'bad', 'advice', 'agent');
  assert.equal(db.getJob(advice)!.cause, null);
  const environmental = await create(f.daemon, { tier: 'routine', review: 'none' });
  db.transitionJob(environmental.jobId, ['queued'], 'failed', { failure: { code: 'provider_auth', summary: 'Fixture auth error',
    retryable: false, resumable: false, exitCode: 1, signal: null, occurredAt: new Date().toISOString() } });
  db.gradeJob(environmental.jobId, 'bad', 'operator', 'human');
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM routing_rewards').get()!.n, 0);
  await f.daemon.call('jobs.grade', { jobId: incomplete, grade: 'good' }, randomUUID());
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM routing_rewards').get()!.n, 1);
  assert.equal(arm(f.daemon).successes, 1);
});

for (const tier of ['quick', 'routine', 'hard'] as const) test(`capability failure at ${tier} escalates to the next available allowed arm`, async t => {
  const f = fixture(t), expected = tier === 'quick' ? ['codex', 'routine'] : tier === 'routine' ? ['codex', 'hard'] : ['claude', 'routine'];
  mkdirSync(join(f.project, '.claude/agents'), { recursive: true });
  writeFileSync(join(f.project, '.claude/agents/Mixed.md'), `---\nbus:\n  allowed: [codex/quick, ${tier === 'routine' ? 'codex/hard, ' : ''}claude/routine]\n---\nFixture`);
  gitBytes(f.project, ['add', '.']); gitBytes(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'charter']);
  f.config.projects[0]!.workflows[0]!.qualityCommands = [[process.execPath, '-e', "process.exit(require('node:fs').existsSync('changed.txt')?1:0)"]];
  const { jobId } = await create(f.daemon, { tier, charter: 'Mixed', review: 'none' }); f.daemon.start();
  let next: StoredJob | null = null;
  for (let n = 0; n < 750; n++) {
    const row = f.daemon.database.db.prepare('SELECT id FROM jobs WHERE escalated_from=?').get(jobId);
    if (row) { next = f.daemon.database.getJob(String(row.id)); break; }
    await delay(20);
  }
  assert.ok(next, JSON.stringify(f.daemon.database.getJob(jobId)));
  assert.deepEqual([next.provider, next.tier], expected); assert.equal(next.armSource, 'ladder-floor');
  assert.equal(f.daemon.database.getJob(jobId)!.failure!.code, 'quality_gate');
  assert.equal(f.daemon.database.listRoutingArms('codex/work/Mixed').find(arm => arm.tier === tier)!.failures, 1);
  const rung = events(f.daemon, 'routing.rung').at(-1)!;
  assert.equal(rung.source, 'ladder-floor'); assert.equal(typeof rung.mean, 'number');
});

test('later configuration changes do not retroactively change an earlier reward decay on override', async t => {
  const f = fixture(t), first = await finishedWorker(f.daemon);
  f.daemon.database.gradeJob(first, 'good', 'review', 'reviewer');
  f.daemon.database.routingBandit = { ...resolveBandit(f.config), decay: 0.25 };
  const second = await finishedWorker(f.daemon); f.daemon.database.gradeJob(second, 'good', 'review', 'reviewer');
  assert.deepEqual(counts(arm(f.daemon)), [2.5, 1, 2, 0]);
  f.daemon.database.gradeJob(first, 'bad', 'override', 'human');
  assert.deepEqual(counts(arm(f.daemon)), [2.25, 1.25, 1, 1]);
});

test('seeded historical rewards decay only once for a new observation and remain replaceable', async t => {
  const f = fixture(t), db = f.daemon.database, first = await finishedWorker(f.daemon), second = await finishedWorker(f.daemon);
  for (const id of [first, second]) db.db.prepare(`INSERT INTO routing_rewards(execution_job_id,key,tier,source,reward,model_identity,recorded_at)
    VALUES(?,'codex/work/-','routine','gate',1,'configured_unverified',?)`).run(id, new Date().toISOString());
  db.db.prepare("UPDATE routing_arms SET alpha=5,successes=2 WHERE key='codex/work/-' AND tier='routine'").run();
  const third = await finishedWorker(f.daemon); db.gradeJob(third, 'good', 'review', 'reviewer');
  assert.deepEqual(counts(arm(f.daemon)), [4, 1, 3, 0]);
  db.gradeJob(first, 'bad', 'override', 'human');
  assert.deepEqual(counts(arm(f.daemon)), [3.5, 1.5, 2, 1]);
  db.updateRoutingReward(first); assert.deepEqual(counts(arm(f.daemon)), [3.5, 1.5, 2, 1]);
});

test('a queued followup cannot replace the earlier execution outcome used for human regrading', async t => {
  const f = fixture(t), db = f.daemon.database, first = await finishedWorker(f.daemon);
  db.db.prepare('UPDATE jobs SET result=? WHERE id=?').run('DOVSKY_RESULT: {"outcome":"completed","phase":"Done","blocker":null,"nextAction":null,"acknowledgedControls":[]}', first);
  db.gradeJob(first, 'good', 'review', 'reviewer');
  await f.daemon.call('messages.create', { roomId: db.getJob(first)!.roomId, body: 'Next leg', recipient: 'codex', review: 'none' }, randomUUID());
  assert.equal(db.getJob(first)!.taskOutcome, 'working');
  db.gradeJob(first, 'bad', 'override', 'human');
  assert.deepEqual(counts(arm(f.daemon)), [2, 2, 0, 1]);
});

test('an advisory agent grade cannot retract an existing capability-gate contribution', async t => {
  const f = fixture(t), db = f.daemon.database, { jobId } = await create(f.daemon, { tier: 'routine', review: 'none' });
  db.transitionJob(jobId, ['queued'], 'failed', { failure: { code: 'quality_gate', summary: 'Fixture failed gate',
    retryable: false, resumable: false, exitCode: 1, signal: null, occurredAt: new Date().toISOString() } });
  assert.deepEqual(counts(arm(f.daemon)), [2, 2, 0, 1]);
  db.gradeJob(jobId, 'good', 'advice', 'agent'); db.updateRoutingReward(jobId);
  assert.equal(db.getJob(jobId)!.cause, 'capability');
  assert.deepEqual(counts(arm(f.daemon)), [2, 2, 0, 1]);
});
