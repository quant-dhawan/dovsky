import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { BubblewrapIsolation, buildSandboxPlan, resolveRuntime } from './sandbox.js';
import { ScopeStartError, SystemdScopeExecutor } from './execution-scope.js';
import { contentHash } from './job-delta.js';
import { assertPrivateRepository } from './git.js';
import { command, limits, scopeFixture } from './__fixtures__/s1-scope.js';
import { directoryFixture, planFixture, preparedFixture } from './__fixtures__/s1-sandbox.js';
import { acquireProviderHome } from './provider-home.js';

test('private Git at stable cwd uses the complete dirty baseline and foundation delta extraction', async t => {
  const f = await preparedFixture(t);
  assertPrivateRepository(f.handle.privateRepo);
  assert.equal(contentHash(f.handle.privateRepo), f.request.baseline.manifest.identity.contentHash);
  assert.equal(readFileSync(join(f.handle.privateRepo, 'tracked.txt'), 'utf8'), 'dirty baseline\n');
  assert.deepEqual(readFileSync(join(f.handle.privateRepo, 'initial.bin')), Buffer.from([0, 255, 42]));
  assert.equal(lstatSync(join(f.handle.privateRepo, 'initial.sh')).mode & 0o777, 0o755);
  assert.equal(lstatSync(join(f.handle.privateRepo, 'initial-link')).isSymbolicLink(), true);
  writeFileSync(join(f.handle.privateRepo, 'new.bin'), Buffer.from([0, 255, 1]));
  symlinkSync('new.bin', join(f.handle.privateRepo, 'link'));
  writeFileSync(join(f.handle.privateRepo, 'executable'), '#!/bin/sh\n', { mode: 0o755 });
  const delta = await f.handle.extract(join(f.root, 'delta'));
  assert.deepEqual(delta.entries.map(entry => entry.path), ['executable', 'link', 'new.bin']);
  assert.equal(contentHash(f.project), f.request.baseline.manifest.identity.contentHash);
  assert.equal(lstatSync(join(f.handle.privateRepo, 'executable')).mode & 0o777, 0o755);
  assert.equal(f.handle.visibleCwd, f.project);
  await f.handle.dispose(); assert.equal(existsSync(f.handle.sandboxDir), false);
  assert.ok(existsSync(f.request.baseline.directory)); assert.ok(existsSync(f.project));
});

test('argv exposes only the private project/home/run and specific readonly runtime mounts', async t => {
  const f = await preparedFixture(t);
  await f.handle.command(command({ argv: [process.execPath, '-e', 'process.exit(0)'], cwd: f.project,
    env: { PATH: process.env.PATH, DOVSKY_SOCKET: '/operator.sock', DOVSKY_JOB_ID: 'fixture', KEEP: 'unchanged' } }));
  const args = f.executor.commands[0]!.argv;
  assert.ok(args.includes('--unshare-net')); assert.ok(args.includes('--clearenv'));
  assert.ok(args.includes(f.handle.privateRepo)); assert.ok(args.includes(f.handle.visibleCwd));
  assert.equal(args.includes('/operator.sock'), false);
  assert.ok(args.includes(join(f.handle.runDirectory, 'dovsky.sock')));
  const binds = args.flatMap((value, i) => ['--bind', '--ro-bind'].includes(value) ? [{ mode: value, source: args[i + 1], target: args[i + 2] }] : []);
  assert.equal(binds.some(mount => ['/run', '/etc', f.home, f.admin, f.sandboxRoot, f.request.baseline.directory, f.project].includes(mount.source!)), false);
  assert.ok(binds.some(mount => mount.source === join(f.handle.sandboxDir, 'home') && mount.target === f.home));
  assert.deepEqual(binds.filter(mount => mount.source === f.socket), [{ mode: '--ro-bind', source: f.socket, target: join(f.handle.runDirectory, 'dovsky.sock') }]);
  if (existsSync('/etc/resolv.conf')) assert.ok(binds.some(mount => mount.source === realpathSync('/etc/resolv.conf') && mount.target === '/etc/resolv.conf'));
  f.executor.state = 'absent'; await f.handle.dispose();
});

test('disposal/extraction refuse live and unverifiable scopes and permit confirmed absence', async t => {
  const f = await preparedFixture(t);
  await f.handle.command(command({ argv: [process.execPath], cwd: f.project }));
  for (const state of ['alive', 'unverifiable'] as const) {
    f.executor.state = state;
    await assert.rejects(f.handle.dispose(), /alive or unverifiable/);
    await assert.rejects(f.handle.extract(join(f.root, 'delta')), /alive or unverifiable/);
    assert.ok(existsSync(f.handle.privateRepo));
  }
  f.executor.state = 'absent'; await f.handle.dispose();
  await assert.rejects(f.handle.command(command()), /disposed/);
});

