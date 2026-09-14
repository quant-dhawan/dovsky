import assert from 'node:assert/strict';
import { chmodSync, lstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { copyInstalledDependencies } from './dependency-output.js';

const require = createRequire(import.meta.url);

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-dependency-output-'));
  const source = join(root, 'source'), target = join(root, 'target');
  mkdirSync(source); mkdirSync(target);
  for (const tree of [source, target]) {
    mkdirSync(join(tree, '.git'));
    writeFileSync(join(tree, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, source, target };
}

test('copies ignored packages, nested roots, modes and relative workspace/.bin links', t => {
  const { source, target } = fixture(t);
  mkdirSync(join(source, 'packages', 'tool'), { recursive: true });
  writeFileSync(join(source, 'packages', 'tool', 'cli'), '#!/bin/sh\necho private\n', { mode: 0o751 });
  mkdirSync(join(source, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(source, 'node_modules', 'tool.json'), '{"installed":true}', { mode: 0o640 });
  symlinkSync('../packages/tool', join(source, 'node_modules', 'tool'));
  symlinkSync('../tool/cli', join(source, 'node_modules', '.bin', 'tool'));
  mkdirSync(join(source, 'packages', 'leaf', 'node_modules', 'nested'), { recursive: true });
  writeFileSync(join(source, 'packages', 'leaf', 'node_modules', 'nested', 'value'), 'nested');
  copyInstalledDependencies(source, target, ['node_modules', 'packages/leaf/node_modules']);
  assert.equal(readlinkSync(join(target, 'node_modules', 'tool')), '../packages/tool');
  assert.equal(readlinkSync(join(target, 'node_modules', '.bin', 'tool')), '../tool/cli');
  assert.equal(lstatSync(join(target, 'node_modules', 'tool.json')).mode & 0o7777, 0o640);
  assert.equal(lstatSync(join(target, 'packages', 'leaf', 'node_modules', 'nested', 'value')).isFile(), true);
});

test('omits missing roots and never replaces an existing target', t => {
  const { source, target } = fixture(t);
  mkdirSync(join(source, 'node_modules'), { recursive: true });
  writeFileSync(join(source, 'node_modules', 'value'), 'source');
  copyInstalledDependencies(source, target, ['node_modules', 'missing/node_modules']);
  assert.equal(lstatSync(join(target, 'node_modules', 'value')).isFile(), true);
  assert.equal(lstatSync(join(target, 'missing'), { throwIfNoEntry: false }), undefined);
  rmSync(join(target, 'node_modules'), { recursive: true });
  mkdirSync(join(target, 'node_modules'), { recursive: true });
  writeFileSync(join(target, 'node_modules', 'value'), 'operator');
  assert.throws(() => copyInstalledDependencies(source, target, ['node_modules']), /already exists/);
  assert.equal(readFileSync(join(target, 'node_modules', 'value'), 'utf8'), 'operator');
});

test('rejects unsafe roots, overlap and symlinked target ancestors', t => {
  const { source, target, root } = fixture(t);
  mkdirSync(join(source, 'node_modules'), { recursive: true });
  for (const roots of [[''], ['../node_modules'], ['/node_modules'], ['packages/node_modules/x'], ['a/node_modules/node_modules'], ['a/./node_modules'], ['a\\b/node_modules']]) {
    assert.throws(() => copyInstalledDependencies(source, target, roots), /root|node_modules|unsafe/i);
  }
  assert.throws(() => copyInstalledDependencies(source, source, ['node_modules']), /overlap/);
  const outside = join(root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(target, 'packages'));
  mkdirSync(join(source, 'packages', 'leaf', 'node_modules'), { recursive: true });
  assert.throws(() => copyInstalledDependencies(source, target, ['packages/leaf/node_modules']), /unsafe.*ancestor/i);
});

test('rejects absolute, escaping, administrative and hardlinked source entries', t => {
  const { source, target, root } = fixture(t);
  mkdirSync(join(source, 'node_modules'), { recursive: true });
  const link = join(source, 'node_modules', 'link');
  for (const value of ['/etc/passwd', '../../outside', '../.git/config']) {
    symlinkSync(value, link);
    assert.throws(() => copyInstalledDependencies(source, target, ['node_modules']), /symlink/i);
    rmSync(link); rmSync(join(target, 'node_modules'), { recursive: true, force: true });
  }
  mkdirSync(join(source, 'node_modules', '.git'));
  writeFileSync(join(source, 'node_modules', '.git', 'config'), 'private');
  assert.throws(() => copyInstalledDependencies(source, target, ['node_modules']), /administration/i);
  rmSync(join(target, 'node_modules'), { recursive: true, force: true });
  rmSync(join(source, 'node_modules', '.git'), { recursive: true, force: true });
  writeFileSync(join(source, 'node_modules', 'real'), 'real');
  linkSync(join(source, 'node_modules', 'real'), join(source, 'node_modules', 'hard'));
  assert.throws(() => copyInstalledDependencies(source, target, ['node_modules']), /hardlink|oversized|unsafe/i);
  const sourceLink = join(root, 'source-link'); symlinkSync(source, sourceLink);
  assert.throws(() => copyInstalledDependencies(sourceLink, target, ['node_modules']), /unsafe ancestor/i);
});

test('refuses predecessor and current administrative directories before copying dependencies', t => {
  for (const name of ['.agentbus', '.dovsky']) {
    const { source, target } = fixture(t);
    mkdirSync(join(source, 'node_modules', name), { recursive: true });
    writeFileSync(join(source, 'node_modules', name, 'private'), 'secret');
    assert.throws(() => copyInstalledDependencies(source, target, ['node_modules']), /administration/i, name);
    assert.equal(lstatSync(join(target, 'node_modules'), { throwIfNoEntry: false }), undefined, name);
  }
});

test('allows missing workspace symlink targets but enforces file, entry and depth bounds', t => {
  const { source, target } = fixture(t);
  mkdirSync(join(source, 'node_modules'), { recursive: true });
  symlinkSync('../packages/not-built/cli', join(source, 'node_modules', 'not-built'));
  copyInstalledDependencies(source, target, ['node_modules']);
  assert.equal(readlinkSync(join(target, 'node_modules', 'not-built')), '../packages/not-built/cli');
  const oversized = join(source, 'node_modules', 'oversized'); writeFileSync(oversized, ''); truncateSync(oversized, 64 * 1024 * 1024 + 1);
  rmSync(join(target, 'node_modules'), { recursive: true, force: true });
  assert.throws(() => copyInstalledDependencies(source, target, ['node_modules']), /oversized|unsafe/i);
});

test('preserves directory modes and refuses roots above the bound', t => {
  const { source, target } = fixture(t);
  mkdirSync(join(source, 'node_modules', 'pkg'), { recursive: true });
  chmodSync(join(source, 'node_modules', 'pkg'), 0o755);
  writeFileSync(join(source, 'node_modules', 'pkg', 'file'), 'ok');
  copyInstalledDependencies(source, target, ['node_modules']);
  assert.equal(lstatSync(join(target, 'node_modules', 'pkg')).mode & 0o7777, 0o755);
  assert.throws(() => copyInstalledDependencies(source, target, Array.from({ length: 33 }, (_, i) => `x${i}/node_modules`)), /roots/);
});

test('enforces entry, depth and total-byte bounds before publishing output', { timeout: 60_000 }, t => {
  const { source, target } = fixture(t);
  mkdirSync(join(source, 'node_modules'));
  for (let i = 0; i < 100_001; i++) writeFileSync(join(source, 'node_modules', `entry-${i}`), '');
  assert.throws(() => copyInstalledDependencies(source, target, ['node_modules']), /bounds/);
  rmSync(join(source, 'node_modules'), { recursive: true, force: true });
  mkdirSync(join(source, 'node_modules'));
  let current = join(source, 'node_modules');
  for (let i = 0; i < 129; i++) { current = join(current, `d${i}`); mkdirSync(current); }
  assert.throws(() => copyInstalledDependencies(source, target, ['node_modules']), /bounds/);
  rmSync(join(source, 'node_modules'), { recursive: true, force: true });
  mkdirSync(join(source, 'node_modules'));
  for (let i = 0; i < 8; i++) { const file = join(source, 'node_modules', `sparse-${i}`); writeFileSync(file, ''); truncateSync(file, 64 * 1024 * 1024); }
  writeFileSync(join(source, 'node_modules', 'over-budget'), 'x');
  assert.throws(() => copyInstalledDependencies(source, target, ['node_modules']), /byte bound/);
});

test('checks opened descriptor identity and size before allocating', t => {
  const { source, target } = fixture(t);
  mkdirSync(join(source, 'node_modules'));
  const victim = join(source, 'node_modules', 'victim'); writeFileSync(victim, 'small');
  const builtin = (awaitImportFs());
  const original = builtin.openSync.bind(builtin) as (path: string, flags: number | string, mode?: number) => number;
  let hooked = false;
  builtin.openSync = ((path: string, flags: number | string, mode?: number) => {
    if (path === victim && !hooked) { hooked = true; truncateSync(victim, 64 * 1024 * 1024 + 1); }
    return original(path, flags, mode);
  }) as typeof builtin.openSync;
  syncBuiltinESMExports();
  try { assert.throws(() => copyInstalledDependencies(source, target, ['node_modules']), /identity|bound|oversized/); }
  finally { builtin.openSync = original as typeof builtin.openSync; syncBuiltinESMExports(); }
});

test('allows workspace links beneath a host administrative ancestor but rejects virtual administration', t => {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-dependency-output-host-admin-'));
  const source = join(root, '.dovsky', 'source'), target = join(root, '.dovsky', 'target');
  for (const tree of [source, target]) { mkdirSync(join(tree, '.git'), { recursive: true }); writeFileSync(join(tree, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n'); }
  mkdirSync(join(source, 'packages', 'tool'), { recursive: true }); writeFileSync(join(source, 'packages', 'tool', 'cli'), '#!/bin/sh\n');
  mkdirSync(join(source, 'node_modules', '.bin'), { recursive: true });
  symlinkSync('../packages/tool', join(source, 'node_modules', 'tool')); symlinkSync('../tool/cli', join(source, 'node_modules', '.bin', 'tool'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.doesNotThrow(() => copyInstalledDependencies(source, target, ['node_modules']));
  const adminSource = join(root, 'admin-source'), adminTarget = join(root, 'admin-target');
  for (const tree of [adminSource, adminTarget]) { mkdirSync(join(tree, '.git'), { recursive: true }); writeFileSync(join(tree, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n'); }
  mkdirSync(join(adminSource, 'node_modules')); symlinkSync('../.cache/private', join(adminSource, 'node_modules', 'admin-link'));
  assert.throws(() => copyInstalledDependencies(adminSource, adminTarget, ['node_modules']), /symlink|administration/i);
});

test('rejects an absent administrative root before treating it as optional', t => {
  const { source, target } = fixture(t);
  assert.throws(() => copyInstalledDependencies(source, target, ['.cache/node_modules']), /root|administration/i);
  assert.equal(lstatSync(join(target, '.cache'), { throwIfNoEntry: false }), undefined);
});

test('enforces the entry bound again when source changes during copy', { timeout: 60_000 }, t => {
  const { source, target } = fixture(t), deps = join(source, 'node_modules');
  mkdirSync(deps); writeFileSync(join(deps, 'original'), '');
  const builtin = require('node:fs') as typeof import('node:fs');
  const originalRead = builtin.readdirSync.bind(builtin); let reads = 0;
  builtin.readdirSync = ((path: string, ...rest: unknown[]) => {
    if (path === deps && ++reads === 2) for (let i = 0; i < 100_001; i++) writeFileSync(join(deps, `late-${i}`), '');
    return originalRead(path, ...(rest as [any]));
  }) as typeof builtin.readdirSync;
  syncBuiltinESMExports();
  try { assert.throws(() => copyInstalledDependencies(source, target, ['node_modules']), /bounds/); }
  finally { builtin.readdirSync = originalRead; syncBuiltinESMExports(); }
});

function awaitImportFs(): typeof import('node:fs') {
  return require('node:fs') as typeof import('node:fs');
}
