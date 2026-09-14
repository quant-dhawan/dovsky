import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildSandboxPlan } from './sandbox.js';
import { planFixture } from './__fixtures__/s1-sandbox.js';
import { command, limits } from './__fixtures__/s1-scope.js';
import { homeHostFixture } from './__fixtures__/s1-home-host.js';
import { captureBaseline, contentHash } from './job-delta.js';
import type { IsolationHandle, IsolationRequest } from './isolation.js';

function dependencyFixture(t: TestContext) {
  const f = planFixture(t);
  const source = join(f.root, 'cache', 'node_modules'); mkdirSync(source, { recursive: true });
  const lock = '{"lockfileVersion":3}';
  writeFileSync(join(f.context.privateRepo, 'package-lock.json'), lock);
  const mount = { source, relativePath: 'node_modules', lockHash: createHash('sha256').update(lock).digest('hex') };
  const context = { ...f.context, dependencyMounts: [mount] };
  return { ...f, source, mount, context };
}

function nestedDependencyFixture(t: TestContext) {
  const f = dependencyFixture(t), relativePath = 'packages/leaf/node_modules';
  mkdirSync(join(f.context.privateRepo, 'packages/leaf'), { recursive: true });
  const mount = { ...f.mount, relativePath };
  return { ...f, mount, context: { ...f.context, dependencyMounts: [mount] },
    lockPath: join(f.context.privateRepo, 'packages/leaf/package-lock.json'),
    spec: command({ argv: [process.execPath], cwd: f.project }) };
}

for (const withRootLock of [false, true]) test(`nearest-lock accepts nested dependencies with root lock ${withRootLock}`, t => {
  const f = nestedDependencyFixture(t), lock = '{"name":"nested","lockfileVersion":3}';
  if (!withRootLock) unlinkSync(join(f.context.privateRepo, 'package-lock.json'));
  writeFileSync(f.lockPath, lock);
  const mount = { ...f.mount, lockHash: createHash('sha256').update(lock).digest('hex') };
  const plan = buildSandboxPlan({ ...f.context, readOnly: true, dependencyMounts: [mount] }, f.spec);
  assert.deepEqual(plan.mounts.find(m => m.source === mount.source), {
    source: mount.source, target: join(f.project, mount.relativePath), readOnly: true,
  });
  assert.ok(plan.argv.indexOf('--remount-ro') > plan.argv.indexOf(mount.source));
});

test('nearest-lock selects the closest private ancestor independently for every mount', t => {
  const f = nestedDependencyFixture(t), parentLock = '{"name":"parent"}', leafLock = '{"name":"leaf"}';
  writeFileSync(join(f.context.privateRepo, 'packages/package-lock.json'), parentLock);
  writeFileSync(f.lockPath, leafLock);
  const parentHash = createHash('sha256').update(parentLock).digest('hex');
  const leafHash = createHash('sha256').update(leafLock).digest('hex');
  const roots = [
    ['node_modules', f.mount.lockHash],
    ['packages/leaf/node_modules', leafHash],
    ['packages/other/node_modules', parentHash],
    ['missing/leaf/node_modules', f.mount.lockHash],
  ] as const;
  const dependencyMounts = roots.map(([relativePath, lockHash], index) => {
    const source = join(f.root, 'cache', String(index), 'node_modules'); mkdirSync(source, { recursive: true });
    return { source, relativePath, lockHash };
  });
  const plan = buildSandboxPlan({ ...f.context, dependencyMounts }, f.spec);
  for (const mount of dependencyMounts) assert.deepEqual(plan.mounts.find(m => m.source === mount.source), {
    source: mount.source, target: join(f.project, mount.relativePath), readOnly: true,
  });
  for (const lockHash of [f.mount.lockHash, parentHash]) assert.throws(() => buildSandboxPlan({
    ...f.context, dependencyMounts: [{ ...f.mount, lockHash }],
  }, f.spec), /lock hash/);
});