test('failed startup preserves cleanup fences unless absence was confirmed', async t => {
  const f = await preparedFixture(t);
  f.executor.failure = new ScopeStartError('fixture startup', 'dovsky-job-fixture.scope', null, false);
  await assert.rejects(f.handle.command(command({ argv: [process.execPath], cwd: f.project })), ScopeStartError);
  await assert.rejects(f.handle.dispose(), /reconciliation/);
  assert.ok(existsSync(f.handle.sandboxDir));
});

test('pending enrollment excludes concurrent disposal and extraction', async t => {
  const f = await preparedFixture(t);
  let persisted!: () => void;
  const pending = f.handle.command(command({ argv: [process.execPath], cwd: f.project,
    onEnrolled: () => new Promise<void>(resolve => { persisted = resolve; }) }));
  await assert.rejects(f.handle.dispose(), /pending/);
  await assert.rejects(f.handle.extract(join(f.root, 'delta')), /pending/);
  assert.ok(existsSync(f.handle.privateRepo)); persisted();
  await pending; f.executor.state = 'absent'; await f.handle.dispose();
});

test('preparation failure removes only the newly allocated module tree', async t => {
  const f = await preparedFixture(t);
  const request = { ...f.request, jobId: 'failed', baseline: { ...f.request.baseline, manifest: { ...f.request.baseline.manifest, commit: '0000000000000000000000000000000000000000' } } };
  await assert.rejects(f.isolation.prepare(request), /Git/);
  assert.ok(existsSync(f.handle.privateRepo)); assert.ok(existsSync(f.project));
  f.executor.state = 'absent'; await f.handle.dispose();
});

test('resolved mounts refuse broad admin/home roots and symlink aliases to hidden storage', t => {
  const f = directoryFixture(t);
  const repo = join(f.root, 'private'), run = join(f.root, 'run'); mkdirSync(repo); mkdirSync(run);
  const socket = join(f.admin, 'job.sock'); writeFileSync(socket, 'path-only planning fixture');
  const alias = join(f.root, 'alias'); symlinkSync(f.admin, alias);
  const context = { privateRepo: repo, sandboxDir: f.root, runDirectory: run, homeDirectory: join(f.root, 'home'), tmpDirectory: join(f.root, 'tmp'),
    visibleCwd: f.project, projectPath: f.project, jobSocketPath: socket, readOnly: false, operatorHome: f.home, hiddenPaths: [f.admin], config: limits };
  for (const path of [f.admin, alias, f.home, '/etc', '/run']) {
    assert.throws(() => buildSandboxPlan({ ...context, config: { ...limits, runtimePaths: [path] } }, command({ argv: [process.execPath], cwd: f.project })), /protected root/);
  }
});

test('actual script target and interpreter are resolved without mounting an operator home', t => {
  const f = directoryFixture(t), script = join(f.root, 'script'), link = join(f.root, 'tool');
  writeFileSync(join(f.root, 'package.json'), '{"name":"s1-fixture"}');
  writeFileSync(script, '#!/usr/bin/env node\nconsole.log("fixture")\n', { mode: 0o755 }); symlinkSync(script, link);
  const runtime = resolveRuntime([link], { PATH: process.env.PATH }, f.root);
  assert.equal(runtime.argv[0], script); assert.ok(runtime.files.includes(realpathSync(process.execPath))); assert.ok(runtime.files.includes('/usr/bin/env'));
  assert.ok(runtime.packageRoots.includes(f.root));
});

test('availability refuses missing bubblewrap and does not launch requested work', async t => {
  const f = directoryFixture(t), ports = scopeFixture().ports;
  let spawns = 0;
  ports.spawn = () => { spawns++; throw new Error('unexpected spawn'); };
  ports.run = async () => { throw new Error('bubblewrap not installed'); };
  const isolation = new BubblewrapIsolation({ sandboxRoot: f.sandboxRoot, hiddenPaths: [f.admin], executor: new SystemdScopeExecutor({ ports }) });
  const availability = await isolation.available();
  assert.equal(availability.available, false); assert.match(availability.reason!, /bubblewrap not installed/); assert.equal(spawns, 0);
});

