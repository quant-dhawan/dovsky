import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionSetupRecorder,
  MAX_SETUP_PHASE_RECORDS,
  SETUP_PHASES,
} from "./performance-context.js";

function clock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

test("records deterministic ordered setup phase durations and total", () => {
  const recorder = new ExecutionSetupRecorder(clock([10, 14, 21, 30, 42, 55]), "bench");

  recorder.end("sandbox_availability");
  recorder.end("baseline_capture");
  recorder.end("dependency_materialization");
  recorder.end("dependency_plan");
  recorder.end("isolation_prepare");

  assert.deepEqual(recorder.finish(), {
    version: 1,
    kind: "bench",
    phases: [
      { phase: "sandbox_availability", elapsedMs: 4 },
      { phase: "baseline_capture", elapsedMs: 7 },
      { phase: "dependency_materialization", elapsedMs: 9 },
      { phase: "dependency_plan", elapsedMs: 12 },
      { phase: "isolation_prepare", elapsedMs: 13 },
    ],
    totalMs: 45,
  });
});

test("rejects unknown, duplicate, and out-of-order phases without mutating", () => {
  const recorder = new ExecutionSetupRecorder(clock([0, 2, 3, 4, 5]), "provider");

  assert.throws(() => recorder.end("not-a-phase" as never), /unknown setup phase/);
  recorder.end("sandbox_availability");
  assert.throws(() => recorder.end("sandbox_availability"), /duplicate/);
  recorder.end("dependency_plan");
  assert.throws(() => recorder.end("baseline_capture"), /out of order/);
  assert.equal(recorder.finish().phases.length, 2);
});

test("allows omitted phases while preserving canonical order", () => {
  const recorder = new ExecutionSetupRecorder(clock([5, 8, 13]), "gate");
  recorder.end("sandbox_availability");
  recorder.end("isolation_prepare");
  assert.deepEqual(recorder.finish().phases, [
    { phase: "sandbox_availability", elapsedMs: 3 },
    { phase: "isolation_prepare", elapsedMs: 5 },
  ]);
});

test("rejects backwards clocks and caps phase records", () => {
  const recorder = new ExecutionSetupRecorder(clock([10, 9]), "proof");
  assert.throws(() => recorder.end("sandbox_availability"), /monotonic/);

  const capped = new ExecutionSetupRecorder(() => 1, "provider");
  for (const phase of SETUP_PHASES) capped.end(phase);
  assert.equal(MAX_SETUP_PHASE_RECORDS, SETUP_PHASES.length);
  assert.throws(() => capped.end("sandbox_availability"), /duplicate/);
});

test("rejects a clock that rolls back after the last phase", () => {
  const recorder = new ExecutionSetupRecorder(clock([10, 20, 15]), "provider");
  recorder.end("sandbox_availability");
  assert.throws(() => recorder.finish(), /monotonic/);
});

test("trace has no execution-context fields", () => {
  const recorder = new ExecutionSetupRecorder(clock([0, 1]), "provider");
  recorder.end("sandbox_availability");
  const trace = recorder.finish();
  assert.deepEqual(Object.keys(trace).sort(), ["kind", "phases", "totalMs", "version"]);
  assert.deepEqual(Object.keys(trace.phases[0]!).sort(), ["elapsedMs", "phase"]);
});
