import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const token = Buffer.from('dovsky-execution-lease-release\n');
function gate(timeout = 1000) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./execution-gate.js', import.meta.url)), process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], {
    env: { ...process.env, DOVSKY_EXECUTION_GATE_TIMEOUT_MS: String(timeout) }, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdin.on('error', () => undefined);
  child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
  return { child, stdout, stderr, closed: once(child, 'close') };
}

test('gate preserves bytes after the one-time handshake, including split Unicode and another token', async () => {
  const f = gate();
  const payload = Buffer.concat([Buffer.from('λ\0\n'), token, Buffer.from([0xff, 0x00])]);
  f.child.stdin.write(token.subarray(0, 5));
  f.child.stdin.write(Buffer.concat([token.subarray(5), payload.subarray(0, 1)]));
  f.child.stdin.end(payload.subarray(1));
  assert.equal((await f.closed)[0], 0); assert.deepEqual(Buffer.concat(f.stdout), payload);
});

for (const input of [Buffer.from('invalid\n'), token.subarray(0, 4), Buffer.alloc(0)]) {
  test(`gate refuses invalid/EOF handshake (${input.length} bytes)`, async () => {
    const f = gate(); f.child.stdin.end(input);
    assert.equal((await f.closed)[0], 1); assert.equal(Buffer.concat(f.stdout).length, 0);
    assert.match(Buffer.concat(f.stderr).toString(), /Invalid|EOF/);
  });
}

test('gate refuses a missing handshake by its bounded startup deadline', async () => {
  const f = gate(20);
  assert.equal((await f.closed)[0], 1); assert.match(Buffer.concat(f.stderr).toString(), /timed out/);
});
