import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { QuotaWindowReading } from '@dovsky/protocol';
import { DovskyDatabase } from './database.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-quota-'));
  const db = new DovskyDatabase(join(root, 'db'));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, store: db };
}
const now = '2026-09-13T10:00:00.000Z';
const reading: QuotaWindowReading = { windowId: 'five_hour', usedPercent: 90, windowMinutes: 300,
  resetsAt: '2026-09-13T11:00:00.000Z', recordedAt: now, source: 'claude:rate_limit_event' };

test('quota persistence retains measured windows independently and selects the highest active reading', t => {
  const { db, store } = fixture(t);
  assert.equal(store.getQuota('claude', now), null);
  assert.equal(store.recordQuota('claude', reading, now), true);
  const weekly = { ...reading, windowId: 'seven_day', usedPercent: 20, windowMinutes: 10080, resetsAt: null };
  assert.equal(store.recordQuota('claude', weekly, now), true);
  assert.deepEqual(store.getQuota('claude', now), reading);
  assert.deepEqual(store.getQuota('claude', '2026-09-13T11:00:00.000Z'), weekly);
  assert.equal(store.getQuota('claude', '2026-09-20T10:00:00.000Z'), null);
  assert.equal(store.getQuota('codex', now), null);
  assert.equal(Number((db.db.prepare('SELECT count(*) AS n FROM provider_quota').get() as { n: number }).n), 1);
  const reopened = new DovskyDatabase(db.path);
  try { assert.deepEqual(reopened.getQuota('claude', now), reading); } finally { reopened.close(); }
});

test('quota updates are per-window chronological and a fresh zero reading is not unknown', t => {
  const { store } = fixture(t);
  assert.equal(store.recordQuota('claude', reading, now), true);
  assert.equal(store.recordQuota('claude', { ...reading, usedPercent: 10 }, now), false);
  assert.equal(store.recordQuota('claude', { ...reading, recordedAt: '2026-09-13T09:59:00.000Z' }, now), false);
  const later = '2026-09-13T10:01:00.000Z';
  assert.equal(store.recordQuota('claude', { ...reading, usedPercent: 0, recordedAt: later }, later), true);
  assert.equal(store.getQuota('claude', later)!.usedPercent, 0);
  assert.equal(store.getQuota('claude', now), null, 'future rows are not current measurements');
});

test('malformed, incomplete, future and expired quota inputs cannot create stored readings', t => {
  const { db, store } = fixture(t);
  for (const invalid of [null, [], {}, { ...reading, windowMinutes: null }, { ...reading, windowMinutes: 0 },
    { ...reading, usedPercent: NaN }, { ...reading, usedPercent: 101 }, { ...reading, usedPercent: -1 },
    { ...reading, recordedAt: 'invalid' }, { ...reading, recordedAt: '2026-09-14T00:00:00.000Z' },
    { ...reading, resetsAt: now }, { ...reading, source: 'x'.repeat(10000) }, { ...reading, windowId: '../bad' }]) {
    assert.equal(store.recordQuota('claude', invalid, now), false);
  }
  assert.equal(store.getQuota('claude', now), null);
  assert.equal(Number((db.db.prepare('SELECT count(*) AS n FROM provider_quota').get() as { n: number }).n), 0);
  for (const value of ['{', '[]', '{"version":1,"windows":{}}', '{"version":1,"windows":[null]}',
    JSON.stringify({ version: 1, windows: [reading, reading] }), 'x'.repeat(40000)]) {
    db.db.prepare('INSERT OR REPLACE INTO provider_quota VALUES(?,?,?,?)').run('claude', value, now, 300);
    assert.equal(store.getQuota('claude', now), null);
  }
});

test('stored quota window count stays bounded and expired entries do not consume capacity', t => {
  const { store } = fixture(t);
  for (let index = 0; index < 8; index++) assert.equal(store.recordQuota('claude', { ...reading, windowId: `window_${index}` }, now), true);
  assert.equal(store.recordQuota('claude', { ...reading, windowId: 'ninth' }, now), false);
  const later = '2026-09-13T12:00:00.000Z';
  const fresh = { ...reading, windowId: 'fresh', recordedAt: later, resetsAt: null };
  assert.equal(store.recordQuota('claude', fresh, later), true);
  assert.deepEqual(store.getQuota('claude', later), fresh);
});
