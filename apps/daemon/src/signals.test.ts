import assert from 'node:assert/strict';
import test from 'node:test';
import { signalScope } from './execution-scope.js';
import { enrolled, scopeFixture } from './__fixtures__/s1-scope.js';

test('scope signals target every member by exact named unit, never the launcher process group', async () => {
  const f = scopeFixture();
  await signalScope(enrolled, 'SIGTERM', f.ports);
  assert.deepEqual(f.calls, [['/usr/bin/systemctl', '--user', 'kill', '--kill-whom=all', '--signal=SIGTERM', enrolled.scopeUnit]]);
  await signalScope(enrolled, 'SIGKILL', f.ports);
  assert.equal(f.calls.length, 1, 'already absent needs no signal');
  f.state.boot = 'different-boot'; f.state.alive = true;
  await signalScope(enrolled, 'SIGTERM', f.ports); assert.equal(f.calls.length, 1);
});
