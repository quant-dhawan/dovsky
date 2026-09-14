import assert from 'node:assert/strict';
import test from 'node:test';
import { executionLifecycle } from './execution-lifecycle.js';
import { command, delay, enrolled, fakeChild } from './__fixtures__/s1-scope.js';

test('deadline result settles while completion and descendants remain pending; TERM precedes KILL', async () => {
  const child = fakeChild(), signals: string[] = [];
  let state: 'alive' | 'absent' = 'alive', completed = false;
  const handle = executionLifecycle(enrolled, child, command({ timeoutMs: 10 }), {
    observe: async () => ({ state, members: state === 'alive' ? [84] : [], reason: null }),
    signal: async signal => { signals.push(signal); }, graceMs: 10, pollMs: 2,
  });
  void handle.completion.then(() => { completed = true; });
  child.finish();
  assert.equal((await handle.result).timedOut, true);
  assert.equal(completed, false);
  await delay(20);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.equal(completed, false);
  state = 'absent'; await delay(5);
  assert.equal((await handle.completion).timedOut, true);
});

test('release deadline never auto-kills and retains an explicitly signallable handle', async () => {
  const child = fakeChild(), signals: string[] = [];
  let state: 'alive' | 'absent' = 'alive', completed = false;
  const handle = executionLifecycle(enrolled, child, command({ timeoutMs: 5, kind: 'release', killOnTimeout: false }), {
    observe: async () => ({ state, members: [84], reason: null }),
    signal: async signal => { signals.push(signal); }, graceMs: 5, pollMs: 2,
  });
  void handle.completion.then(() => { completed = true; });
  assert.equal((await handle.result).timedOut, true); await delay(20);
  assert.deepEqual(signals, []); assert.equal(completed, false);
  await handle.signal('SIGKILL'); assert.deepEqual(signals, ['SIGKILL']);
  state = 'absent'; child.finish(); await delay(5); await handle.completion;
});

test('bounded capture still streams every chunk to the caller', async () => {
  const child = fakeChild(), streamed: Buffer[] = [];
  let state: 'alive' | 'absent' = 'alive';
  const handle = executionLifecycle(enrolled, child, command({ onStdout: data => { streamed.push(data); } }), {
    observe: async () => ({ state, members: [], reason: null }), signal: async () => undefined, captureBytes: 4, pollMs: 2,
  });
  child.stdout.emit('data', Buffer.from('abc')); child.stdout.emit('data', Buffer.from('defgh'));
  child.stderr.emit('data', Buffer.from('123456789'));
  state = 'absent'; child.finish(); await delay(5);
  const result = await handle.completion;
  assert.equal(result.stdout, 'abcd'); assert.equal(result.stderr, '1234'); assert.equal(Buffer.concat(streamed).toString(), 'abcdefgh');
});

test('fast successful close before the next observation poll is not a timeout', async () => {
  const child = fakeChild();
  let state: 'alive' | 'absent' = 'alive';
  const handle = executionLifecycle(enrolled, child, command({ timeoutMs: 30, killOnTimeout: false }), {
    observe: async () => ({ state, members: state === 'alive' ? [42] : [], reason: null }),
    signal: async () => undefined,
  });
  await delay(5); state = 'absent'; child.finish(0);
  const result = await handle.result;
  await delay(60); await handle.completion;
  assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false);
});

test('release output-handler failure never automatically kills the operation', async () => {
  const child = fakeChild(), signals: string[] = [];
  let state: 'alive' | 'absent' = 'alive';
  const handle = executionLifecycle(enrolled, child, command({ kind: 'release', killOnTimeout: false,
    onStdout: () => { throw new Error('ordinary output sink failure'); } }), {
    observe: async () => ({ state, members: state === 'alive' ? [42] : [], reason: null }),
    signal: async value => { signals.push(value); }, graceMs: 5, pollMs: 2,
  });
  child.stdout.emit('data', Buffer.from('release output'));
  await delay(15); state = 'absent'; child.finish(0);
  await delay(5); const result = await handle.completion;
  assert.deepEqual(signals, []);
  assert.equal(result.stdout, 'release output');
  assert.match(result.outputError!, /stdout callback failed: Error: ordinary output sink failure/);
});

test('release kind refuses automatic deadline killing even if a caller requests it', async () => {
  const child = fakeChild(), signals: string[] = [];
  let state: 'alive' | 'absent' = 'alive';
  const handle = executionLifecycle(enrolled, child, command({ kind: 'release', killOnTimeout: true, timeoutMs: 5 }), {
    observe: async () => ({ state, members: state === 'alive' ? [42] : [], reason: null }),
    signal: async value => { signals.push(value); }, graceMs: 2, pollMs: 2,
  });
  assert.equal((await handle.result).timedOut, true);
  await delay(10); assert.deepEqual(signals, []);
  await handle.signal('SIGKILL'); assert.deepEqual(signals, ['SIGKILL']);
  state = 'absent'; child.finish(); await handle.completion;
});

test('ordinary output-handler failure is bounded and terminates with an explicit diagnostic', async () => {
  const child = fakeChild(), signals: string[] = [];
  let state: 'alive' | 'absent' = 'alive';
  const handle = executionLifecycle(enrolled, child, command({ onStderr: () => { throw new Error('x'.repeat(5000)); } }), {
    observe: async () => ({ state, members: state === 'alive' ? [42] : [], reason: null }),
    signal: async value => { signals.push(value); }, graceMs: 2, pollMs: 2,
  });
  child.stderr.emit('data', Buffer.from('actual diagnostic'));
  await delay(10); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  state = 'absent'; child.finish(1);
  const result = await handle.completion;
  assert.equal(result.stderr, 'actual diagnostic');
  assert.match(result.outputError!, /^stderr callback failed: Error: x/);
  assert.ok(result.outputError!.length < 2100);
});
