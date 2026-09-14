import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CommandSpec, ExecutionEnrollment, ExecutionHandle, ExecutionResult } from './isolation.js';
import type { ProcessObservation } from './execution-lease.js';

export interface LifecycleOptions {
  observe(): Promise<ProcessObservation>;
  signal(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  pollMs?: number;
  graceMs?: number;
  captureBytes?: number;
}

/** A deadline is an outcome; only authoritative absence completes an execution. */
export function executionLifecycle(enrollment: ExecutionEnrollment, child: ChildProcessWithoutNullStreams,
  spec: CommandSpec, options: LifecycleOptions): ExecutionHandle {
  const captureBytes = options.captureBytes ?? 1024 * 1024;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let stdoutBytes = 0, stderrBytes = 0;
  let exitCode: number | null = null, signal: NodeJS.Signals | null = null;
  let exited = false, done = false, timedOut = false, cancelled = false;
  let outputError: string | undefined;
  let resolveResult!: (result: ExecutionResult) => void, resolveCompletion!: (result: ExecutionResult) => void;
  const result = new Promise<ExecutionResult>(resolve => { resolveResult = resolve; });
  const completion = new Promise<ExecutionResult>(resolve => { resolveCompletion = resolve; });
  const snapshot = (): ExecutionResult => ({ exitCode, signal, stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(), timedOut, cancelled, ...(outputError ? { outputError } : {}) });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let polling: ReturnType<typeof setTimeout> | undefined;
  let terminating = false;
  let terminalAbsence: ProcessObservation | null = null;
  const copied = (state: ProcessObservation): ProcessObservation => ({ ...state, members: [...state.members] });
  const observe = async (): Promise<ProcessObservation> => {
    if (terminalAbsence) return copied(terminalAbsence);
    try { return await options.observe(); }
    catch (error) { return { state: 'unverifiable', members: [], reason: String(error) }; }
  };
  const complete = (state: ProcessObservation): boolean => {
    if (done) return true;
    if (exited && state.state === 'absent') {
      terminalAbsence = copied(state);
      done = true;
      clearTimeout(deadline); clearTimeout(escalation); clearTimeout(polling);
      resolveResult(snapshot()); resolveCompletion(snapshot());
      return true;
    }
    return false;
  };
  const poll = async (): Promise<void> => {
    if (complete(await observe())) return;
    // Unverifiable scopes retain a handle and their fences for reconciliation.
    clearTimeout(polling);
    polling = setTimeout(() => { void poll(); }, options.pollMs ?? 50);
    polling.unref();
  };
  const terminate = async (): Promise<void> => {
    if (terminating || done) return;
    terminating = true;
    try { await options.signal('SIGTERM'); } catch { /* Observe even after a failed signal. */ }
    if (done) return;
    escalation = setTimeout(() => {
      void (async () => {
        if (!done && (await observe()).state !== 'absent') {
          try { await options.signal('SIGKILL'); } catch { /* Fences remain until absence. */ }
        }
      })();
    }, options.graceMs ?? 1000);
  };
  const capture = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    const count = stream === 'stdout' ? stdoutBytes : stderrBytes;
    const bytes = chunk.subarray(0, Math.max(0, captureBytes - count));
    if (bytes.length) (stream === 'stdout' ? stdout : stderr).push(Buffer.from(bytes));
    if (stream === 'stdout') stdoutBytes += bytes.length; else stderrBytes += bytes.length;
    try { (stream === 'stdout' ? spec.onStdout : spec.onStderr)?.(chunk); }
    catch (error) {
      outputError ??= `${stream} callback failed: ${String(error).slice(0, 2048)}`;
      // A failed output sink is observable, but is not reconciliation authority
      // to interrupt a possibly committed external release operation.
      if (spec.kind !== 'release') void terminate();
    }
  };
  child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk));
  child.once('error', error => { capture('stderr', Buffer.from(error.message)); });
  child.once('close', (code, childSignal) => {
    exitCode = code; signal = childSignal; exited = true;
    clearTimeout(polling); void poll();
  });
  const deadline = setTimeout(() => { void (async () => {
    if (done) return;
    // Stream closure can precede the next scheduled scope observation.
    if (exited && complete(await observe())) return;
    if (done) return;
    timedOut = true;
    resolveResult(snapshot());
    if (spec.killOnTimeout && spec.kind !== 'release') void terminate();
  })(); }, spec.timeoutMs);
  void poll();
  return { ...enrollment, result, completion, observe, signal: async requested => {
    if (done) return;
    cancelled = true;
    if (requested === 'SIGTERM') await terminate();
    else await options.signal(requested);
  } };
}
