import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { acquireProviderHome } from './provider-home.js';
import { directoryFixture, FixtureExecutor, preparedFixture } from './__fixtures__/s1-sandbox.js';
import { command, enrolled, scopeFixture } from './__fixtures__/s1-scope.js';
import { linuxScopePorts, ScopeStartError, SystemdScopeExecutor } from './execution-scope.js';
import { BubblewrapIsolation } from './sandbox.js';
import { captureBaseline } from './job-delta.js';
import { limits } from './__fixtures__/s1-scope.js';
import { homeHostFixture } from './__fixtures__/s1-home-host.js';
import type { CommandSpec, IsolationRequest } from './isolation.js';

test('provider home persists for one key and isolates different keys across ownership acquisitions', async t => {
  const f = directoryFixture(t);
  const first = acquireProviderHome(f.sandboxRoot, 'session-A');
  writeFileSync(join(first.homeDirectory, 'session'), 'retained');
  assert.throws(() => acquireProviderHome(f.sandboxRoot, 'session-A'), /owned/);
  const other = acquireProviderHome(f.sandboxRoot, 'session-B');
  assert.equal(existsSync(join(other.homeDirectory, 'session')), false);
  await first.release(async () => true);
  assert.ok(existsSync(first.homeDirectory));
  const resumed = acquireProviderHome(f.sandboxRoot, 'session-A');
  assert.equal(resumed.homeDirectory, first.homeDirectory);
  assert.equal(readFileSync(join(resumed.homeDirectory, 'session'), 'utf8'), 'retained');
  await resumed.release(async () => true); await other.release(async () => true);
});

test('provider ownership retains false, rejected and pending absence checks', async t => {
  const f = directoryFixture(t), home = acquireProviderHome(f.sandboxRoot, 'guard');
  await assert.rejects(home.release(async () => false), /unconfirmed/);
  await assert.rejects(home.release(async () => { throw new Error('unknown scope'); }), /unknown scope/);
  let resolve!: (value: boolean) => void;
  const pending = home.release(() => new Promise<boolean>(done => { resolve = done; }));
  await assert.rejects(home.release(async () => true), /pending/);
  assert.throws(() => acquireProviderHome(f.sandboxRoot, 'guard'), /owned/);
  resolve(false); await assert.rejects(pending, /unconfirmed/);
  await home.release(async () => true);
});

test('resumption refuses a missing retained home instead of manufacturing an empty session', async t => {
  const f = directoryFixture(t);
  assert.throws(() => acquireProviderHome(f.sandboxRoot, 'missing', true), /Retained provider state is unavailable/);
  assert.equal(existsSync(join(f.sandboxRoot, 'provider-state', 'missing')), false);
  const first = acquireProviderHome(f.sandboxRoot, 'retained');
  writeFileSync(join(first.homeDirectory, 'session'), 'state');
  await first.release(async () => true);
  const resumed = acquireProviderHome(f.sandboxRoot, 'retained', true);
  assert.equal(readFileSync(join(resumed.homeDirectory, 'session'), 'utf8'), 'state');
  await resumed.release(async () => true);
  renameSync(resumed.homeDirectory, resumed.homeDirectory + '-lost');
  assert.throws(() => acquireProviderHome(f.sandboxRoot, 'retained', true), /Retained provider state is unavailable/);
  assert.equal(existsSync(resumed.homeDirectory), false);
});

test('opaque keys reject paths, underscores, empty and excessive identifiers', t => {
  const f = directoryFixture(t);
  for (const key of ['', '../escape', '/absolute', 'a_b', 'a.b', 'a\0b', 'x'.repeat(129)]) {
    assert.throws(() => acquireProviderHome(f.sandboxRoot, key), /Invalid provider state key/);
  }
  assert.equal(existsSync(join(f.sandboxRoot, 'provider-state')), false);
});

test('abandoned ownership and partial initialization are never reclaimed', t => {
  const f = directoryFixture(t);
  const parent = join(f.sandboxRoot, 'provider-state', 'abandoned');
  mkdirSync(join(parent, 'owner'), { recursive: true, mode: 0o700 });
  assert.throws(() => acquireProviderHome(f.sandboxRoot, 'abandoned'), /owned/);
  assert.equal(existsSync(join(parent, 'home')), false);
});

test('provider home rejects symlinked storage and retains tampered ownership', async t => {
  const f = directoryFixture(t), home = acquireProviderHome(f.sandboxRoot, 'tamper');
  const record = join(dirname(home.homeDirectory), 'owner', 'token');
  writeFileSync(record, 'foreign');
  await assert.rejects(home.release(async () => true), /token changed/);
  assert.ok(existsSync(record));
  renameSync(home.homeDirectory, home.homeDirectory + '-original');
  symlinkSync(f.home, home.homeDirectory);
  assert.throws(home.assertOwned, /Unsafe directory ancestor/);
  const other = join(f.sandboxRoot, 'provider-state', 'redirect');
  symlinkSync(f.home, other);
  assert.throws(() => acquireProviderHome(f.sandboxRoot, 'redirect'), /Unsafe directory ancestor/);
});