test('mount planning maps resolver targets, executable files and readonly dependencies without admin parents', t => {
  const f = planFixture(t);
  const deps = join(f.project, 'node_modules'); mkdirSync(deps); writeFileSync(join(deps, 'fixture'), 'dependency');
  const plan = buildSandboxPlan({ ...f.context, readOnly: true, config: { ...limits, dependencyRoots: [deps] } },
    command({ argv: [process.execPath], cwd: f.project, env: { DOVSKY_SOCKET: '/operator.sock', DOVSKY_JOB_ID: 'fixture', KEEP: 'same' } }));
  assert.equal(plan.env.DOVSKY_SOCKET, join(f.context.runDirectory, 'dovsky.sock'));
  assert.equal(plan.env.KEEP, 'same'); assert.equal(plan.env.DOVSKY_JOB_ID, 'fixture');
  assert.equal(plan.argv[plan.argv.indexOf(f.context.privateRepo) - 1], '--bind');
  assert.equal(plan.argv[plan.argv.indexOf(deps) - 1], '--ro-bind');
  const seal = plan.argv.indexOf('--remount-ro');
  assert.equal(plan.argv[seal + 1], f.project);
  assert.ok(seal > plan.argv.indexOf(deps) && seal < plan.argv.indexOf('--'));
  assert.equal(plan.argv[plan.argv.indexOf(f.context.runDirectory) - 1], '--bind');
  assert.ok(plan.mounts.some(mount => mount.source === realpathSync(process.execPath) && mount.readOnly));
  if (existsSync('/etc/resolv.conf')) assert.ok(plan.mounts.some(mount => mount.source === realpathSync('/etc/resolv.conf') && mount.target === '/etc/resolv.conf'));
  assert.equal(plan.mounts.some(mount => ['/run', '/etc', f.admin, f.home, f.project, f.sandboxRoot].includes(mount.source)), false);
  assert.equal(plan.argv.includes('/operator.sock'), false);
});

test('dependency targets follow an alternate stable project root', t => {
  const f = planFixture(t), deps = join(f.project, 'node_modules'); mkdirSync(deps);
  const visible = join(f.root, 'visible');
  const plan = buildSandboxPlan({ ...f.context, visibleCwd: visible, config: { ...limits, dependencyRoots: [deps] } },
    command({ argv: [process.execPath], cwd: visible }));
  assert.ok(plan.mounts.some(mount => mount.source === deps && mount.target === join(visible, 'node_modules') && mount.readOnly));
});

test('project PATH executable resolves against the complete private baseline', t => {
  const f = planFixture(t);
  for (const root of [f.project, f.context.privateRepo]) {
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'local-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const path = join(f.project, 'bin') + ':/usr/bin:/bin';
  const plan = buildSandboxPlan(f.context, command({ argv: ['local-tool'], cwd: f.project, env: { PATH: path } }));
  assert.equal(plan.argv.at(-1), join(f.project, 'bin', 'local-tool'));
  assert.equal(plan.env.PATH, path);
  assert.equal(plan.mounts.some(mount => mount.source === join(f.project, 'bin', 'local-tool')), false);
});

test('private HOME overrides every ambient provider and XDG state directory', t => {
  const f = planFixture(t);
  const keys = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'];
  const plan = buildSandboxPlan(f.context, command({ argv: [process.execPath], cwd: f.project,
    env: Object.fromEntries(keys.map(key => [key, '/ambient/operator-state'])) }));
  assert.equal(plan.env.HOME, f.home);
  for (const key of keys.slice(1)) assert.ok(plan.env[key]?.startsWith(f.home + '/'), key);
});

test('retained home mounts only its home descendant and preserves the narrow readonly credential boundary', async t => {
  const f = planFixture(t), home = acquireProviderHome(f.sandboxRoot, 'mount-boundary');
  mkdirSync(join(f.home, '.codex'));
  const credential = join(f.home, '.codex', 'fixture-auth.json'); writeFileSync(credential, 'synthetic fixture only');
  const plan = buildSandboxPlan({ ...f.context, homeDirectory: home.homeDirectory,
    config: { ...limits, homePaths: [credential] } }, command({ argv: [process.execPath], cwd: f.project }));
  assert.ok(plan.mounts.some(m => m.source === home.homeDirectory && m.target === f.home && !m.readOnly));
  assert.ok(plan.mounts.some(m => m.source === credential && m.target === credential && m.readOnly));
  assert.equal(plan.mounts.some(m => [f.home, f.sandboxRoot, join(f.sandboxRoot, 'provider-state'), join(f.sandboxRoot, 'provider-state', 'mount-boundary')].includes(m.source)), false);
  assert.equal(existsSync(join(home.homeDirectory, '.codex', 'fixture-auth.json')), false);
  await home.release(async () => true);
});