test('nearest-lock revalidates changed, added and removed nested locks before each command plan', t => {
  const f = nestedDependencyFixture(t);
  assert.ok(buildSandboxPlan(f.context, f.spec));
  const lock = '{"name":"nested"}';
  writeFileSync(f.lockPath, lock);
  assert.throws(() => buildSandboxPlan(f.context, f.spec), /lock hash/);
  const context = { ...f.context, dependencyMounts: [{ ...f.mount, lockHash: createHash('sha256').update(lock).digest('hex') }] };
  assert.ok(buildSandboxPlan(context, f.spec));
  writeFileSync(f.lockPath, 'tampered');
  assert.throws(() => buildSandboxPlan(context, f.spec), /lock hash/);
  writeFileSync(f.lockPath, lock);
  assert.ok(buildSandboxPlan(context, f.spec));
  unlinkSync(f.lockPath);
  assert.throws(() => buildSandboxPlan(context, f.spec), /lock hash/);
});

test('nearest-lock refuses missing private locks without using canonical or above-tree locks', t => {
  const f = nestedDependencyFixture(t), rootLock = join(f.context.privateRepo, 'package-lock.json');
  const lock = readFileSync(rootLock); unlinkSync(rootLock);
  writeFileSync(join(f.context.sandboxDir, 'package-lock.json'), lock);
  mkdirSync(join(f.project, 'packages/leaf'), { recursive: true });
  writeFileSync(join(f.project, 'packages/leaf/package-lock.json'), lock);
  assert.throws(() => buildSandboxPlan(f.context, f.spec), /lockfile missing/);
  assert.ok(buildSandboxPlan({ ...f.context, dependencyMounts: [] }, f.spec));
});

for (const kind of ['symlink', 'dangling symlink', 'directory'] as const) test(`nearest-lock rejects a ${kind} instead of falling back`, t => {
  const f = nestedDependencyFixture(t);
  if (kind === 'directory') mkdirSync(f.lockPath);
  else symlinkSync(kind === 'symlink' ? '../../package-lock.json' : 'missing-lock', f.lockPath);
  assert.throws(() => buildSandboxPlan(f.context, f.spec), kind === 'directory' ? /non-regular/ : /ELOOP/);
});

test('nearest-lock uses the frozen 16 MiB regular-file bound', t => {
  const f = nestedDependencyFixture(t), lock = Buffer.alloc(16 * 1024 * 1024, ' ');
  writeFileSync(f.lockPath, lock);
  const lockHash = createHash('sha256').update(lock).digest('hex');
  assert.ok(buildSandboxPlan({ ...f.context, dependencyMounts: [{ ...f.mount, lockHash }] }, f.spec));
  writeFileSync(f.lockPath, ' ', { flag: 'a' });
  // Even a matching root lock cannot bypass an unsafe closer lock.
  assert.throws(() => buildSandboxPlan(f.context, f.spec), /oversized/);
});

for (const ancestor of ['packages', 'packages/leaf']) test(`nearest-lock rejects unsafe ${ancestor} ancestors before reading locks`, t => {
  const f = nestedDependencyFixture(t), path = join(f.context.privateRepo, ancestor);
  rmSync(path, { recursive: true });
  const outside = join(f.root, 'outside'); mkdirSync(join(outside, 'leaf'), { recursive: true });
  const lock = readFileSync(join(f.context.privateRepo, 'package-lock.json'));
  writeFileSync(join(outside, 'package-lock.json'), lock);
  writeFileSync(join(outside, 'leaf/package-lock.json'), lock);
  for (const target of [outside, join(f.root, 'missing')]) {
    symlinkSync(target, path);
    assert.throws(() => buildSandboxPlan(f.context, f.spec), /Unsafe tree ancestor/);
    unlinkSync(path);
  }
  writeFileSync(path, 'not a directory');
  assert.throws(() => buildSandboxPlan(f.context, f.spec), /Unsafe tree ancestor/);
});

test('explicit dependency mounts override legacy roots, including an empty list', t => {
  const f = dependencyFixture(t);
  const context = { ...f.context, config: { ...limits, dependencyRoots: ['/missing/legacy/node_modules'] } };
  const spec = command({ argv: [process.execPath], cwd: f.project });
  const plan = buildSandboxPlan(context, spec);
  assert.ok(plan.mounts.some(m => m.source === f.source && m.target === join(f.project, 'node_modules') && m.readOnly));
  const empty = buildSandboxPlan({ ...context, dependencyMounts: [] }, spec);
  assert.equal(empty.mounts.some(m => m.source === f.source), false);
});

