import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { realpathSync } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SandboxConfig } from '@dovsky/protocol';
import type { ScopePorts } from '../execution-scope.js';
import type { CommandSpec, ExecutionEnrollment } from '../isolation.js';

export const limits: SandboxConfig = { enabled: true, backend: 'bwrap', network: false, memoryMax: '128M', cpuQuota: '100%', tasksMax: 32,
  homePaths: [], runtimePaths: [], dependencyRoots: [] };
export const enrolled: ExecutionEnrollment = { identity: { pid: 42, processGroup: 42, startTicks: '100', bootId: 'fixture-boot' },
  scopeUnit: 'dovsky-job-fixture.scope', cgroupPath: '/user.slice/dovsky-job-fixture.scope' };
export function command(extra: Partial<CommandSpec> = {}): CommandSpec {
  return { argv: ['/usr/bin/true'], cwd: '/', env: {}, stdin: '', kind: 'provider', number: 1, timeoutMs: 1000,
    killOnTimeout: true, onEnrolled: () => undefined, ...extra };
}
export function fakeChild(): ChildProcessWithoutNullStreams & { input: Buffer[]; finish(code?: number): void } {
  const child = new EventEmitter() as ReturnType<typeof fakeChild>;
  child.input = [];
  child.stdin = new Writable({ write(chunk, _encoding, callback) { child.input.push(Buffer.from(chunk)); callback(); } });
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  Object.assign(child, { pid: 99, exitCode: null, signalCode: null });
  child.finish = (code = 0) => { Object.assign(child, { exitCode: code }); (child.stdout as PassThrough).end(); (child.stderr as PassThrough).end(); child.emit('close', code, null); };
  child.kill = () => { child.finish(1); return true; };
  return child;
}
export function scopeFixture() {
  const child = fakeChild();
  const calls: string[][] = [];
  const state = { unit: enrolled.scopeUnit, path: enrolled.cgroupPath, boot: 'fixture-boot', alive: true, inaccessible: false,
    ready: 'valid', launchCount: 0, hardLimits: true, shown: true, killed: true, gatePid: 42 };
  child.stdin.once('finish', () => { state.launchCount++; });
  const ports: ScopePorts = {
    spawn: (argv, env) => {
      calls.push(argv);
      state.unit = argv.find(value => value.startsWith('--unit='))!.slice(7);
      state.path = '/user.slice/' + state.unit;
      queueMicrotask(() => {
        if (state.ready === 'none') return;
        if (state.ready === 'eof') { child.finish(1); return; }
        child.stdout.emit('data', Buffer.from(state.ready === 'valid' ? `DOVSKY_GATE_READY ${env.DOVSKY_EXECUTION_GATE_READY} ${state.gatePid}\n` : 'invalid\n'));
      });
      return child;
    },
    run: async argv => {
      calls.push(argv);
      if (argv.includes('kill') && state.killed) { state.alive = false; if (child.exitCode === null) child.finish(1); }
      return { exitCode: 0, stdout: argv.includes('--property=ControlGroup') ? (state.shown ? state.path : '/wrong.scope') : 'not-found', stderr: '' };
    },
    readText: path => {
      if (path.endsWith('/boot_id')) return state.boot;
      if (state.inaccessible) throw Object.assign(new Error('Fixture permission denied'), { code: 'EACCES' });
      if (path === '/proc/42/cgroup') return `0::${state.path}\n`;
      if (path.endsWith('/cgroup.procs')) return state.alive ? '42\n' : '';
      if (path.endsWith('/memory.max')) return state.hardLimits ? '134217728' : 'max';
      if (path.endsWith('/memory.swap.max')) return '0';
      if (path.endsWith('/pids.max')) return '32';
      if (path.endsWith('/cpu.max')) return '100000 100000';
      throw Object.assign(new Error('Fixture absent'), { code: 'ENOENT' });
    },
    directories: () => [], identity: pid => pid === 42 ? { ...enrolled.identity } : null,
    executable: pid => pid === 42 ? realpathSync(process.execPath) : '/usr/bin/systemd-run',
  };
  return { child, calls, state, ports };
}
export const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
