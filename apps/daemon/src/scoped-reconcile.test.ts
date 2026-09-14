import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DovskyDatabase } from './database.js';
import { DovskyDaemon } from './daemon.js';
import { SystemdScopeExecutor } from './execution-scope.js';
import type { ExecutionEnrollment } from './isolation.js';
import type { ProcessObservation } from './execution-lease.js';
import { command, enrolled, limits } from './__fixtures__/s1-scope.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-scoped-reconcile-'));
  const state = { observation: { state: 'alive', members: [42], reason: null } as ProcessObservation,
    signals: [] as string[], onObserve: () => {}, onSignal: async () => {} };
  const db: DovskyDatabase = new DovskyDatabase(join(root, 'db'), {}, 200, value => {
    assert.deepEqual(value, enrolled);
    assert.equal((db as unknown as { transactionDepth: number }).transactionDepth, 0);
    state.onObserve(); return state.observation;
  }, async (value: ExecutionEnrollment, signal: string) => {
    assert.deepEqual(value, enrolled);
    assert.equal((db as unknown as { transactionDepth: number }).transactionDepth, 0);
    state.signals.push(signal); await state.onSignal();
  });
  db.createRoom('room', 'Fixture', 'project', 'workflow');
  db.createJob({ id: 'job', roomId: 'room', provider: 'codex', projectId: 'project', workflowId: 'workflow', prompt: 'Fixture' }, 'turn');
  db.db.exec("UPDATE jobs SET state='running' WHERE id='job'");
  db.acquireResources('job', ['canonical-fixture']);
  db.prepareExecutionLease('lease', 'job', null, 'provider', 1);
  db.beginScopedExecutionLease('lease', { scopeUnit: enrolled.scopeUnit, bootId: enrolled.identity.bootId });
  const lease = db.enrollScopedExecutionLease('lease', enrolled);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, state, lease };
}

test('operator scoped termination signals the recorded cgroup outside SQLite and waits for observation', async t => {
  const { db, state, lease } = fixture(t);
  state.onSignal = async () => { state.observation = { state: 'absent', members: [], reason: null }; };
  const updated = await db.reconcileExecutionLease(lease.id, lease.revision, 'terminate');
  assert.deepEqual(state.signals, ['SIGTERM']);
  assert.equal(updated.state, 'exited');
  assert.deepEqual(db.executionForJob('job').resources, ['canonical-fixture']);
});

test('a successful signal alone cannot release terminal resources', async t => {
  const { db, state, lease } = fixture(t);
  db.db.exec("UPDATE jobs SET state='failed' WHERE id='job'");
  const updated = await db.reconcileExecutionLease(lease.id, lease.revision, 'terminate');
  assert.deepEqual(state.signals, ['SIGTERM']);
  assert.equal(updated.state, 'reconcile_required');
  assert.deepEqual(db.executionForJob('job').resources, ['canonical-fixture']);
  state.observation = { state: 'absent', members: [], reason: null };
  const gone = await db.reconcileExecutionLease(lease.id, updated.revision, 'inspect');
  assert.equal(gone.state, 'exited'); assert.deepEqual(db.executionForJob('job').resources, []);
});

test('unknown cgroups and intent-only leases cannot be signaled or unlocked', async t => {
  const { db, state, lease } = fixture(t);
  state.observation = { state: 'unverifiable', members: [], reason: 'inaccessible' };
  await assert.rejects(async () => db.reconcileExecutionLease(lease.id, lease.revision, 'terminate'), /authoritative|verified/);
  db.db.exec("UPDATE execution_leases SET state='reconcile_required',pid=NULL,process_group=NULL,process_start_ticks=NULL,cgroup_path=NULL WHERE id='lease'");
  await assert.rejects(async () => db.reconcileExecutionLease(lease.id, lease.revision, 'terminate'), /authoritative|verified/);
  assert.deepEqual(state.signals, []); assert.equal(db.releaseResources('job'), false);
});

test('revision drift during observation prevents signaling', async t => {
  const { db, state, lease } = fixture(t);
  state.onObserve = () => { db.db.exec("UPDATE execution_leases SET revision=revision+1 WHERE id='lease'"); };
  await assert.rejects(async () => db.reconcileExecutionLease(lease.id, lease.revision, 'terminate'), /revision|changed/);
  assert.deepEqual(state.signals, []); assert.equal(db.hasUnresolvedLeases('job'), true);
});

