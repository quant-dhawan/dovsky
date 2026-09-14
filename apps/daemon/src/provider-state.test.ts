import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DovskyDatabase } from './database.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-provider-state-'));
  const db = new DovskyDatabase(join(root, 'db'));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.createRoom('room', 'Fixture', 'project', 'workflow');
  const job = (id: string, extra: Partial<Parameters<DovskyDatabase['createJob']>[0]> = {}) => {
    db.createJob({ id, roomId: 'room', provider: 'codex', projectId: 'project', workflowId: 'workflow', prompt: 'Fixture', ...extra }, `turn-${id}`);
    return db.getJob(id)!;
  };
  return { db, job };
}

test('new executions persist distinct opaque provider keys; the same job retains its key across reopen', t => {
  const { db, job } = fixture(t); job('first'); job('second');
  const key = db.reserveProviderState('first');
  assert.match(key, /^[A-Za-z0-9-]{1,128}$/);
  assert.equal(db.reserveProviderState('first'), key);
  assert.notEqual(db.reserveProviderState('second'), key);
  const reopened = new DovskyDatabase(db.path);
  try { assert.equal(reopened.reserveProviderState('first'), key); } finally { reopened.close(); }
});

test('resume inherits only an exact thread in direct same-provider lineage', t => {
  const { db, job } = fixture(t); job('worker');
  const key = db.reserveProviderState('worker'); db.setThreadId('worker', 'thread');
  job('followup', { predecessorJobId: 'worker', parentJobId: 'worker', resumeThreadId: 'thread' });
  assert.equal(db.reserveProviderState('followup'), key);
  job('retry', { retryOfJobId: 'followup', resumeThreadId: 'thread' });
  assert.equal(db.reserveProviderState('retry'), key);
  job('mismatch', { predecessorJobId: 'worker', resumeThreadId: 'wrong' });
  assert.throws(() => db.reserveProviderState('mismatch'), /lineage|state/);
  job('foreign', { provider: 'claude', predecessorJobId: 'worker', resumeThreadId: 'thread' });
  assert.throws(() => db.reserveProviderState('foreign'), /lineage|state/);
  job('unrelated', { resumeThreadId: 'thread' });
  assert.throws(() => db.reserveProviderState('unrelated'), /lineage|state/);
  job('source-only', { sourceJobId: 'worker', resumeThreadId: 'thread' });
  assert.throws(() => db.reserveProviderState('source-only'), /lineage|state/);
});

test('handoffs and escalations without a resume invocation receive fresh homes', t => {
  const { db, job } = fixture(t); job('worker');
  const key = db.reserveProviderState('worker'); db.setThreadId('worker', 'thread');
  job('handoff', { sourceJobId: 'worker', predecessorJobId: 'worker' });
  job('ladder', { retryOfJobId: 'worker', escalatedFrom: 'worker' });
  assert.notEqual(db.reserveProviderState('handoff'), key);
  assert.notEqual(db.reserveProviderState('ladder'), key);
});

test('legacy missing, malformed and ambiguous private state fail before any key is assigned', t => {
  const { db, job } = fixture(t); job('legacy'); db.setThreadId('legacy', 'thread');
  job('resume', { predecessorJobId: 'legacy', resumeThreadId: 'thread' });
  assert.throws(() => db.reserveProviderState('resume'), /state/);
  db.db.exec(`UPDATE jobs SET sandbox_json='{"providerStateKey":"../../operator"}' WHERE id='legacy'`);
  assert.throws(() => db.reserveProviderState('resume'), /state/);
  job('first'); job('second'); db.reserveProviderState('first'); db.reserveProviderState('second');
  db.setThreadId('first', 'shared-thread'); db.setThreadId('second', 'shared-thread');
  job('ambiguous', { predecessorJobId: 'first', parentJobId: 'second', resumeThreadId: 'shared-thread' });
  assert.throws(() => db.reserveProviderState('ambiguous'), /ambiguous/);
  assert.equal(db.getJob('resume')!.sandbox, null); assert.equal(db.getJob('ambiguous')!.sandbox, null);
});

test('state reservation preserves application metadata and never repairs malformed existing records', t => {
  const { db, job } = fixture(t); job('job');
  const metadata = { application: { state: 'pending', sentinel: 'unchanged' }, other: 7 };
  db.db.prepare('UPDATE jobs SET sandbox_json=? WHERE id=?').run(JSON.stringify(metadata), 'job');
  db.reserveProviderState('job');
  assert.deepEqual(db.getJob('job')!.sandbox?.application, metadata.application);
  assert.equal(db.getJob('job')!.sandbox?.other, 7);
  for (const invalid of ['broken', '[]', '{"providerStateKey":42}', '{"providerStateKey":"/host"}']) {
    db.db.prepare('UPDATE jobs SET sandbox_json=? WHERE id=?').run(invalid, 'job');
    assert.throws(() => db.reserveProviderState('job'), /state|metadata/);
    assert.equal(db.db.prepare('SELECT sandbox_json FROM jobs WHERE id=?').get('job')!.sandbox_json, invalid);
  }
});

test('persisted selection cannot silently switch lineage and terminal history is not rewritten', t => {
  const { db, job } = fixture(t); job('worker'); db.reserveProviderState('worker'); db.setThreadId('worker', 'thread');
  job('resume', { predecessorJobId: 'worker', resumeThreadId: 'thread' });
  const key = db.reserveProviderState('resume');
  db.db.prepare('UPDATE jobs SET sandbox_json=? WHERE id=?').run(JSON.stringify({ providerStateKey: 'different-key' }), 'worker');
  assert.throws(() => db.reserveProviderState('resume'), /changed/);
  assert.equal(db.getJob('resume')!.sandbox?.providerStateKey, key);
  db.db.exec("UPDATE jobs SET state='failed' WHERE id='resume'");
  assert.throws(() => db.reserveProviderState('resume'), /active job/);
  assert.equal(db.getJob('resume')!.sandbox?.providerStateKey, key);
});
