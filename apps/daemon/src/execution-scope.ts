import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxConfig } from '@dovsky/protocol';
import { readProcessIdentity, type ProcessIdentity, type ProcessObservation } from './execution-lease.js';
import type { CommandSpec, ExecutionEnrollment, ExecutionHandle } from './isolation.js';
import { executionLifecycle } from './execution-lifecycle.js';

export interface CommandOutput { stdout: string; stderr: string; exitCode: number; }
/** Small ports for ordinary deterministic tests; the default always uses Linux. */
export interface ScopePorts {
  run(argv: string[]): Promise<CommandOutput>;
  spawn(argv: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams;
  readText(path: string): string;
  directories(path: string): string[];
  identity(pid: number): ProcessIdentity | null;
  executable(pid: number): string;
}

function boundedText(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length === buffer.length) throw new Error(`Oversized observation: ${path}`);
    return buffer.subarray(0, length).toString();
  } finally { closeSync(fd); }
}

export const linuxScopePorts: ScopePorts = {
  run: argv => new Promise((resolve, reject) => {
    execFile(argv[0]!, argv.slice(1), { shell: false, timeout: 5000, killSignal: 'SIGKILL',
      maxBuffer: 128 * 1024, encoding: 'utf8', env: managerEnvironment() }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed)) reject(error);
      else resolve({ stdout, stderr, exitCode: error ? Number(error.code) : 0 });
    });
  }),
  spawn: (argv, env) => spawn(argv[0]!, argv.slice(1), { shell: false, cwd: '/', env, stdio: ['pipe', 'pipe', 'pipe'] }),
  readText: boundedText,
  directories: path => {
    if (!lstatSync(path).isDirectory()) throw new Error(`Not a cgroup directory: ${path}`);
    return readdirSync(path, { withFileTypes: true }).filter(entry => {
      if (entry.isSymbolicLink()) throw new Error('Unexpected cgroup symlink');
      return entry.isDirectory();
    }).map(entry => entry.name);
  },
  identity: readProcessIdentity,
  executable: pid => realpathSync(`/proc/${pid}/exe`),
};

function managerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
  for (const key of ['HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function validateUnit(unit: string): void {
  if (!/^dovsky-job-[a-zA-Z0-9-]{1,180}\.scope$/.test(unit)) throw new Error('Invalid execution scope unit');
}
function validateScope(enrollment: ExecutionEnrollment): string {
  validateUnit(enrollment.scopeUnit);
  const path = enrollment.cgroupPath;
  if (!path.startsWith('/') || normalize(path) !== path || path.includes('\0') || basename(path) !== enrollment.scopeUnit) {
    throw new Error('Invalid execution scope cgroup');
  }
  return join('/sys/fs/cgroup', path);
}
const observation = (state: ProcessObservation['state'], members: number[] = [], reason: string | null = null): ProcessObservation => ({ state, members, reason });

/** Suitable for database.observeLease; no process-group substitution for a scope. */
export function observeScope(enrollment: ExecutionEnrollment, ports: ScopePorts = linuxScopePorts): ProcessObservation {
  try {
    const root = validateScope(enrollment);
    const boot = ports.readText('/proc/sys/kernel/random/boot_id').trim();
    if (!boot) throw new Error('Kernel boot identity is unavailable');
    if (boot !== enrollment.identity.bootId) return observation('absent', [], 'The host rebooted after this lease was recorded');
    const members = new Set<number>();
    let visited = 0;
    const visit = (path: string): void => {
      if (++visited > 4096) throw new Error('Cgroup enumeration exceeds bound');
      let lines: string;
      try { lines = ports.readText(join(path, 'cgroup.procs')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const line of lines.trim().split('\n').filter(Boolean)) {
        const pid = Number(line);
        if (!/^\d+$/.test(line) || !Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid cgroup member');
        members.add(pid);
        if (members.size > 100_000) throw new Error('Cgroup membership exceeds bound');
      }
      let children: string[];
      try { children = ports.directories(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const child of children) {
        if (!child || child === '.' || child === '..' || child.includes('/')) throw new Error('Invalid cgroup child');
        visit(join(path, child));
      }
    };
    visit(root);
    return observation(members.size ? 'alive' : 'absent', [...members].sort((a, b) => a - b));
  } catch (error) { return observation('unverifiable', [], String(error)); }
}

export async function signalScope(enrollment: ExecutionEnrollment, signal: 'SIGTERM' | 'SIGKILL', ports: ScopePorts = linuxScopePorts): Promise<void> {
  validateScope(enrollment);
  if (signal !== 'SIGTERM' && signal !== 'SIGKILL') throw new Error('Unsupported scope signal');
  if (observeScope(enrollment, ports).state === 'absent') return;
  // Avoid signaling a reused unit on a different boot or an unknown boot.
  if (ports.readText('/proc/sys/kernel/random/boot_id').trim() !== enrollment.identity.bootId) throw new Error('Cannot verify scope boot identity');
  const result = await ports.run(['/usr/bin/systemctl', '--user', 'kill', '--kill-whom=all', `--signal=${signal}`, enrollment.scopeUnit]);
  if (result.exitCode !== 0 && observeScope(enrollment, ports).state !== 'absent') throw new Error(`Scope signal failed: ${result.stderr}`);
}

export async function confirmScopeGone(enrollment: ExecutionEnrollment, timeoutMs = 5000, ports: ScopePorts = linuxScopePorts): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (observeScope(enrollment, ports).state === 'absent') return true;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);
  return observeScope(enrollment, ports).state === 'absent';
}

export function validateLimits(config: Pick<SandboxConfig, 'memoryMax' | 'cpuQuota' | 'tasksMax'>): void {
  if (!/^\d+(?:\.\d+)?[KMGT]?$/.test(config.memoryMax) || !Number.isSafeInteger(memoryBytes(config.memoryMax)) || memoryBytes(config.memoryMax) < 1
    || !/^[1-9]\d*%$/.test(config.cpuQuota) || !Number.isSafeInteger(Number(config.cpuQuota.slice(0, -1)))
    || !Number.isSafeInteger(config.tasksMax) || config.tasksMax < 1 || config.tasksMax > 4096) throw new Error('Sandbox requires finite positive hard limits');
}
function memoryBytes(value: string): number {
  const match = /^([\d.]+)([KMGT]?)$/.exec(value);
  return match ? Math.floor(Number(match[1]) * 1024 ** (match[2] ? 'KMGT'.indexOf(match[2]) + 1 : 0)) : NaN;
}
function verifyLimits(enrollment: ExecutionEnrollment, config: SandboxConfig, ports: ScopePorts): void {
  const root = validateScope(enrollment);
  const memory = memoryBytes(config.memoryMax);
  const actualMemory = Number(ports.readText(join(root, 'memory.max')).trim());
  const cpu = ports.readText(join(root, 'cpu.max')).trim().split(/\s+/).map(Number);
  if (!Number.isFinite(actualMemory) || actualMemory <= 0 || actualMemory > memory
    || ports.readText(join(root, 'memory.swap.max')).trim() !== '0'
    || ports.readText(join(root, 'pids.max')).trim() !== String(config.tasksMax)
    || cpu.length !== 2 || !cpu.every(value => Number.isFinite(value) && value > 0)
    || cpu[0]! / cpu[1]! > Number(config.cpuQuota.slice(0, -1)) / 100 + 0.00001) throw new Error('Scope hard limits are not enforced');
}

export interface ScopeExecutionOptions {
  ports?: ScopePorts;
  startupMs?: number;
  graceMs?: number;
  captureBytes?: number;
}
/** Failed startup retains its named scope when absence cannot be proved. */
export class ScopeStartError extends Error {
  constructor(message: string, readonly scopeUnit: string, readonly enrollment: ExecutionEnrollment | null,
    readonly cleanupConfirmed: boolean, readonly spawnInvoked = true) { super(message); }
}

export class SystemdScopeExecutor {
  readonly ports: ScopePorts;
  readonly startupMs: number;
  readonly graceMs: number;
  readonly captureBytes: number;
  constructor(options: ScopeExecutionOptions = {}) {
    this.ports = options.ports ?? linuxScopePorts;
    this.startupMs = options.startupMs ?? 10_000;
    this.graceMs = options.graceMs ?? 1000;
    this.captureBytes = options.captureBytes ?? 1024 * 1024;
    for (const value of [this.startupMs, this.graceMs, this.captureBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid execution bounds');
    }
    if (this.startupMs > 60_000) throw new Error('Startup bound exceeds gate timeout');
  }

  async start(spec: CommandSpec, config: SandboxConfig): Promise<ExecutionHandle> {
    validateLimits(config);
    if (!spec.argv[0] || spec.argv.some(value => value.includes('\0')) || !Number.isSafeInteger(spec.timeoutMs)
      || spec.timeoutMs < 1 || spec.timeoutMs > 2_147_483_647 || !Number.isSafeInteger(spec.number) || spec.number < 0) throw new Error('Invalid execution command');
    const unit = `dovsky-job-${randomUUID()}-${spec.kind}-${spec.number}.scope`;
    validateUnit(unit);
    const nonce = randomUUID();
    const argv = ['/usr/bin/systemd-run', '--user', '--scope', '--quiet', '--collect', `--unit=${unit}`,
      '-p', `MemoryMax=${config.memoryMax}`, '-p', 'MemorySwapMax=0', '-p', `CPUQuota=${config.cpuQuota}`,
      '-p', `TasksMax=${config.tasksMax}`, '--', process.execPath, fileURLToPath(new URL('./execution-gate.js', import.meta.url)), ...spec.argv];
    const context = JSON.stringify({ cwd: spec.cwd, env: spec.env });
    if (Buffer.byteLength(context) + Buffer.byteLength(argv.join('\0')) > 1024 * 1024) throw new Error('Execution command exceeds argv/environment bound');
    try {
      const bootId = this.ports.readText('/proc/sys/kernel/random/boot_id').trim();
      if (!bootId) throw new Error('Kernel boot identity is unavailable');
      await spec.onScopeStarting?.({ scopeUnit: unit, bootId });
    } catch (error) { throw new ScopeStartError(String(error), unit, null, true, false); }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.ports.spawn(argv, { ...managerEnvironment(), DOVSKY_EXECUTION_GATE_READY: nonce,
        DOVSKY_EXECUTION_COMMAND: context, DOVSKY_EXECUTION_GATE_TIMEOUT_MS: String(this.startupMs) });
    } catch (error) { throw new ScopeStartError(String(error), unit, null, false, true); }
    child.stdin.on('error', () => undefined);
    let enrollment: ExecutionEnrollment | null = null;
    let closed = false, startupFailure: Error | null = null, header = Buffer.alloc(0), startupStderr = '';
    let rejectFailure!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
    const onError = (error: Error): void => { startupFailure = error; rejectFailure(error); };
    const onClose = (): void => { closed = true; onError(new Error('Execution gate exited before release')); };
    child.once('error', onError); child.once('close', onClose);
    const onStderr = (chunk: Buffer): void => { startupStderr = (startupStderr + chunk.toString()).slice(-4096); };
    child.stderr.on('data', onStderr);
    let onData!: (chunk: Buffer) => void;
    const ready = new Promise<number>((resolve, reject) => {
      onData = chunk => {
        if (header.length + chunk.length > 1024) return reject(new Error('Oversized execution gate handshake'));
        header = Buffer.concat([header, chunk]);
        const newline = header.indexOf(10);
        if (newline < 0) return;
        if (newline !== header.length - 1) return reject(new Error('Unexpected output before enrollment'));
        const match = new RegExp(`^DOVSKY_GATE_READY ${nonce} ([1-9][0-9]*)\\n$`).exec(header.toString());
        if (!match) return reject(new Error('Invalid execution gate ready handshake'));
        child.stdout.off('data', onData);
        resolve(Number(match[1]));
      };
      child.stdout.on('data', onData);
    });
    const timer = setTimeout(() => onError(new Error('Execution scope startup timed out')), this.startupMs);
    try {
      const work = async (): Promise<void> => {
        const pid = await ready;
        const identity = this.ports.identity(pid);
        // systemd-run may exec in place: a PID match alone neither proves nor
        // disproves enrollment. Verify the ready process is now the Node gate.
        if (!identity || this.ports.executable(pid) !== realpathSync(process.execPath)) throw new Error('Missing actual execution gate identity');
        const groups = this.ports.readText(`/proc/${pid}/cgroup`).trim().split('\n').filter(line => line.startsWith('0::'));
        if (groups.length !== 1) throw new Error('Ambiguous execution gate cgroup');
        const candidate: ExecutionEnrollment = { identity, scopeUnit: unit, cgroupPath: groups[0]!.slice(3) };
        validateScope(candidate);
        enrollment = candidate;
        const shown = await this.ports.run(['/usr/bin/systemctl', '--user', 'show', unit, '--property=ControlGroup', '--value']);
        if (shown.exitCode || shown.stdout.trim() !== candidate.cgroupPath) throw new Error('Named scope does not match execution gate cgroup');
        const observed = observeScope(candidate, this.ports);
        if (observed.state !== 'alive' || !observed.members.includes(pid)) throw new Error('Execution gate is not a verified scope member');
        verifyLimits(candidate, config, this.ports);
        if (startupFailure || closed) throw startupFailure ?? new Error('Execution gate closed');
        await spec.onEnrolled(candidate);
        if (startupFailure || closed) throw startupFailure ?? new Error('Execution gate closed');
        if (JSON.stringify(this.ports.identity(pid)) !== JSON.stringify(identity) || this.ports.executable(pid) !== realpathSync(process.execPath)
          || !observeScope(candidate, this.ports).members.includes(pid)) throw new Error('Execution gate changed during enrollment');
      };
      await Promise.race([work(), failure]);
      const handle = executionLifecycle(enrollment!, child, spec, { observe: async () => observeScope(enrollment!, this.ports),
        signal: signal => signalScope(enrollment!, signal, this.ports), graceMs: this.graceMs, captureBytes: this.captureBytes });
      child.stdin.end(Buffer.concat([Buffer.from('dovsky-execution-lease-release\n'), Buffer.from(spec.stdin)]));
      return handle;
    } catch (error) {
      child.stdin.destroy();
      const cleanupConfirmed = await this.cleanupStartup(unit, enrollment, child);
      throw new ScopeStartError(`${String(error)}${startupStderr ? `: ${startupStderr}` : ''}`, unit, enrollment, cleanupConfirmed);
    } finally {
      clearTimeout(timer);
      child.stdout.off('data', onData); child.stderr.off('data', onStderr);
      child.off('error', onError); child.off('close', onClose);
    }
  }

  private async cleanupStartup(unit: string, enrollment: ExecutionEnrollment | null, child: ChildProcessWithoutNullStreams): Promise<boolean> {
    // The requested command is still gated. Stop the known launcher and unit,
    // but do not infer that an un-enrolled manager request can no longer arrive.
    child.kill('SIGKILL');
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try { await this.ports.run(['/usr/bin/systemctl', '--user', 'kill', '--kill-whom=all', `--signal=${signal}`, unit]); } catch { /* Confirm below. */ }
      if (enrollment && await confirmScopeGone(enrollment, this.graceMs, this.ports)) return true;
    }
    return false;
  }
}