test('explicit dependency-only PATH and .bin workspace links resolve into the private arm', t => {
  const f = dependencyFixture(t);
  mkdirSync(join(f.source, '.bin'));
  mkdirSync(join(f.context.privateRepo, 'packages', 'tool'), { recursive: true });
  writeFileSync(join(f.context.privateRepo, 'packages', 'tool', 'cli'), '#!/bin/sh\necho private\n', { mode: 0o755 });
  symlinkSync('../packages/tool', join(f.source, 'tool'));
  symlinkSync('../tool/cli', join(f.source, '.bin', 'tool'));
  const path = join(f.project, 'node_modules', '.bin') + ':/usr/bin:/bin';
  const plan = buildSandboxPlan(f.context, command({ argv: ['tool'], cwd: f.project, env: { PATH: path } }));
  assert.equal(plan.argv.at(-1), join(f.project, 'packages', 'tool', 'cli'));
  assert.equal(plan.env.PATH, path);
  assert.equal(plan.mounts.some(m => m.source === join(f.project, 'packages', 'tool')), false);
  const relativePath = 'node_modules/.bin:/usr/bin:/bin';
  const relativePlan = buildSandboxPlan(f.context, command({ argv: ['tool'], cwd: f.project, env: { PATH: relativePath } }));
  assert.equal(relativePlan.argv.at(-1), join(f.project, 'packages', 'tool', 'cli'));
  assert.equal(relativePlan.env.PATH, relativePath);
});

test('explicit installed package executables and env interpreters remain in the stable view', t => {
  const f = dependencyFixture(t);
  mkdirSync(join(f.source, 'external')); mkdirSync(join(f.source, '.bin'));
  writeFileSync(join(f.source, 'external', 'package.json'), '{"name":"external"}');
  writeFileSync(join(f.source, 'external', 'cli'), '#!/usr/bin/env node\nconsole.log("external")\n', { mode: 0o755 });
  symlinkSync('../external/cli', join(f.source, '.bin', 'external'));
  const visible = join(f.root, 'visible');
  const context = { ...f.context, visibleCwd: visible };
  const env = { PATH: join(visible, 'node_modules', '.bin') + ':' + process.env.PATH };
  for (const executable of ['external', './node_modules/.bin/external', join(visible, 'node_modules/.bin/external')]) {
    const plan = buildSandboxPlan(context, command({ argv: [executable], cwd: visible, env }));
    assert.equal(plan.argv.at(-1), join(visible, 'node_modules', 'external', 'cli'));
    assert.equal(plan.mounts.filter(m => m.source.startsWith(f.source)).length, 1);
    assert.ok(plan.mounts.every(m => !m.target.startsWith(join(f.root, 'cache'))));
  }
  assert.throws(() => buildSandboxPlan(context, command({ argv: [join(f.source, 'external', 'cli')], cwd: visible, env })), /private project view/);
});

test('dependency validation checks lock contents, exact sources, targets and overlap', t => {
  const f = dependencyFixture(t), spec = command({ argv: [process.execPath], cwd: f.project });
  for (const relativePath of ['', '.', '..', '../node_modules', '/node_modules', 'lib', 'a//node_modules', '.git/node_modules', 'a/./node_modules', 'node_modules/x/node_modules', 'a\\b/node_modules']) {
    assert.throws(() => buildSandboxPlan({ ...f.context, dependencyMounts: [{ ...f.mount, relativePath }] }, spec), /relative dependency target/);
  }
  for (const lockHash of ['x', 'a'.repeat(64), f.mount.lockHash.toUpperCase()]) {
    assert.throws(() => buildSandboxPlan({ ...f.context, dependencyMounts: [{ ...f.mount, lockHash }] }, spec), /lock hash/);
  }
  for (const source of [f.root, f.admin, join(f.admin, 'node_modules')]) {
    if (source.endsWith('node_modules')) mkdirSync(source);
    assert.throws(() => buildSandboxPlan({ ...f.context, dependencyMounts: [{ ...f.mount, source }] }, spec), /protected or non-exact/);
  }
  assert.throws(() => buildSandboxPlan({ ...f.context, dependencyMounts: [f.mount, f.mount] }, spec), /Overlapping/);
  writeFileSync(join(f.context.privateRepo, 'package-lock.json'), 'changed');
  assert.throws(() => buildSandboxPlan(f.context, spec), /lock hash/);
});

