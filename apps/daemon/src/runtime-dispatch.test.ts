import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { DovskyDaemon } from './daemon.js';
import { gitBytes } from './git.js';
import type { JobIsolation } from './isolation.js';
import { removeFixtureTree } from './__fixtures__/runtime-isolation.js';
import { createJobIsolation } from './sandbox.js';
import { contentHash } from './job-delta.js';

async function fixture(t: TestContext, isolation: JobIsolation | ((root: string) => JobIsolation), setup?: (project: string) => void,
  beforeStart?: (daemon: DovskyDaemon) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-runtime-dispatch-'));
  let daemon: DovskyDaemon | null = null;
  t.after(async () => { if (daemon) { await daemon.stop(); daemon.close(); } removeFixtureTree(root); });
  mkdirSync(join(root, 'admin'), { mode: 0o700 });
  const project = join(root, 'project');
  gitBytes(root, ['init', '-q', project]);
  writeFileSync(join(project, 'file'), 'baseline');
  gitBytes(project, ['add', 'file']);
  gitBytes(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']);
  setup?.(project);
  daemon = new DovskyDaemon({ socketPath: join(root, 'admin/run/socket'), databasePath: join(root, 'admin/state/db'),
    artifactDirectory: join(root, 'admin/artifacts'), maxActive: 1,
    projects: [{ id: 'project', name: 'Fixture', path: project, workflows: [{ id: 'workflow', name: 'Fixture',
      readOnly: false, qualityCommands: [], providers: { codex: { argv: [process.execPath, '-e',
        "require('node:fs').writeFileSync('provider-ran','bad');process.stdout.write('done')", '--'] } } }] }] },
    { isolation: typeof isolation === 'function' ? isolation(root) : isolation });
  await beforeStart?.(daemon);
  daemon.start();
  const created = await daemon.call('rooms.create', { title: 'Fixture', projectId: 'project', workflowId: 'workflow',
    prompt: 'Fixture', recipients: ['codex'], force: true }, 'strict-runtime-create') as { jobIds: string[] };
  for (let n = 0; n < 500; n++) {
    const job = daemon.database.getJob(created.jobIds[0]!)!;
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return { root, project, daemon, job };
    await delay(20);
  }
  assert.fail('Disposable runtime fixture did not terminate');
}

test('startup refuses unavailable strict isolation with the operator-facing code', async t => {
  let probes = 0;
  const isolation: JobIsolation = {
    available: async () => { probes++; return { available: false, backend: 'bwrap', reason: 'fixture bwrap unavailable', bwrapVersion: null }; },
    prepare: async () => { throw new Error('must not prepare'); },
  };
  await assert.rejects(fixture(t, isolation, undefined, daemon => daemon.assertSandboxAvailable()), error => {
    assert.equal((error as { code?: string }).code, 'DOVSKY_SANDBOX_UNAVAILABLE');
    assert.match(String(error), /Sandbox unavailable: fixture bwrap unavailable/);
    return true;
  });
  assert.equal(probes, 1);
});

test('main refuses startup before listening or announcing readiness when sandbox probing fails', t => {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-main-unavailable-'));
  t.after(() => removeFixtureTree(root));
  const project = join(root, 'project');
  mkdirSync(project);
  const socketPath = join(root, 'admin/run/socket');
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    socketPath,
    databasePath: join(root, 'admin/state/db'),
    artifactDirectory: join(root, 'admin/artifacts'),
    projects: [{ id: 'project', name: 'Fixture', path: project, workflows: [{
      id: 'workflow', name: 'Fixture', readOnly: false, qualityCommands: [],
      providers: { codex: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
    }] }],
  }));
  const result = spawnSync(process.execPath, [new URL('./main.js', import.meta.url).pathname, '--config', configPath], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, 'missing-bus')}`, XDG_RUNTIME_DIR: join(root, 'missing-runtime') },
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /DOVSKY_SANDBOX_UNAVAILABLE/);
  assert.doesNotMatch(result.stdout, /dovskyd\.ready/);
  assert.equal(existsSync(socketPath), false);
});

test('main refuses every retired state-selection environment before loading configuration', t => {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-main-retired-env-'));
  t.after(() => removeFixtureTree(root));
  for (const retired of ['AGENTBUS_HOME', 'AGENTBUS_CONFIG', 'AGENTBUS_SOCKET']) {
    const env = { ...process.env, [retired]: root };
    for (const name of ['AGENTBUS_HOME', 'AGENTBUS_CONFIG', 'AGENTBUS_SOCKET']) if (name !== retired) delete env[name];
    const result = spawnSync(process.execPath, [new URL('./main.js', import.meta.url).pathname], { encoding: 'utf8', timeout: 10_000, env });
    assert.equal(result.status, 2, `${retired}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `Refusing retired ${retired}; use DOVSKY_HOME, DOVSKY_CONFIG, or DOVSKY_SOCKET.\n`);
  }
});

