import assert from 'node:assert/strict';
import test from 'node:test';
import { observeScope, confirmScopeGone, ScopeStartError, SystemdScopeExecutor, validateLimits } from './execution-scope.js';
import { command, delay, enrolled, limits, scopeFixture } from './__fixtures__/s1-scope.js';

test('recursive cgroup members survive launcher/leader exit; boot mismatch is absent', () => {
  const f = scopeFixture();
  f.ports.directories = path => path.endsWith('.scope') ? ['child'] : [];
  const read = f.ports.readText;
  f.ports.readText = path => path.endsWith('/child/cgroup.procs') ? '84\n' : path.endsWith('/cgroup.procs') ? '' : read(path);
  assert.deepEqual(observeScope(enrolled, f.ports), { state: 'alive', members: [84], reason: null });
  f.state.boot = 'new-boot';
  assert.equal(observeScope(enrolled, f.ports).state, 'absent');
});

test('missing/empty scopes are absent, permission and malformed observations are unverifiable', async () => {
  const f = scopeFixture();
  f.state.alive = false;
  assert.equal(observeScope(enrolled, f.ports).state, 'absent');
  f.state.inaccessible = true;
  assert.equal(observeScope(enrolled, f.ports).state, 'unverifiable');
  assert.equal(await confirmScopeGone(enrolled, 2, f.ports), false);
  f.ports.readText = path => { if (path.endsWith('/boot_id')) return 'fixture-boot'; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
  assert.equal(observeScope(enrolled, f.ports).state, 'absent');
  assert.equal(observeScope({ ...enrolled, cgroupPath: '/wrong.scope' }, f.ports).state, 'unverifiable');
});

test('the actual ready gate is verified and persisted before stdin release', async () => {
  const f = scopeFixture();
  let persisted = false;
  const executor = new SystemdScopeExecutor({ ports: f.ports, graceMs: 2 });
  const handle = await executor.start(command({ stdin: 'payload\nλ\0', onEnrolled: async value => {
    assert.equal(value.identity.pid, 42); assert.notEqual(value.identity.pid, f.child.pid);
    assert.equal(value.scopeUnit, f.state.unit); assert.equal(value.cgroupPath, f.state.path);
    assert.equal(f.child.input.length, 0);
    await delay(5); persisted = true;
  } }), limits);
  assert.equal(persisted, true);
  assert.equal(Buffer.concat(f.child.input).toString(), 'dovsky-execution-lease-release\npayload\nλ\0');
  assert.ok(f.calls[0]!.includes('MemorySwapMax=0'));
  f.state.alive = false; f.child.finish();
  assert.equal((await handle.completion).exitCode, 0);
});

test('exec-in-place launcher PID is accepted only after it is the verified ready Node gate', async () => {
  const f = scopeFixture(); Object.assign(f.child, { pid: 42 });
  const handle = await new SystemdScopeExecutor({ ports: f.ports }).start(command(), limits);
  assert.equal(handle.identity.pid, 42); f.state.alive = false; f.child.finish();
  await handle.completion;
});

for (const failure of ['persistence', 'gate-is-launcher', 'ambiguous', 'wrong-scope', 'hard-limits', 'invalid', 'eof', 'timeout', 'late-persistence']) {
  test(`startup ${failure} prevents command release and cleans the scope`, async () => {
    const f = scopeFixture();
    if (failure === 'gate-is-launcher') f.state.gatePid = 99;
    if (failure === 'ambiguous') { const read = f.ports.readText; f.ports.readText = path => path.endsWith('/cgroup') ? `0::${f.state.path}\n0::${f.state.path}` : read(path); }
    if (failure === 'wrong-scope') f.state.shown = false;
    if (failure === 'hard-limits') f.state.hardLimits = false;
    if (failure === 'invalid' || failure === 'eof') f.state.ready = failure;
    if (failure === 'timeout') f.state.ready = 'none';
    const executor = new SystemdScopeExecutor({ ports: f.ports, startupMs: 20, graceMs: 1 });
    await assert.rejects(executor.start(command({ onEnrolled: async () => {
      if (failure === 'persistence') throw new Error('Persist failed');
      if (failure === 'late-persistence') await delay(40);
    } }), limits), ScopeStartError);
    await delay(45);
    assert.equal(f.child.input.length, 0); assert.equal(f.state.launchCount, 0);
    assert.equal(f.state.alive, false);
    assert.ok(f.calls.some(argv => argv.includes('--signal=SIGTERM')));
  });
}

test('startup cleanup does not claim absence after permission failure', async () => {
  const f = scopeFixture();
  const executor = new SystemdScopeExecutor({ ports: f.ports, graceMs: 1 });
  await assert.rejects(executor.start(command({ onEnrolled: () => { f.state.inaccessible = true; throw new Error('persist'); } }), limits), error => {
    assert.ok(error instanceof ScopeStartError); assert.equal(error.cleanupConfirmed, false); return true;
  });
  assert.deepEqual(f.calls.filter(argv => argv.includes('kill')).map(argv => argv.find(value => value.startsWith('--signal='))), ['--signal=SIGTERM', '--signal=SIGKILL']);
});

test('byte-valued and fractional hard limits stay finite and are checked against the actual cgroup', async () => {
  validateLimits({ ...limits, memoryMax: '0.5G' });
  assert.throws(() => validateLimits({ ...limits, memoryMax: '0' }), /finite/);
  assert.throws(() => validateLimits({ ...limits, memoryMax: '99999999999999999999G' }), /finite/);
  const f = scopeFixture();
  await assert.rejects(new SystemdScopeExecutor({ ports: f.ports, graceMs: 1 }).start(command(), { ...limits, memoryMax: '1048576' }), /hard limits/);
  assert.equal(f.child.input.length, 0);
});
