import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { FixtureDaemon as DovskyDaemon, removeFixtureTree } from './__fixtures__/runtime-isolation.js';
import { DaemonError, type DaemonConfig } from './config.js';

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-quota-runtime-'));
  t.after(() => removeFixtureTree(root));
  const project = join(root, 'project');
  const git = (...argv: string[]): void => {
    const result = spawnSync('git', argv, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q', project);
  writeFileSync(join(project, 'file'), 'fixture');
  git('-C', project, 'add', 'file');
  git('-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture');
  const command = { argv: [process.execPath, new URL('./__fixtures__/quota-runtime-provider.js', import.meta.url).pathname, 'stop'] };
  const config: DaemonConfig = { socketPath: join(root, 'socket'), databasePath: join(root, 'db'),
    artifactDirectory: join(root, 'artifacts'), maxActive: 1, projects: [{ id: 'project', name: 'Fixture', path: project,
      workflows: [{ id: 'workflow', name: 'Fixture', readOnly: true, qualityCommands: [], providers: { claude: command } }] }] };
  const daemon = new DovskyDaemon(config);
  t.after(async () => { await daemon.stop(); daemon.close(); });
  const create = (force = false) => daemon.call('rooms.create', { title: 'Fixture', projectId: 'project', workflowId: 'workflow',
    prompt: 'Fixture', recipients: ['claude'], force }, randomUUID()) as Promise<{ roomId: string; jobIds: string[] }>;
  const wait = async (id: string): Promise<void> => {
    for (let n = 0; n < 250; n++) {
      const job = daemon.database.getJob(id)!;
      if (job.state === 'succeeded') return;
      assert.ok(!['failed', 'cancelled'].includes(job.state), JSON.stringify(job.failure));
      await delay(20);
    }
    assert.fail('Fixture did not finish');
  };
  daemon.start();
  return { daemon, config, command, create, wait };
}

test('Claude stream measurements survive reopen, select worst active window and guard every admission path', async t => {
  const { daemon, config, command, create, wait } = await fixture(t);
  const source = await create();
  await wait(source.jobIds[0]!);
  const quota = (await daemon.call('quota', {}) as { claude: { available: boolean; usedPercent: number; window: string } }).claude;
  assert.equal(quota.available, true); assert.equal(quota.usedPercent, 95); assert.equal(quota.window, 'five_hour');
  const reopened = new DovskyDaemon(config);
  try { assert.deepEqual((await reopened.call('quota', {}) as { claude: unknown }).claude, quota); }
  finally { reopened.close(); }
  const rejected = (promise: Promise<unknown>) => assert.rejects(promise, error => error instanceof DaemonError && error.code === 'QUOTA_EXCEEDED');
  await rejected(create());
  await rejected(daemon.call('messages.create', { roomId: source.roomId, body: 'Next', recipient: 'claude' }, randomUUID()));
  await rejected(daemon.call('handoffs.create', { sourceJobId: source.jobIds[0], targetProvider: 'claude', instruction: 'Next' }, randomUUID()));
  await daemon.call('jobs.grade', { jobId: source.jobIds[0], grade: 'bad' }, randomUUID());
  await rejected(daemon.call('jobs.retry', { jobId: source.jobIds[0] }, randomUUID()));
  command.argv[2] = 'zero';
  const forced = await create(true); await wait(forced.jobIds[0]!);
  assert.equal((await daemon.call('quota', {}) as { claude: { usedPercent: number } }).claude.usedPercent, 0);
  const next = await create(); await wait(next.jobIds[0]!);
});

test('incomplete streams and expired or future persisted readings remain unavailable to RPC and admission', async t => {
  const { daemon, command, create, wait } = await fixture(t);
  command.argv[2] = 'incomplete';
  const first = await create(); await wait(first.jobIds[0]!);
  const available = async () => (await daemon.call('quota', {}) as { claude: { available: boolean } }).claude.available;
  assert.equal(await available(), false);
  for (const recorded of [Date.now() - 6 * 3600000, Date.now() + 3600000]) {
    const reading = { windowId: 'five_hour', usedPercent: 99, windowMinutes: 300,
      recordedAt: new Date(recorded).toISOString(), resetsAt: new Date(recorded + 12 * 3600000).toISOString(), source: 'fixture' };
    daemon.database.db.prepare('INSERT OR REPLACE INTO provider_quota(provider,reading_json,recorded_at,window_minutes) VALUES(?,?,?,?)')
      .run('claude', JSON.stringify({ version: 1, windows: [reading] }), reading.recordedAt, reading.windowMinutes);
    assert.equal(await available(), false);
    const next = await create(); await wait(next.jobIds[0]!);
  }
});
