import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DovskyDatabase } from './database.js';
import { CoordinationStore } from './coordination.js';
import { applicationPending, type CanonicalApplication } from './application-state.js';

const hash = 'a'.repeat(64), finalHash = 'b'.repeat(64);
const application: Omit<CanonicalApplication, 'state'> = { canonicalPath: '/fixture/project',
  intentPath: '/fixture/artifacts/apply.json', baselinePath: '/fixture/artifacts/baseline', finalPath: '/fixture/artifacts/final',
  expected: { fingerprint: hash, contentHash: hash }, contentHash: finalHash };
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-application-'));
  const db = new DovskyDatabase(join(root, 'db'));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.createRoom('room', 'Fixture', 'project', 'workflow');
  db.createJob({ id: 'job', roomId: 'room', provider: 'codex', projectId: 'project', workflowId: 'workflow', prompt: 'Fixture' }, 'turn');
  db.db.exec("UPDATE jobs SET state='running' WHERE id='job'");
  db.acquireResources('job', ['worktree:/fixture/project']);
  db.prepareExecutionLease('lease', 'job', null, 'provider', 1);
  db.settleExecutionLease('lease');
  return { db, root };
}

test('application reservation survives reopen and retains locks after known command absence on restart', t => {
  const { db, root } = fixture(t);
  db.beginCanonicalApplication('job', application);
  const reopened = new DovskyDatabase(join(root, 'db'));
  try {
    assert.equal(reopened.hasPendingApplication('job'), true);
    assert.equal(reopened.recoverInterruptedJobs(), 1);
    assert.deepEqual(reopened.executionForJob('job').leases.map(lease => [lease.id, lease.state]), [['lease', 'exited']]);
    assert.equal(reopened.hasUnresolvedExecution('job'), true);
    assert.equal(reopened.releaseResources('job'), false);
    assert.deepEqual(reopened.executionForJob('job').resources, ['worktree:/fixture/project']);
    assert.throws(() => reopened.prepareExecutionLease('other', 'job', null, 'gate', 2), /application/);
  } finally { reopened.close(); }
});

test('dependency invalidation is atomic with application intent and persists across completion and reopen', t => {
  const { db, root } = fixture(t);
  assert.equal(db.canonicalDependenciesAllowed(application.canonicalPath), true);
  assert.throws(() => db.invalidateCanonicalDependencies('job', application.canonicalPath), /pending canonical application/);
  assert.throws(() => db.transaction(() => {
    db.beginCanonicalApplication('job', application);
    db.invalidateCanonicalDependencies('job', application.canonicalPath);
    throw new Error('fixture rollback');
  }), /fixture rollback/);
  assert.equal(db.hasPendingApplication('job'), false);
  assert.equal(db.canonicalDependenciesAllowed(application.canonicalPath), true);
  db.transaction(() => {
    db.beginCanonicalApplication('job', application);
    db.invalidateCanonicalDependencies('job', application.canonicalPath);
  });
  assert.equal(db.canonicalDependenciesAllowed(application.canonicalPath), false);
  assert.equal(db.canonicalDependenciesAllowed('/fixture/other'), true);
  db.completeCanonicalApplication('job', application.intentPath, { fingerprint: hash, contentHash: finalHash });
  const reopened = new DovskyDatabase(join(root, 'db'));
  try {
    assert.equal(reopened.canonicalDependenciesAllowed(application.canonicalPath), false);
    reopened.db.prepare('UPDATE daemon_settings SET value=? WHERE key=?').run('{broken', `dependency-origin:${application.canonicalPath}`);
    assert.equal(reopened.canonicalDependenciesAllowed(application.canonicalPath), false);
  } finally { reopened.close(); }
});

test('only matching completed application proof clears its guard and a running job keeps its reservation', t => {
  const { db } = fixture(t);
  db.beginCanonicalApplication('job', application);
  assert.throws(() => db.beginCanonicalApplication('job', application), /absence/);
  assert.throws(() => db.completeCanonicalApplication('job', '/fixture/wrong', { fingerprint: hash, contentHash: finalHash }), /identity/);
  assert.throws(() => db.completeCanonicalApplication('job', application.intentPath, { fingerprint: hash, contentHash: hash }), /identity/);
  assert.equal(db.hasPendingApplication('job'), true);
  db.completeCanonicalApplication('job', application.intentPath, { fingerprint: hash, contentHash: finalHash });
  assert.equal(db.hasPendingApplication('job'), false);
  assert.deepEqual(db.executionForJob('job').resources, ['worktree:/fixture/project']);
  assert.equal(db.getJob('job')!.endContentHash, finalHash);
  assert.throws(() => db.completeCanonicalApplication('job', application.intentPath, { fingerprint: hash, contentHash: finalHash }), /identity/);
});

test('application refuses absent worktree reservation and unresolved command', t => {
  const { db } = fixture(t);
  db.releaseResources('job');
  assert.throws(() => db.beginCanonicalApplication('job', application), /reservation/);
  db.acquireResources('job', ['worktree:/fixture/project']);
  db.prepareExecutionLease('other', 'job', null, 'provider', 2);
  assert.throws(() => db.beginCanonicalApplication('job', application), /absence/);
  assert.equal(db.getJob('job')!.jobDeltaPath, null);
});

test('known exited lease history without application does not become an invented unknown legacy execution', t => {
  const { db } = fixture(t);
  db.recoverInterruptedJobs();
  assert.equal(db.hasUnresolvedExecution('job'), false);
  assert.deepEqual(db.executionForJob('job').resources, []);
  assert.deepEqual(db.executionForJob('job').leases.map(lease => lease.id), ['lease']);
});

test('task completion, checkpoint rebind and terminal cleanup retain pending application ownership', t => {
  const { db } = fixture(t), coordination = new CoordinationStore(db);
  const taskId = db.getJob('job')!.taskId!;
  coordination.claim(taskId, '/fixture/project', true);
  db.beginCanonicalApplication('job', application);
  coordination.setState(taskId, { outcome: 'completed', phase: 'Reported complete', blocker: null, nextAction: null, acknowledgedControls: [] });
  assert.ok(db.db.prepare('SELECT task_id FROM task_ownership WHERE task_id=?').get(taskId));
  db.db.exec("UPDATE jobs SET state='failed' WHERE id='job'");
  assert.equal(db.releaseTaskOwnershipIfSafe('job'), false);
  coordination.setState(taskId, { outcome: 'checkpointed', phase: 'Inspect', blocker: null, nextAction: null, acknowledgedControls: [] });
  assert.throws(() => coordination.rebind(taskId, '/fixture/new-project', true), /reconciliation/);
  db.completeCanonicalApplication('job', application.intentPath, { fingerprint: hash, contentHash: finalHash });
  assert.equal(db.releaseTaskOwnershipIfSafe('job'), true);
});

test('malformed application metadata fails closed; unrelated valid metadata remains compatible', () => {
  for (const serialized of ['{', 'null', '[]', '{"application":null}', '{"application":{"state":"complete"}}']) {
    assert.equal(applicationPending(serialized), true, serialized);
  }
  assert.equal(applicationPending(null), false);
  assert.equal(applicationPending('{"backend":"bwrap"}'), false);
  assert.equal(applicationPending(JSON.stringify({ application: { ...application, state: 'pending' } })), true);
  assert.equal(applicationPending(JSON.stringify({ application: { ...application, state: 'complete' } })), false);
});
