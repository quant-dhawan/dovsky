import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { FixtureDaemon, removeFixtureTree } from './__fixtures__/runtime-isolation.js';
import { gitBytes } from './git.js';
import type { DaemonConfig } from './config.js';

const blockingProvider = [process.execPath, '-e', "setTimeout(() => process.stdout.write('fixture complete'), 350)", '--'];

function fixture(maxActive: number) {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-max-active-'));
  const project = join(root, 'project');
  mkdirSync(project);
  gitBytes(project, ['init', '-q']);
  writeFileSync(join(project, 'tracked.txt'), 'baseline\n');
  gitBytes(project, ['add', '.']);
  gitBytes(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const config: DaemonConfig = {
    socketPath: join(root, 'run', 'daemon.sock'), databasePath: join(root, 'state', 'daemon.db'), artifactDirectory: join(root, 'artifacts'), maxActive,
    projects: [{ id: 'project', name: 'Fixture', path: project, workflows: [{
      id: 'read', name: 'Read', readOnly: true, qualityCommands: [], providers: { codex: { argv: blockingProvider } },
    }] }],
  };
  return { root, daemon: new FixtureDaemon(config) };
}

async function observeUntilTerminal(daemon: FixtureDaemon, jobIds: string[], maxActive: number): Promise<number> {
  let highest = 0;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const active = daemon.database.countActive();
    highest = Math.max(highest, active);
    assert.ok(active <= maxActive, `observed ${active} active jobs above maxActive=${maxActive}`);
    if (jobIds.every(id => ['succeeded', 'failed', 'cancelled'].includes(daemon.database.getJob(id)?.state ?? ''))) {
      const jobs = jobIds.map(id => daemon.database.getJob(id)!);
      assert.ok(jobs.every(job => job.state === 'succeeded'), `every fixture job must succeed: ${JSON.stringify(jobs.map(job => job.state))}`);
      assert.ok(jobs.every(job => job.result?.includes('fixture complete')), 'every fixture job must retain its fixture result');
      return highest;
    }
    await delay(20);
  }
  assert.fail(`fixture jobs did not settle: ${JSON.stringify(jobIds.map(id => daemon.database.getJob(id)?.state))}`);
}

for (const maxActive of [1, 2, 3]) test(`four blocking jobs are queued and never exceed maxActive=${maxActive}`, async t => {
  const value = fixture(maxActive);
  t.after(async () => { await value.daemon.stop(); value.daemon.close(); removeFixtureTree(value.root); });
  const jobIds: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const created = await value.daemon.call('rooms.create', {
      title: `Blocking ${index}`, projectId: 'project', workflowId: 'read', prompt: 'Wait for fixture release', recipients: ['codex'], force: true,
    }, randomUUID()) as { jobIds: string[] };
    jobIds.push(created.jobIds[0]!);
  }
  assert.equal(value.daemon.database.countQueued(), 4, 'all four fixture jobs must be queued before scheduling begins');
  value.daemon.start();
  const highest = await observeUntilTerminal(value.daemon, jobIds, maxActive);
  assert.equal(highest, maxActive, 'the queued blocking fixtures must fill the configured capacity');
});
