import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DovskyDatabase } from './database.js';
import { DovskyDaemon } from './daemon.js';
import type { ExecutionEnrollment } from './isolation.js';
import type { ProcessObservation } from './execution-lease.js';
import { SystemdScopeExecutor, ScopeStartError } from './execution-scope.js';
import { command, delay, enrolled, limits, scopeFixture } from './__fixtures__/s1-scope.js';

function fixture(t: TestContext, observer?: (value: ExecutionEnrollment) => ProcessObservation) {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-scope-lease-'));
  const db = new DovskyDatabase(join(root, 'db'), {}, 200, observer);
  db.createRoom('room', 'Fixture', 'project', 'workflow');
  db.createJob({ id: 'job', roomId: 'room', provider: 'codex', projectId: 'project', workflowId: 'workflow', prompt: 'Fixture' }, 'turn');
  db.db.exec("UPDATE jobs SET state='running' WHERE id='job'");
  db.acquireResources('job', ['canonical-fixture']);
  db.prepareExecutionLease('lease', 'job', null, 'provider', 1);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, store: db };
}

test('scoped launch intent is persisted before spawn and actual gate enrollment before release', async t => {
  const { db, store } = fixture(t), f = scopeFixture();
  const spawn = f.ports.spawn;
  f.ports.spawn = (argv, env) => {
    const lease = db.executionForJob('job').leases[0]!;
    assert.equal(lease.state, 'reconcile_required'); assert.equal(lease.identity, null);
    assert.equal(lease.scopeUnit, argv.find(value => value.startsWith('--unit='))!.slice(7));
    return spawn(argv, env);
  };
  const handle = await new SystemdScopeExecutor({ ports: f.ports, graceMs: 2 }).start(command({
    onScopeStarting: intent => { store.beginScopedExecutionLease('lease', intent); },
    onEnrolled: value => { assert.equal(f.child.input.length, 0); store.enrollScopedExecutionLease('lease', value); },
  }), limits);
  assert.equal(db.executionForJob('job').leases[0]!.state, 'running');
  assert.equal(Buffer.concat(f.child.input).toString(), 'dovsky-execution-lease-release\n');
  f.state.alive = false; f.child.finish(); await delay(60); await handle.completion;
});

test('intent-only restart never releases a fence or permits another command', t => {
  const { db, store } = fixture(t);
  store.beginScopedExecutionLease('lease', { scopeUnit: enrolled.scopeUnit, bootId: enrolled.identity.bootId });
  assert.equal(db.settleExecutionLease('lease')!.state, 'reconcile_required');
  assert.equal(db.recoverInterruptedJobs(), 1);
  assert.equal(db.hasUnresolvedLeases('job'), true);
  assert.equal(db.executionForJob('job').leases[0]!.identity, null);
  assert.deepEqual(db.executionForJob('job').resources, ['canonical-fixture']);
  assert.equal(db.releaseResources('job'), false);
  assert.throws(() => db.prepareExecutionLease('second', 'job', null, 'gate', 2), /unresolved/);
});

test('scoped enrollment refuses a different unit or boot and cannot use the legacy enrollment path', t => {
  const { db, store } = fixture(t);
  store.beginScopedExecutionLease('lease', { scopeUnit: enrolled.scopeUnit, bootId: enrolled.identity.bootId });
  assert.throws(() => store.enrollScopedExecutionLease('lease', { ...enrolled, scopeUnit: 'dovsky-job-other.scope' }), /intent/);
  assert.throws(() => store.enrollScopedExecutionLease('lease', { ...enrolled, identity: { ...enrolled.identity, bootId: 'different-boot' } }), /intent/);
  assert.throws(() => db.enrollExecutionLease('lease', enrolled.identity), /prepared/);
  assert.equal(db.hasUnresolvedLeases('job'), true);
});

test('failed launch-intent persistence cannot invoke the launcher', async () => {
  const f = scopeFixture(); let spawns = 0;
  f.ports.spawn = () => { spawns++; throw new Error('must not spawn'); };
  await assert.rejects(new SystemdScopeExecutor({ ports: f.ports }).start(command({
    onScopeStarting: () => { throw new Error('intent persistence failed'); },
  }), limits), /intent persistence failed/);
  assert.equal(spawns, 0);
});

test('an un-enrolled startup cannot certify absence from a missing unit alone', async () => {
  const f = scopeFixture(); f.state.ready = 'invalid';
  await assert.rejects(new SystemdScopeExecutor({ ports: f.ports, graceMs: 1 }).start(command(), limits), error => {
    assert.ok(error instanceof ScopeStartError); assert.equal(error.enrollment, null);
    assert.equal(error.cleanupConfirmed, false); return true;
  });
});

