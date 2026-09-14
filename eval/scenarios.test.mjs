import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const target = resolve(import.meta.dirname, "..");
const expected = ["dispatch-result", "thread-resume", "cancellation", "gate-failure", "review-correction",
  "restart-recovery", "control-delivery-ack", "checkpoint-resume-gates", "coordination-drain-restart"];

test("scripted evaluation runs every required scenario successfully", { timeout: 180_000 }, async () => {
  const { stdout } = await execute(process.execPath, [resolve(target, "eval/scenarios.mjs"), target],
    { cwd: target, timeout: 150_000, maxBuffer: 2 * 1024 * 1024 });
  const report = JSON.parse(stdout);
  assert.equal(report.version, 1);
  assert.deepEqual(report.scenarios.map((scenario) => scenario.id), expected);
  for (const scenario of report.scenarios) assert.equal(scenario.passed, true, `${scenario.id}: ${scenario.detail}`);
});