test('main gives --config precedence over DOVSKY_CONFIG', t => {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-main-config-precedence-'));
  t.after(() => removeFixtureTree(root));
  const project = join(root, 'project');
  mkdirSync(project);
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    socketPath: join(root, 'admin/run/socket'), databasePath: join(root, 'admin/state/db'), artifactDirectory: join(root, 'admin/artifacts'),
    projects: [{ id: 'project', name: 'Fixture', path: project, workflows: [{
      id: 'workflow', name: 'Fixture', readOnly: false, qualityCommands: [], providers: { codex: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
    }] }],
  }));
  const result = spawnSync(process.execPath, [new URL('./main.js', import.meta.url).pathname, '--config', configPath], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, DOVSKY_CONFIG: join(root, 'invalid.json'), DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, 'missing-bus')}`, XDG_RUNTIME_DIR: join(root, 'missing-runtime') },
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /DOVSKY_SANDBOX_UNAVAILABLE/);
  assert.doesNotMatch(result.stderr, /ENOENT|Unexpected token/);
});

test('unavailable strict isolation cannot launch a provider in the canonical worktree', async t => {
  let preparations = 0;
  const f = await fixture(t, {
    available: async () => ({ available: false, backend: 'bwrap', reason: 'fixture hard-limit scope unavailable', bwrapVersion: null }),
    prepare: async () => { preparations++; throw new Error('must not prepare'); },
  });
  assert.equal(f.job.state, 'failed'); assert.equal(f.job.failure?.code, 'sandbox_unavailable'); assert.match(f.job.failure!.summary, /unavailable/);
  assert.equal(preparations, 0); assert.equal(existsSync(join(f.project, 'provider-ran')), false);
});

test('native strict dispatch applies a full dirty baseline only after actual scope absence', async t => {
  let sawPrivateOutput = false;
  const f = await fixture(t, root => {
    const isolation = createJobIsolation({ sandboxRoot: join(root, 'admin/artifacts/sandboxes'), hiddenPaths: [join(root, 'admin')] });
    return { available: () => isolation.available(), prepare: async request => {
      const handle = await isolation.prepare(request);
      assert.equal(readFileSync(join(handle.privateRepo, 'file'), 'utf8'), 'dirty preimage');
      assert.deepEqual(readFileSync(join(handle.privateRepo, 'binary')), Buffer.from([0, 255, 2]));
      return { ...handle, command: spec => handle.command({ ...spec, onStdout: chunk => {
        assert.equal(existsSync(join(request.projectPath, 'provider-ran')), false, 'Canonical write must wait for scope absence');
        sawPrivateOutput = true; spec.onStdout?.(chunk);
      } }) };
    } };
  }, project => {
    writeFileSync(join(project, 'file'), 'dirty preimage');
    writeFileSync(join(project, 'binary'), Buffer.from([0, 255, 2]));
    chmodSync(join(project, 'binary'), 0o755);
  });
  assert.equal(f.job.state, 'succeeded', JSON.stringify(f.job.failure));
  assert.equal(sawPrivateOutput, true);
  assert.equal(readFileSync(join(f.project, 'provider-ran'), 'utf8'), 'bad');
  assert.equal(readFileSync(join(f.project, 'file'), 'utf8'), 'dirty preimage');
  assert.deepEqual(readFileSync(join(f.project, 'binary')), Buffer.from([0, 255, 2]));
  assert.equal(statSync(join(f.project, 'binary')).mode & 0o777, 0o755);
  const lease = f.daemon.database.db.prepare('SELECT * FROM execution_leases WHERE job_id=?').get(f.job.id)!;
  assert.equal(lease.state, 'exited');
  assert.match(String(lease.scope_unit), /^dovsky-job-.*\.scope$/);
  assert.ok(String(lease.cgroup_path).endsWith('/' + String(lease.scope_unit)));
  assert.ok(Number(lease.pid) > 0);
  const events = f.daemon.database.db.prepare('SELECT type FROM events WHERE job_id=? ORDER BY id').all(f.job.id).map(row => row.type);
  const ordered = ['execution.lease.launching', 'execution.lease.running', 'execution.lease.exited', 'execution.application.pending', 'execution.application.complete'];
  for (let i = 1; i < ordered.length; i++) assert.ok(events.indexOf(ordered[i - 1]!) >= 0 && events.indexOf(ordered[i]!) > events.indexOf(ordered[i - 1]!));
  assert.equal(f.job.endContentHash, contentHash(f.project));
});

test('preparation refusal never falls back to direct provider execution', async t => {
  let preparations = 0;
  const f = await fixture(t, {
    available: async () => ({ available: true, backend: 'bwrap', reason: null, bwrapVersion: 'fixture' }),
    prepare: async () => { preparations++; throw new Error('fixture preparation refused'); },
  });
  assert.equal(f.job.state, 'failed'); assert.equal(f.job.failure?.code, 'sandbox_apply'); assert.match(f.job.failure!.summary, /preparation refused/);
  assert.equal(preparations, 1); assert.equal(existsSync(join(f.project, 'provider-ran')), false);
});

test('a concurrent canonical mode change refuses private application without overwriting it', async t => {
  const f = await fixture(t, root => {
    const isolation = createJobIsolation({ sandboxRoot: join(root, 'admin/artifacts/sandboxes'), hiddenPaths: [join(root, 'admin')] });
    return { available: () => isolation.available(), prepare: async request => {
      const handle = await isolation.prepare(request);
      return { ...handle, command: spec => handle.command({ ...spec, onStdout: chunk => {
        chmodSync(join(request.projectPath, 'untracked'), 0o755);
        spec.onStdout?.(chunk);
      } }) };
    } };
  }, project => { writeFileSync(join(project, 'untracked'), 'operator bytes', { mode: 0o644 }); });
  assert.equal(f.job.state, 'failed');
  assert.equal(f.job.failure?.code, 'sandbox_apply');
  assert.match(f.job.failure!.summary, /Canonical tree changed/);
  assert.equal(existsSync(join(f.project, 'provider-ran')), false);
  assert.equal(readFileSync(join(f.project, 'untracked'), 'utf8'), 'operator bytes');
  assert.equal(statSync(join(f.project, 'untracked')).mode & 0o777, 0o755);
  assert.equal(f.daemon.database.hasPendingApplication(f.job.id), false);
});

test('uncertain post-result scope observation retains the lease, locks and private storage', async t => {
  let disposals = 0;
  let sandboxDir = '';
  let actualAbsence = false;
  const f = await fixture(t, root => {
    const isolation = createJobIsolation({ sandboxRoot: join(root, 'admin/artifacts/sandboxes'), hiddenPaths: [join(root, 'admin')] });
    return { available: () => isolation.available(), prepare: async request => {
      const handle = await isolation.prepare(request);
      sandboxDir = handle.sandboxDir;
      return { ...handle, command: async spec => {
        const execution = await handle.command(spec);
        void execution.completion.then(async () => { actualAbsence = (await execution.observe()).state === 'absent'; });
        return { ...execution, observe: async () => ({ state: 'unverifiable', members: [], reason: 'Explicit observation fixture' }) };
      }, dispose: async () => { disposals++; await handle.dispose(); } };
    } };
  });
  assert.equal(actualAbsence, true, 'The disposable real process is gone; only the injected observation is uncertain');
  assert.equal(f.job.state, 'failed');
  assert.equal(existsSync(join(f.project, 'provider-ran')), false);
  assert.equal(disposals, 0);
  assert.equal(existsSync(sandboxDir), true);
  const execution = f.daemon.database.executionForJob(f.job.id);
  assert.equal(execution.leases[0]?.state, 'reconcile_required');
  assert.equal(f.daemon.database.hasUnresolvedExecution(f.job.id), true);
  assert.ok(f.daemon.database.db.prepare('SELECT resource FROM resource_locks WHERE job_id=?').all(f.job.id).length > 0);
  assert.equal(existsSync(join(f.root, 'admin/artifacts/sandboxes/provider-state', String(f.job.sandbox!.providerStateKey), 'owner/token')), true);
});

test('cancellation during scope enrollment keeps the actual failed-start identity without releasing the gate', async t => {
  let daemon: DovskyDaemon;
  const f = await fixture(t, root => {
    const isolation = createJobIsolation({ sandboxRoot: join(root, 'admin/artifacts/sandboxes'), hiddenPaths: [join(root, 'admin')] });
    return { available: () => isolation.available(), prepare: async request => {
      const handle = await isolation.prepare(request);
      return { ...handle, command: spec => handle.command({ ...spec, onEnrolled: async enrollment => {
        await daemon.call('jobs.cancel', { jobId: request.jobId }, 'cancel-before-enrollment');
        await spec.onEnrolled(enrollment);
      } }) };
    } };
  }, undefined, value => { daemon = value; });
  assert.equal(f.job.state, 'cancelled');
  assert.equal(existsSync(join(f.project, 'provider-ran')), false);
  const lease = f.daemon.database.executionForJob(f.job.id).leases[0]!;
  assert.equal(lease.state, 'exited');
  assert.ok(lease.identity && lease.cgroupPath, 'The actual rejected enrollment must remain available for recovery/audit');
  assert.ok(lease.cgroupPath.endsWith('/' + lease.scopeUnit));
});
