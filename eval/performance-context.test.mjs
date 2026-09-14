import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURES, median, evaluateGate, quantile, runBenchmark, THRESHOLDS, ROUNDS } from "./performance-context.mjs";

test("median and quantile use interpolation without mutating samples", () => {
  const values = [9, 1, 5, 3];
  assert.equal(median(values), 4);
  assert.ok(Math.abs(quantile(values, 0.95) - 8.4) < 1e-12);
  assert.deepEqual(values, [9, 1, 5, 3]);
});

test("gate passes synthetic records at exact thresholds and ignores truncation", () => {
  const result = evaluateGate([
    { reduction: 70, durationsMs: [1, 2, 3], problems: ["truncated"], truncated: true },
    { reduction: 80, durationsMs: [4, 5, 6], problems: [], truncated: false },
  ]);
  assert.equal(result.medianPayloadReduction, 75);
  assert.equal(result.warmP95Ms, 5.75);
  assert.equal(result.failureCount, 0);
  assert.equal(result.passed, true);
  assert.deepEqual(THRESHOLDS, { medianPayloadReduction: 70, warmP95Ms: 100 });
});

test("gate rejects parse errors, deadlines, throws, and threshold misses", () => {
  assert.equal(evaluateGate([{ reduction: 90, durationsMs: [1, 2], problems: ["parse_error"] }]).passed, false);
  assert.equal(evaluateGate([{ reduction: 90, durationsMs: [1, 2], problems: ["deadline"] }]).passed, false);
  assert.equal(evaluateGate([{ reduction: 90, durationsMs: [1, 2], problems: ["throw"] }]).passed, false);
  assert.equal(evaluateGate([{ reduction: 69.99, durationsMs: [1, 2], problems: [] }]).passed, false);
  assert.equal(evaluateGate([{ reduction: 90, durationsMs: [1, 201], problems: [] }]).passed, false);
});

test("measured rounds union later failures and detect response identity drift", async () => {
  const calls = new Map();
  const outline = async (relativePath) => {
    const count = (calls.get(relativePath) ?? 0) + 1;
    calls.set(relativePath, count);
    const contentHash = relativePath.endsWith("database.ts") && count === 3 ? "drifted" : relativePath;
    const problems = relativePath.endsWith("daemon.ts") && count === 3
      ? [{ code: "parse_error" }]
      : relativePath.endsWith("releases.ts") && count === 3 ? [{ code: "deadline" }] : [];
    if (relativePath.endsWith("sandbox.ts") && count === 3) throw new Error("fixture throw");
    return {
      version: 1,
      path: relativePath,
      contentHash,
      language: "typescript",
      parserVersion: "fixture-parser",
      declarations: [],
      truncated: false,
      problems,
    };
  };
  const report = await runBenchmark({ outline });
  const daemon = report.files.find((file) => file.path.endsWith("daemon.ts"));
  const database = report.files.find((file) => file.path.endsWith("database.ts"));
  const releases = report.files.find((file) => file.path.endsWith("releases.ts"));
  const sandbox = report.files.find((file) => file.path.endsWith("sandbox.ts"));
  assert.deepEqual(daemon.problems, ["parse_error"]);
  assert.equal(daemon.failure, true);
  assert.equal(database.identityChanged, true);
  assert.equal(database.failure, true);
  assert.deepEqual(releases.problems, ["deadline"]);
  assert.deepEqual(sandbox.problems, ["throw"]);
  assert.equal(report.failureCount, 4);
  assert.equal(report.passed, false);
  assert.equal(calls.get(FIXTURES[0]), ROUNDS + 1, "one warmup plus measured rounds");
  assert.equal(calls.get(FIXTURES[1]), ROUNDS, "other parser-equivalent fixtures are measured only");
});

test("CLI report emits the complete benchmark JSON shape", async () => {
  const report = JSON.parse(JSON.stringify(await runBenchmark()));
  assert.equal(report.version, 1);
  assert.equal(report.benchmark, "outline");
  assert.equal(report.files.length, 5);
  assert.equal(report.roundsPerFile, ROUNDS);
  assert.equal(report.files.every((file) => Number.isInteger(file.sourceBytes) && file.sourceBytes > 0), true);
  assert.equal(report.files.every((file) => Number.isInteger(file.outlineBytes) && typeof file.reduction === "number"), true);
  assert.equal(report.files.every((file) => file.durationsMs.length >= 20), true);
  assert.equal(typeof report.aggregate.medianPayloadReduction, "number");
  assert.equal(typeof report.aggregate.warmP95Ms, "number");
  assert.equal(typeof report.aggregate.failureCount, "number");
  assert.equal(report.process.maxRSSUnit, "KiB (Linux)");
  assert.equal(typeof report.process.maxRSSKiB, "number");
  assert.equal(report.process.scratchHighWaterBytes, 0);
});