test('canonical dependencies are allowed only at their exact corresponding private target', t => {
  const f = dependencyFixture(t), source = join(f.project, 'node_modules'); mkdirSync(source);
  const spec = command({ argv: [process.execPath], cwd: f.project });
  const plan = buildSandboxPlan({ ...f.context, readOnly: true, dependencyMounts: [{ ...f.mount, source }] }, spec);
  const mount = plan.mounts.find(m => m.source === source)!;
  assert.deepEqual(mount, { source, target: source, readOnly: true });
  assert.ok(plan.argv.indexOf('--remount-ro') > plan.argv.indexOf(source));
  assert.throws(() => buildSandboxPlan({ ...f.context, dependencyMounts: [{ ...f.mount, source, relativePath: 'apps/other/node_modules' }] }, spec), /protected or non-exact/);
});

test('dependency links reject absolute, escaping, cyclic and Git targets but permit unbuilt private workspace binaries', t => {
  const f = dependencyFixture(t), spec = command({ argv: [process.execPath], cwd: f.project });
  const link = join(f.source, 'link');
  for (const target of [f.admin, join(f.project, 'packages'), '../../../outside', '../.git/config', 'link']) {
    symlinkSync(target, link);
    assert.throws(() => buildSandboxPlan(f.context, spec), /[Ll]ink|Git/); unlinkSync(link);
  }
  mkdirSync(join(f.context.privateRepo, 'packages', 'tool'), { recursive: true });
  symlinkSync('../packages/tool', join(f.source, 'tool'));
  mkdirSync(join(f.source, '.bin'));
  symlinkSync('../tool/dist/cli', join(f.source, '.bin', 'tool'));
  assert.ok(buildSandboxPlan(f.context, spec));
  // `..` must be applied AFTER following the preceding workspace symlink.
  symlinkSync('tool/../../../outside', link);
  assert.throws(() => buildSandboxPlan(f.context, spec), /escapes/);
});

test('dependency sources, mount targets and hardlinks cannot alias protected storage', t => {
  const f = dependencyFixture(t), spec = command({ argv: [process.execPath], cwd: f.project });
  const alias = join(f.root, 'alias'); symlinkSync(join(f.root, 'cache'), alias);
  assert.throws(() => buildSandboxPlan({ ...f.context, dependencyMounts: [{ ...f.mount, source: join(alias, 'node_modules') }] }, spec), /Unsafe directory ancestor/);
  symlinkSync(f.admin, join(f.context.privateRepo, 'node_modules'));
  assert.throws(() => buildSandboxPlan(f.context, spec), /Unsafe dependency mount target/);
  unlinkSync(join(f.context.privateRepo, 'node_modules'));
  symlinkSync(f.admin, join(f.context.privateRepo, 'apps'));
  assert.throws(() => buildSandboxPlan({ ...f.context, dependencyMounts: [{ ...f.mount, relativePath: 'apps/node_modules' }] }, spec), /Unsafe tree ancestor/);
  linkSync(join(f.admin, 'state.db'), join(f.source, 'hardlink'));
  assert.throws(() => buildSandboxPlan(f.context, spec), /hardlink or special/);
});

