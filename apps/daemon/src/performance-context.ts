import type { ExecutionSetupPhase, ExecutionSetupTraceV1 } from "@dovsky/protocol";

/** The frozen setup order shared by all execution trace producers. */
export const SETUP_PHASES: readonly ExecutionSetupPhase[] = [
  "sandbox_availability",
  "baseline_capture",
  "dependency_materialization",
  "dependency_plan",
  "isolation_prepare",
] as const;

export const MAX_SETUP_PHASE_RECORDS = SETUP_PHASES.length;
/** A corrupt or stalled clock must not create an unbounded duration. */
export const MAX_SETUP_ELAPSED_MS = 86_400_000;

export type MonotonicClock = () => number;
export type SetupTraceKind = ExecutionSetupTraceV1["kind"];

type PhaseRecord = ExecutionSetupTraceV1["phases"][number];

function phaseIndex(phase: string): number {
  return (SETUP_PHASES as readonly string[]).indexOf(phase);
}

function boundedElapsed(now: number, previous: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(previous) || now < previous) {
    throw new Error("setup clock must be monotonic and finite");
  }
  const elapsed = now - previous;
  if (elapsed > MAX_SETUP_ELAPSED_MS) throw new Error("setup duration exceeds bound");
  return elapsed;
}

/** Records only ordered, sanitized setup timings; execution context never enters the trace. */
export class ExecutionSetupRecorder {
  private readonly startedAt: number;
  private previousAt: number;
  private highestPhase = -1;
  private readonly records: PhaseRecord[] = [];

  constructor(
    private readonly clock: MonotonicClock = () => performance.now(),
    private readonly kind: SetupTraceKind = "provider",
  ) {
    this.startedAt = clock();
    if (!Number.isFinite(this.startedAt)) throw new Error("setup clock must be monotonic and finite");
    this.previousAt = this.startedAt;
  }

  end(phase: ExecutionSetupPhase): void {
    const index = phaseIndex(phase);
    if (index < 0) throw new Error(`unknown setup phase: ${String(phase)}`);
    if (this.records.some((record) => record.phase === phase)) throw new Error(`duplicate setup phase: ${phase}`);
    if (index < this.highestPhase) throw new Error(`out of order setup phase: ${phase}`);
    if (this.records.length >= MAX_SETUP_PHASE_RECORDS) throw new Error("setup phase record cap exceeded");

    const now = this.clock();
    const elapsedMs = boundedElapsed(now, this.previousAt);
    this.records.push({ phase, elapsedMs });
    this.highestPhase = index;
    this.previousAt = now;
  }

  finish(): ExecutionSetupTraceV1 {
    const totalNow = this.clock();
    boundedElapsed(totalNow, this.previousAt);
    const totalMs = boundedElapsed(totalNow, this.startedAt);
    return { version: 1, kind: this.kind, phases: this.records.map((record) => ({ ...record })), totalMs };
  }
}

export function createExecutionSetupRecorder(clock?: MonotonicClock, kind: SetupTraceKind = "provider"): ExecutionSetupRecorder {
  return new ExecutionSetupRecorder(clock, kind);
}
