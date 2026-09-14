import type { SandboxConfig } from '@dovsky/protocol';
import type { BaselineHandle, DeltaArtifact } from './job-delta.js';
import type { ProcessIdentity, ProcessObservation } from './execution-lease.js';

export interface ExecutionEnrollment {
  /** Actual execution gate identity, never the systemd-run client. */
  identity: ProcessIdentity;
  scopeUnit: string;
  cgroupPath: string;
}
export interface ExecutionResult {
  exitCode: number|null;
  signal: NodeJS.Signals|null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** Output persistence/streaming failed; callers must not treat this as a clean success. */
  outputError?: string;
}
export interface ExecutionHandle extends ExecutionEnrollment {
  /** Deadline result can settle while descendants remain alive. */
  result: Promise<ExecutionResult>;
  /** Resolves only after the actual scope and all descendants are absent. */
  completion: Promise<ExecutionResult>;
  observe(): Promise<ProcessObservation>;
  signal(signal:'SIGTERM'|'SIGKILL'): Promise<void>;
}
export interface CommandSpec {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  kind: 'provider'|'gate'|'proof'|'bench'|'release'|'readback';
  number: number;
  timeoutMs: number;
  /** Release execution times out observably but is never automatically killed. */
  killOnTimeout: boolean;
  /** Durable launch intent before the scope launcher can run; not proof of enrollment. */
  onScopeStarting?(intent: { scopeUnit: string; bootId: string }): void | Promise<void>;
  /** Must commit the identity/lease before the command gate is released. */
  onEnrolled(enrollment:ExecutionEnrollment):void|Promise<void>;
  onStdout?(chunk:Buffer):void;
  onStderr?(chunk:Buffer):void;
}
export interface ReadonlyDependencyMount {
  /** Exact installed directory, never a whole cache/administrative root. */
  source: string;
  /** Validated project-relative dependency directory in the stable view. */
  relativePath: string;
  lockHash: string;
}
export interface IsolationRequest {
  jobId: string;
  projectPath: string;
  visibleCwd: string;
  baseline: BaselineHandle;
  readOnly: boolean;
  config: SandboxConfig;
  /** Sole bound job-origin socket; operator socket is structurally hidden. */
  jobSocketPath: string;
  /** Explicit lockfile-selected readonly mounts; root validates before preparation. */
  dependencyMounts?: readonly ReadonlyDependencyMount[];
  /** Root-selected opaque daemon-owned provider home; never an operator path. */
  providerStateKey?: string;
  /** Resumption/retry must refuse a lost home, never silently create an empty replacement. */
  requireExistingProviderState?: boolean;
}
export interface IsolationHandle {
  jobId: string;
  visibleCwd: string;
  privateRepo: string;
  sandboxDir: string;
  runDirectory: string;
  baseline: BaselineHandle;
  readOnly: boolean;
  command(spec:CommandSpec):Promise<ExecutionHandle>;
  extract(directory:string):Promise<DeltaArtifact>;
  /** Refuses while any scope is alive or unverifiable. */
  dispose():Promise<void>;
}
export interface IsolationAvailability {available:boolean;backend:'bwrap';reason:string|null;bwrapVersion:string|null;}
export interface JobIsolation {
  available():Promise<IsolationAvailability>;
  prepare(request:IsolationRequest):Promise<IsolationHandle>;
}

/** There is intentionally no production no-op/fallback isolation implementation. */
export interface ExecutionDependencies {isolation:JobIsolation;}