test('prepared provider home retains only home after guarded disposal and survives a new job ID', async t => {
  const f = await preparedFixture(t);
  const request = { ...f.request, providerStateKey: 'lineage-A', dependencyMounts: [] };
  const first = await f.isolation.prepare(request);
  const home = join(f.sandboxRoot, 'provider-state', 'lineage-A', 'home');
  writeFileSync(join(home, 'thread'), 'saved'); writeFileSync(join(first.runDirectory, 'output'), 'temporary');
  await assert.rejects(first.extract(join(f.sandboxRoot, 'provider-state', 'lineage-B', 'delta')), /overlaps/);
  await assert.rejects(f.isolation.prepare({ ...request, jobId: 'competing' }), /owned/);
  await first.command(command({ argv: [process.execPath], cwd: f.project }));
  const argv = f.executor.commands[0]!.argv;
  const sources = argv.flatMap((arg, i) => ['--bind', '--ro-bind'].includes(arg) ? [argv[i + 1]!] : []);
  assert.ok(sources.includes(home));
  for (const path of [f.sandboxRoot, join(f.sandboxRoot, 'provider-state'), dirname(home), join(dirname(home), 'owner'), f.home]) assert.equal(sources.includes(path), false);
  for (const state of ['alive', 'unverifiable'] as const) {
    f.executor.state = state; await assert.rejects(first.dispose(), /alive or unverifiable/);
    await assert.rejects(f.isolation.prepare(request), /owned/);
  }
  f.executor.state = 'absent'; await first.dispose();
  assert.equal(existsSync(first.sandboxDir), false); assert.equal(readFileSync(join(home, 'thread'), 'utf8'), 'saved');
  const resumed = await f.isolation.prepare({ ...request, jobId: 'next-job' });
  assert.notEqual(resumed.sandboxDir, first.sandboxDir);
  assert.equal(existsSync(join(resumed.runDirectory, 'output')), false);
  await resumed.dispose();
  const other = await f.isolation.prepare({ ...request, providerStateKey: 'lineage-B' });
  assert.equal(existsSync(join(f.sandboxRoot, 'provider-state', 'lineage-B', 'home', 'thread')), false);
  await other.dispose(); await f.handle.dispose();
  assert.equal(existsSync(join(f.handle.sandboxDir, 'home')), false);
});

test('prepared provider ownership retains unknown startup and releases only an enrolled absent scope', async t => {
  const f = await preparedFixture(t), scope = scopeFixture();
  // This is a pure lifecycle fixture: no change to production scope observation.
  const executor = new FixtureExecutor({ ports: scope.ports });
  const isolation = new BubblewrapIsolation({ sandboxRoot: f.sandboxRoot, hiddenPaths: [f.admin], operatorHome: f.home, executor });
  t.mock.method(isolation, 'available', () => f.isolation.available());
  for (const enrollment of [null, enrolled]) {
    const key = enrollment ? 'known-start' : 'unknown-start';
    const request = { ...f.request, providerStateKey: key };
    const handle = await isolation.prepare(request);
    executor.failure = new ScopeStartError('startup fixture', enrolled.scopeUnit, enrollment, false);
    await assert.rejects(handle.command(command({ argv: [process.execPath], cwd: f.project })), /startup fixture/);
    scope.state.inaccessible = true;
    await assert.rejects(handle.dispose(), /reconciliation/);
    await assert.rejects(isolation.prepare(request), /owned/);
    scope.state.inaccessible = false; scope.state.alive = false;
    if (enrollment) {
      await handle.dispose(); const next = await isolation.prepare(request); await next.dispose();
    } else {
      await assert.rejects(handle.dispose(), /reconciliation/);
      assert.throws(() => acquireProviderHome(f.sandboxRoot, key), /owned/);
    }
  }
  await f.handle.dispose();
});

test('prepared provider release observes all prior scopes, including an uncertain earlier execution', async t => {
  const f = await preparedFixture(t);
  const states: Array<'absent' | 'alive' | 'unverifiable'> = [];
  const start = f.executor.start.bind(f.executor);
  t.mock.method(f.executor, 'start', async (spec: CommandSpec) => {
    const execution = await start(spec), index = states.length;
    states.push('absent');
    return { ...execution, observe: async () => ({ state: states[index]!, members: [], reason: null }) };
  });
  const request = { ...f.request, providerStateKey: 'all-scopes' };
  const handle = await f.isolation.prepare(request);
  await handle.command(command({ argv: [process.execPath], cwd: f.project }));
  await handle.command(command({ argv: [process.execPath], cwd: f.project }));
  states[0] = 'unverifiable';
  await assert.rejects(handle.dispose(), /alive or unverifiable/);
  await assert.rejects(f.isolation.prepare(request), /owned/);
  states[0] = 'absent'; states[1] = 'alive';
  await assert.rejects(handle.dispose(), /alive or unverifiable/);
  states[1] = 'absent'; await handle.dispose(); await f.handle.dispose();
  const next = await f.isolation.prepare(request); await next.dispose();
});

