import assert from 'node:assert/strict';
import test from 'node:test';
import { executionLifecycle } from './execution-lifecycle.js';
import { command, delay, enrolled, fakeChild } from './__fixtures__/s1-scope.js';

test('cancellation retains completion through launcher exit and unverifiable scope observation', async () => {
  const child = fakeChild(), signals: string[] = [];
  let state: 'alive' | 'absent' | 'unverifiable' = 'alive', completed = false;
  const handle = executionLifecycle(enrolled, child, command(), {
    observe: async () => ({ state, members: [], reason: null }), signal: async signal => { signals.push(signal); }, graceMs: 5, pollMs: 2,
  });
  void handle.completion.then(() => { completed = true; });
  await handle.signal('SIGTERM'); child.finish(); state = 'unverifiable'; await delay(15);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.equal(completed, false);
  state = 'absent'; await delay(5);
  assert.equal((await handle.completion).cancelled, true);
});
