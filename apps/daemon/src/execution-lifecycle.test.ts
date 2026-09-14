import assert from 'node:assert/strict';
import test from 'node:test';
import { executionLifecycle } from './execution-lifecycle.js';
import { command, delay, enrolled, fakeChild } from './__fixtures__/s1-scope.js';

test('completion retains its authoritative absence without a second raw scope read', async () => {
  const child = fakeChild();
  let state: 'alive' | 'absent' | 'unverifiable' = 'alive', reads = 0;
  const handle = executionLifecycle(enrolled, child, command({ timeoutMs: 500 }), {
    observe: async () => { reads += 1; return { state, members: state === 'alive' ? [42] : [], reason: state === 'unverifiable' ? 'ENODEV' : null }; },
    signal: async () => undefined, pollMs: 2,
  });
  await delay(5); state = 'absent'; child.finish(); await handle.completion;
  const settledReads = reads;
  state = 'unverifiable';
  assert.deepEqual(await handle.observe(), { state: 'absent', members: [], reason: null });
  assert.equal(reads, settledReads);
});

test('pre-completion ENODEV remains unverifiable and fences completion', async () => {
  const child = fakeChild();
  let state: 'alive' | 'absent' | 'enodev' = 'alive', completed = false;
  const handle = executionLifecycle(enrolled, child, command({ timeoutMs: 500 }), {
    observe: async () => {
      if (state === 'enodev') throw Object.assign(new Error('ENODEV: cgroup is being removed'), { code: 'ENODEV' });
      return { state, members: state === 'alive' ? [42] : [], reason: null };
    }, signal: async () => undefined, pollMs: 2,
  });
  void handle.completion.then(() => { completed = true; });
  await delay(5); state = 'enodev'; child.finish(); await delay(10);
  assert.equal(completed, false);
  const observation = await handle.observe();
  assert.equal(observation.state, 'unverifiable'); assert.match(observation.reason ?? '', /ENODEV/);
  state = 'absent'; await handle.completion;
});

test('late output handler errors do not alter the already settled completion result', async () => {
  const child = fakeChild();
  let state: 'alive' | 'absent' = 'alive';
  const handle = executionLifecycle(enrolled, child, command({ timeoutMs: 500, onStdout: () => { throw new Error('late output'); } }), {
    observe: async () => ({ state, members: state === 'alive' ? [42] : [], reason: null }), signal: async () => undefined, pollMs: 2,
  });
  await delay(5); state = 'absent'; child.finish();
  const completion = await handle.completion;
  child.stdout.emit('data', Buffer.from('late'));
  assert.equal(completion.outputError, undefined);
  assert.equal((await handle.result).outputError, undefined);
});