test('native provider homes: persistence, isolation, exclusive ownership and unknown-scope retention', { timeout: 60_000 }, async t => {
  let unknown = false;
  const executor = new SystemdScopeExecutor({ ports: { ...linuxScopePorts, readText: path => {
    if (unknown && path.endsWith('/cgroup.procs')) throw Object.assign(new Error('Injected observation denial of a real scope'), { code: 'EACCES' });
    return linuxScopePorts.readText(path);
  } } });
  const f = await homeHostFixture(t, executor); if (!f) return;
  writeFileSync(join(f.home, 'operator-marker'), 'must not copy');
  const baseline = captureBaseline(f.project, join(f.root, 'baseline'));
  const visibleCwd = join(f.root, 'visible');
  const request = { jobId: 'native-home', projectPath: f.project, visibleCwd, baseline, readOnly: false,
    config: limits, jobSocketPath: f.socket, providerStateKey: 'native-lineage', dependencyMounts: [] };
  const home = join(f.sandboxRoot, 'provider-state', request.providerStateKey, 'home');
  const hidden = [f.admin, f.project, baseline.directory, join(f.sandboxRoot, 'provider-state'), dirname(home), join(dirname(home), 'owner')];
  const first = await f.isolation.prepare(request);
  const execute = async (handle: typeof first, source: string) => {
    const result = await handle.command(command({ argv: [process.execPath, '-e', source], cwd: visibleCwd, timeoutMs: 5000,
      env: { CODEX_HOME: '/ambient', CLAUDE_CONFIG_DIR: '/ambient', XDG_STATE_HOME: '/ambient', XDG_CONFIG_HOME: '/ambient', XDG_CACHE_HOME: '/ambient', XDG_DATA_HOME: '/ambient' } }));
    const done = await result.completion; assert.equal(done.exitCode, 0, done.stderr); assert.equal((await result.observe()).state, 'absent');
  };
  const inspect = `const fs=require('node:fs'),assert=require('node:assert/strict');
    for(const p of ${JSON.stringify(hidden)}) assert.equal(fs.existsSync(p),false,p);
    assert.equal(fs.existsSync(process.env.HOME+'/operator-marker'),false);
    for(const key of ['CODEX_HOME','CLAUDE_CONFIG_DIR','XDG_STATE_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME']) {
      assert.ok(process.env[key].startsWith(process.env.HOME+'/'),key);
      fs.mkdirSync(process.env[key],{recursive:true});
    }`;
  await execute(first, inspect + `fs.writeFileSync(process.env.CODEX_HOME+'/session','retained');fs.writeFileSync('private-edit','temporary');fs.writeFileSync('/tmp/temporary','temporary');`);
  await assert.rejects(f.isolation.prepare({ ...request, jobId: 'contender' }), /owned/);
  const other = await f.isolation.prepare({ ...request, providerStateKey: 'different-lineage' });
  await execute(other, inspect + `assert.equal(fs.existsSync(process.env.CODEX_HOME+'/session'),false);`);
  await other.dispose();
  const live = await first.command(command({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: visibleCwd, timeoutMs: 15_000 }));
  try {
    unknown = true;
    assert.equal((await live.observe()).state, 'unverifiable');
    await assert.rejects(first.dispose(), /alive or unverifiable/);
    assert.ok(existsSync(first.sandboxDir)); assert.throws(() => acquireProviderHome(f.sandboxRoot, request.providerStateKey), /owned/);
  } finally { unknown = false; await live.signal('SIGKILL'); await live.completion; }
  await first.dispose(); assert.equal(existsSync(first.sandboxDir), false); assert.ok(existsSync(home));
  const resumed = await f.isolation.prepare({ ...request, jobId: 'native-resume' });
  await execute(resumed, inspect + `assert.equal(fs.readFileSync(process.env.CODEX_HOME+'/session','utf8'),'retained');assert.equal(fs.existsSync('private-edit'),false);assert.equal(fs.existsSync('/tmp/temporary'),false);`);
  await resumed.dispose();
  const ephemeralRequest: IsolationRequest = { ...request }; delete ephemeralRequest.providerStateKey;
  const ephemeral = await f.isolation.prepare(ephemeralRequest);
  await execute(ephemeral, inspect + `assert.equal(fs.existsSync(process.env.CODEX_HOME+'/session'),false);`);
  await ephemeral.dispose(); assert.equal(existsSync(ephemeral.sandboxDir), false);
});