test('revision drift while a signal is pending cannot consume a later absence', async t => {
  const { db, state, lease } = fixture(t);
  state.onSignal = async () => {
    await Promise.resolve();
    db.db.exec("UPDATE execution_leases SET revision=revision+1 WHERE id='lease'");
    state.observation = { state: 'absent', members: [], reason: null };
  };
  await assert.rejects(async () => db.reconcileExecutionLease(lease.id, lease.revision, 'terminate'), /revision|changed/);
  assert.deepEqual(state.signals, ['SIGTERM']); assert.equal(db.hasUnresolvedLeases('job'), true);
  assert.deepEqual(db.executionForJob('job').resources, ['canonical-fixture']);
});

test('signal failure leaves the scope and resource fence unresolved', async t => {
  const { db, state, lease } = fixture(t);
  state.onSignal = async () => { throw new Error('fixture signal denied'); };
  await assert.rejects(async () => db.reconcileExecutionLease(lease.id, lease.revision, 'terminate'), /signal/);
  assert.deepEqual(state.signals, ['SIGTERM']); assert.equal(db.hasUnresolvedLeases('job'), true);
  assert.equal(db.releaseResources('job'), false);
});

test('async RPC reservation blocks duplicate pending signals and replays only the settled response', async t => {
  const { db, state, lease } = fixture(t);
  const daemon = new DovskyDaemon({ socketPath: join(db.path, '..', 'socket'), databasePath: join(db.path, '..', 'rpc-db'),
    artifactDirectory: join(db.path, '..', 'artifacts'), maxActive: 1, projects: [] });
  daemon.database.close(); Object.assign(daemon, { database: db });
  let release!: () => void;
  const pendingSignal = new Promise<void>(resolve => { release = resolve; });
  state.onSignal = async () => { await pendingSignal; state.observation = { state: 'absent', members: [], reason: null }; };
  const params = { leaseId: lease.id, expectedRevision: lease.revision, action: 'terminate' };
  const pending = daemon.call('executions.reconcile', params, 'reconcile-pending');
  assert.deepEqual(state.signals, ['SIGTERM']);
  await assert.rejects(daemon.call('executions.reconcile', params, 'reconcile-pending'), { code: 'RECONCILE_REQUIRED' });
  assert.equal(db.hasUnresolvedLeases('job'), true);
  release(); const result = await pending;
  assert.deepEqual(await daemon.call('executions.reconcile', params, 'reconcile-pending'), result);
  assert.deepEqual(state.signals, ['SIGTERM']);
});

test('native operator reconciliation terminates a disposable enrolled systemd scope', { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-scoped-reconcile-host-'));
  const db = new DovskyDatabase(join(root, 'db'));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.createRoom('room', 'Fixture', 'project', 'workflow');
  db.createJob({ id: 'job', roomId: 'room', provider: 'codex', projectId: 'project', workflowId: 'workflow', prompt: 'Fixture' }, 'turn');
  db.db.exec("UPDATE jobs SET state='running' WHERE id='job'");
  db.acquireResources('job', ['canonical-fixture']);
  db.prepareExecutionLease('lease', 'job', null, 'provider', 1);
  let handle;
  try {
    handle = await new SystemdScopeExecutor().start(command({ argv: ['/usr/bin/sleep', '30'], timeoutMs: 5000,
      onScopeStarting: intent => { db.beginScopedExecutionLease('lease', intent); },
      onEnrolled: enrollment => { db.enrollScopedExecutionLease('lease', enrollment); } }), limits);
  } catch (error) {
    if (process.env.DOVSKY_REQUIRE_SANDBOX === '1') throw error;
    t.skip(`Native systemd scope unavailable: ${String(error)}`); return;
  }
  try {
    const lease = db.executionForJob('job').leases[0]!;
    const signaled = await db.reconcileExecutionLease(lease.id, lease.revision, 'terminate');
    const completed = await handle.completion;
    assert.equal(completed.timedOut, false, 'Operator termination must finish before the lifecycle deadline');
    const settled = await db.reconcileExecutionLease(lease.id, signaled.revision, 'inspect');
    assert.equal(settled.state, 'exited'); assert.equal((await handle.observe()).state, 'absent');
    assert.deepEqual(db.executionForJob('job').resources, ['canonical-fixture']);
  } finally { await handle.signal('SIGKILL'); await handle.completion; }
});