test('native dependencies: EROFS, private workspace/.bin resolution and no cache/admin/canonical exposure', { timeout: 60_000 }, async t => {
  const f = await homeHostFixture(t); if (!f) return;
  const lock = '{"lockfileVersion":3}', lockHash = createHash('sha256').update(lock).digest('hex');
  writeFileSync(join(f.project, 'package-lock.json'), lock);
  mkdirSync(join(f.project, 'packages', 'tool'), { recursive: true });
  const cli = '#!/usr/bin/env node\nconsole.log("canonical")\n';
  writeFileSync(join(f.project, 'packages', 'tool', 'cli'), cli, { mode: 0o755 });
  const sources = [join(f.root, 'cache', 'node_modules'), join(f.project, 'node_modules')];
  for (const source of sources) {
    mkdirSync(join(source, '.bin'), { recursive: true }); mkdirSync(join(source, 'external'));
    writeFileSync(join(source, 'external', 'value'), 'installed');
    writeFileSync(join(source, 'external', 'cli'), '#!/usr/bin/env node\nconsole.log("installed")\n', { mode: 0o755 });
    symlinkSync('../external/cli', join(source, '.bin', 'external'));
    symlinkSync('../packages/tool', join(source, 'tool'));
    symlinkSync('../tool/cli', join(source, '.bin', 'tool'));
  }
  const baseline = captureBaseline(f.project, join(f.root, 'baseline'));
  const visibleCwd = join(f.root, 'visible');
  for (const [index, source] of sources.entries()) {
    const request: IsolationRequest = { jobId: `native-deps-${index}`, projectPath: f.project, visibleCwd, baseline, readOnly: false,
      config: { ...limits, dependencyRoots: ['/does-not-exist/node_modules'] }, jobSocketPath: f.socket,
      dependencyMounts: [{ source, relativePath: 'node_modules', lockHash }] };
    const handle: IsolationHandle = await f.isolation.prepare(request);
    writeFileSync(join(handle.privateRepo, 'packages', 'tool', 'cli'), cli.replace('canonical', 'private'));
    const env = { PATH: join(visibleCwd, 'node_modules', '.bin') + ':' + process.env.PATH };
    for (const tool of ['tool', join(visibleCwd, 'node_modules', '.bin', 'tool'), 'external']) {
      const execution = await handle.command(command({ argv: [tool], cwd: visibleCwd, env, timeoutMs: 5000 }));
      const result = await execution.completion;
      assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.stdout.trim(), tool === 'external' ? 'installed' : 'private');
    }
    const inspect = `const fs=require('node:fs'),assert=require('node:assert/strict'),cp=require('node:child_process');
      for(const p of ${JSON.stringify([f.admin, f.project, baseline.directory, join(f.root, 'cache'), join(f.sandboxRoot, 'provider-state')])}) assert.equal(fs.existsSync(p),false,p);
      assert.equal(fs.realpathSync('node_modules/tool'),${JSON.stringify(join(visibleCwd, 'packages', 'tool'))});
      assert.equal(cp.execFileSync('tool',{encoding:'utf8'}).trim(),'private');
      assert.equal(fs.readFileSync('node_modules/external/value','utf8'),'installed');
      assert.throws(()=>fs.writeFileSync('node_modules/external/value','bad'),{code:'EROFS'});
      assert.throws(()=>fs.writeFileSync('node_modules/new','bad'),{code:'EROFS'});
      fs.writeFileSync('node_modules/tool/private-marker','arm');`;
    const execution = await handle.command(command({ argv: [process.execPath, '-e', inspect], cwd: visibleCwd, env, timeoutMs: 5000 }));
    const result = await execution.completion; assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(readFileSync(join(handle.privateRepo, 'packages', 'tool', 'private-marker'), 'utf8'), 'arm');
    assert.equal(existsSync(join(f.project, 'packages', 'tool', 'private-marker')), false);
    assert.equal(contentHash(f.project), baseline.manifest.identity.contentHash);
    await handle.dispose();
    const readonly: IsolationHandle = await f.isolation.prepare({ ...request, readOnly: true });
    const sealed = await readonly.command(command({ argv: [process.execPath, '-e', `const fs=require('node:fs'),assert=require('node:assert/strict');
      assert.throws(()=>fs.writeFileSync('project-write','bad'),{code:'EROFS'});
      assert.throws(()=>fs.writeFileSync('node_modules/external/value','bad'),{code:'EROFS'});
      fs.writeFileSync(process.env.HOME+'/private-state','allowed');`], cwd: visibleCwd, env, timeoutMs: 5000 }));
    const done = await sealed.completion; assert.equal(done.exitCode, 0, done.stderr); await readonly.dispose();
  }
  // Actual special-file validation uses a disposable Unix socket, not an fs mock.
  const server = createServer(); const special = join(sources[0]!, 'special.sock');
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(special, resolve); });
  try {
    await assert.rejects(f.isolation.prepare({ jobId: 'special-file', projectPath: f.project, visibleCwd, baseline, readOnly: false,
      config: limits, jobSocketPath: f.socket, dependencyMounts: [{ source: sources[0]!, relativePath: 'node_modules', lockHash }] }), /hardlink or special/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
