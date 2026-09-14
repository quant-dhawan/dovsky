import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = path.resolve('.');
const cli = path.join(repository, 'bin/dovsky');
const daemonMain = path.join(repository, 'apps/daemon/dist/main.js');
const run = (args, options = {}) => exec(cli, args, { cwd: repository, ...options });

function rpc(socketPath, method, params = {}, idempotencyKey) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); let body = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(`${JSON.stringify({ id: 'fixture-health', method, params, ...(idempotencyKey ? { idempotencyKey } : {}) })}\n`));
    socket.on('data', chunk => { body += chunk; });
    socket.once('error', reject);
    socket.once('close', () => {
      try { const reply = JSON.parse(body.trim()); reply.ok ? resolve(reply.result) : reject(new Error(reply.error?.message ?? 'daemon rejection')); }
      catch (error) { reject(error); }
    });
  });
}

async function startDaemon(configPath, environment) {
  const daemon = spawn(process.execPath, [daemonMain, '--config', configPath], { cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  daemon.stdout.setEncoding('utf8'); daemon.stderr.setEncoding('utf8');
  daemon.stdout.on('data', chunk => { stdout += chunk; }); daemon.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`daemon did not become ready: ${stderr}`)), 10_000);
    daemon.once('error', reject);
    daemon.once('exit', code => reject(new Error(`daemon exited ${code}: ${stderr}`)));
    const ready = () => {
      if (!stdout.includes('"dovskyd.ready"')) return;
      clearTimeout(timeout); daemon.removeListener('exit', reject); resolve();
    };
    daemon.stdout.on('data', ready); ready();
  });
  return daemon;
}

async function stopDaemon(daemon) {
  if (daemon.exitCode !== null) return;
  const exited = new Promise(resolve => daemon.once('exit', resolve));
  daemon.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
}

test('built daemon and CLI cover offline operator routes and exit contracts', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dovsky-cli-daemon-'));
  const project = path.join(root, 'project'), socketPath = path.join(root, 'run', 'daemon.sock'), configPath = path.join(root, 'config.json');
  await mkdir(project, { recursive: true });
  const config = { socketPath, databasePath: path.join(root, 'state', 'daemon.db'), artifactDirectory: path.join(root, 'artifacts'), maxActive: 1,
    projects: [{ id: 'project', name: 'Fixture', path: project, workflows: [{ id: 'read', name: 'Read', readOnly: true, qualityCommands: [], providers: {} }] }] };
  await writeFile(configPath, JSON.stringify(config));
  const environment = { ...process.env, DOVSKY_HOME: path.join(root, 'home') };
  const daemon = await startDaemon(configPath, environment);
  t.after(async () => { await stopDaemon(daemon); await rm(root, { recursive: true, force: true }); });

  const health = await rpc(socketPath, 'health');
  assert.equal(health.ok, true);
  const recorded = JSON.parse((await run(['record', 'offline fixture', '--author', 'human', '--title', 'Fixture', '--project', 'project', '--workflow', 'read', '--socket', socketPath, '--json'], { env: environment })).stdout);
  const roomId = recorded.roomId;
  for (const command of ['pin', 'unpin', 'archive', 'unarchive']) {
    const response = await run([command, roomId, '--socket', socketPath, '--json'], { env: environment });
    assert.equal(response.stderr, '');
  }

  const legacy = path.join(root, 'legacy', 'legacy-1');
  await mkdir(legacy, { recursive: true });
  await Promise.all([
    writeFile(path.join(legacy, 'job.json'), JSON.stringify({ created: '2026-01-01T00:00:00.000Z', to: 'codex', cwd: project })),
    writeFile(path.join(legacy, 'status'), 'done\n'), writeFile(path.join(legacy, 'prompt.txt'), 'historical prompt\n'), writeFile(path.join(legacy, 'result.md'), 'historical result\n'),
  ]);
  const imported = JSON.parse((await run(['import-legacy', '--source', path.dirname(legacy), '--apply', '--socket', socketPath, '--json'], { env: environment })).stdout);
  assert.equal(imported.imported, 1);

  const jobs = JSON.parse((await run(['ls', '--socket', socketPath, '--json'], { env: environment })).stdout);
  const legacyJob = jobs.items.find(job => job.provider === 'codex' && job.state === 'succeeded');
  assert.ok(legacyJob, 'legacy import must create a terminal job for the CLI negative-result check');
  await assert.rejects(run(['acceptance-check', legacyJob.id, '--socket', socketPath, '--json'], { env: environment }), error => error.code === 1);
  await assert.rejects(run(['pin', '--socket', socketPath], { env: environment }), error => error.code === 2);
  await assert.rejects(run(['doctor', '--socket', path.join(root, 'missing.sock')], { env: environment }), error => error.code === 2);
});