test('enrolled restart observes outside SQLite and retains alive or unknown scope fences', t => {
  for (const state of ['alive', 'unverifiable', 'absent'] as const) {
    let calls = 0;
    const { db } = fixture(t, value => {
      assert.deepEqual(value, enrolled);
      assert.equal((db as unknown as { transactionDepth: number }).transactionDepth, 0);
      calls++; return { state, members: state === 'alive' ? [42] : [], reason: null };
    });
    db.beginScopedExecutionLease('lease', { scopeUnit: enrolled.scopeUnit, bootId: enrolled.identity.bootId });
    db.enrollScopedExecutionLease('lease', enrolled);
    assert.equal(db.recoverInterruptedJobs(), 1);
    assert.equal(calls, 1);
    assert.equal(db.executionForJob('job').leases[0]!.state, state === 'absent' ? 'exited' : 'reconcile_required');
    assert.deepEqual(db.executionForJob('job').resources, state === 'absent' ? [] : ['canonical-fixture']);
  }
});

test('settlement proves absence without releasing a running job canonical application lock', t => {
  const { db } = fixture(t, () => ({ state: 'absent', members: [], reason: null }));
  db.beginScopedExecutionLease('lease', { scopeUnit: enrolled.scopeUnit, bootId: enrolled.identity.bootId });
  db.enrollScopedExecutionLease('lease', enrolled);
  const revision = db.executionForJob('job').leases[0]!.revision;
  assert.equal(db.settleExecutionLease('lease')!.state, 'exited');
  assert.deepEqual(db.executionForJob('job').resources, ['canonical-fixture']);
  assert.throws(() => db.recordLeaseObservation('lease', revision, { state: 'absent', members: [], reason: null }), /revision/);
});

test('restart discards absence if the observed lease revision changed', t => {
  const { db } = fixture(t, () => {
    db.db.exec("UPDATE execution_leases SET revision=revision+1 WHERE id='lease'");
    return { state: 'absent', members: [], reason: null };
  });
  db.beginScopedExecutionLease('lease', { scopeUnit: enrolled.scopeUnit, bootId: enrolled.identity.bootId });
  db.enrollScopedExecutionLease('lease', enrolled);
  db.recoverInterruptedJobs();
  assert.equal(db.executionForJob('job').leases[0]!.state, 'reconcile_required');
  assert.deepEqual(db.executionForJob('job').resources, ['canonical-fixture']);
});

test('prepared means no launch attempt, while cancellation prevents enrolled release', t => {
  const first = fixture(t);
  first.db.recoverInterruptedJobs();
  assert.equal(first.db.executionForJob('job').leases[0]!.state, 'exited');
  assert.deepEqual(first.db.executionForJob('job').resources, []);
  const second = fixture(t);
  second.db.beginScopedExecutionLease('lease', { scopeUnit: enrolled.scopeUnit, bootId: enrolled.identity.bootId });
  second.db.db.exec("UPDATE jobs SET state='cancel_requested' WHERE id='job'");
  assert.throws(() => second.db.enrollScopedExecutionLease('lease', enrolled), /cancel|running|starting/);
  assert.equal(second.db.hasUnresolvedLeases('job'), true);
});

test('daemon reconciliation observes outside its idempotency transaction and replays the committed response', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-scope-rpc-'));
  const daemon = new DovskyDaemon({ socketPath: join(root, 'socket'), databasePath: join(root, 'db'),
    artifactDirectory: join(root, 'artifacts'), maxActive: 1, projects: [] });
  t.after(() => { daemon.close(); rmSync(root, { recursive: true, force: true }); });
  const db = daemon.database;
  db.createRoom('room', 'Fixture', 'project', 'workflow');
  db.createJob({ id: 'job', roomId: 'room', provider: 'codex', projectId: 'project', workflowId: 'workflow', prompt: 'Fixture' }, 'turn');
  db.db.exec("UPDATE jobs SET state='running' WHERE id='job'");
  db.acquireResources('job', ['canonical-fixture']);
  const lease = db.prepareExecutionLease('lease', 'job', null, 'provider', 1);
  const params = { leaseId: 'lease', expectedRevision: lease.revision, action: 'inspect' };
  const response = await daemon.call('executions.reconcile', params, 'scope-reconcile-fixture');
  assert.deepEqual(await daemon.call('executions.reconcile', params, 'scope-reconcile-fixture'), response);
  assert.equal(db.executionForJob('job').leases[0]!.state, 'exited');
  assert.deepEqual(db.executionForJob('job').resources, ['canonical-fixture']);
});
