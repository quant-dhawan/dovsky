import { spawn } from 'node:child_process';

// Keep the legacy token until the serial E rename. No command runs before this line.
const token = Buffer.from('dovsky-execution-lease-release\n');
const argv = process.argv.slice(2);
let header = Buffer.alloc(0);
let released = false;
let failed = false;
const configuredTimeout = Number(process.env.DOVSKY_EXECUTION_GATE_TIMEOUT_MS ?? 10_000);
const timeout = setTimeout(() => fail('Execution gate release timed out'),
  Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0 && configuredTimeout <= 60_000 ? configuredTimeout : 10_000);

function fail(message: string): void {
  if (released || failed) return;
  failed = true;
  clearTimeout(timeout);
  process.stdin.off('data', onData);
  process.stdin.destroy();
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function onData(chunk: Buffer): void {
  const needed = token.length - header.length;
  const part = chunk.subarray(0, needed);
  if (!part.equals(token.subarray(header.length, header.length + part.length))) {
    fail('Invalid execution gate release');
    return;
  }
  header = Buffer.concat([header, part]);
  if (header.length < token.length) return;
  if (!argv[0]) return fail('Execution gate received no command');
  released = true;
  clearTimeout(timeout);
  process.stdin.pause();
  process.stdin.off('data', onData);
  let command: { cwd?: string; env?: NodeJS.ProcessEnv } = {};
  try {
    if (process.env.DOVSKY_EXECUTION_COMMAND) command = JSON.parse(process.env.DOVSKY_EXECUTION_COMMAND);
  } catch {
    process.stderr.write('Invalid execution command context\n'); process.stdin.destroy(); process.exitCode = 1; return;
  }
  const env = { ...(command.env ?? process.env) };
  delete env.DOVSKY_EXECUTION_GATE_READY;
  delete env.DOVSKY_EXECUTION_GATE_TIMEOUT_MS;
  delete env.DOVSKY_EXECUTION_COMMAND;
  const child = spawn(argv[0], argv.slice(1), { shell: false, env, ...(command.cwd ? { cwd: command.cwd } : {}), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => undefined);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.once('close', (code, signal) => {
    process.stdin.destroy();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  // Do not decode stdin: a UTF-8 sequence can straddle the release line's chunk.
  if (chunk.length > needed) child.stdin.write(chunk.subarray(needed));
  process.stdin.pipe(child.stdin);
}

process.stdin.on('data', onData);
process.stdin.once('end', () => { if (!released) fail('EOF before execution gate release'); });
process.stdin.once('error', () => fail('Execution gate input failed'));
if (process.env.DOVSKY_EXECUTION_GATE_READY) {
  process.stdout.write(`DOVSKY_GATE_READY ${process.env.DOVSKY_EXECUTION_GATE_READY} ${process.pid}\n`);
}
process.stdin.resume();
