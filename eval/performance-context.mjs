#!/usr/bin/env node
// Read-only benchmark for the bounded source outline response.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { outlineResult } from "../apps/cli/src/commands/explore.mjs";

export const BASE_COMMIT = "7a47bedee4f8ffec48c665d933f103d6f8a5c998";
export const ROUNDS = 20;
export const THRESHOLDS = Object.freeze({ medianPayloadReduction: 70, warmP95Ms: 100 });
export const FIXTURES = Object.freeze([
  "apps/daemon/src/daemon.ts",
  "apps/daemon/src/database.ts",
  "apps/daemon/src/releases.ts",
  "apps/daemon/src/sandbox.ts",
  "apps/daemon/src/github.ts",
]);

/** Linear-interpolated quantile; the input is never modified. */
export function quantile(values, probability) {
  if (!Array.isArray(values) || values.length === 0) throw new RangeError("quantile requires samples");
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new RangeError("quantile probability must be between 0 and 1");
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.some((value) => !Number.isFinite(value))) throw new TypeError("quantile samples must be finite");
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function median(values) {
  return quantile(values, 0.5);
}

export function reductionPercent(sourceBytes, outlineBytes) {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes <= 0) throw new RangeError("sourceBytes must be positive");
  if (!Number.isSafeInteger(outlineBytes) || outlineBytes < 0) throw new RangeError("outlineBytes must be non-negative");
  return ((sourceBytes - outlineBytes) / sourceBytes) * 100;
}

function problemCode(problem) {
  return typeof problem === "string" ? problem : problem?.code;
}

function isFailure(file) {
  return Boolean(file.failure) || (Array.isArray(file.problems)
    && file.problems.some((problem) => ["parse_error", "deadline", "throw"].includes(problemCode(problem))));
}

/** Evaluate the production gate against already-collected synthetic or real records. */
export function evaluateGate(files) {
  const records = Array.isArray(files) ? files : [];
  const reductions = records.map((file) => file.reduction).filter((value) => Number.isFinite(value));
  const durations = records.flatMap((file) => Array.isArray(file.durationsMs) ? file.durationsMs : []);
  const medianPayloadReduction = reductions.length ? median(reductions) : 0;
  const warmP95Ms = durations.length ? quantile(durations, 0.95) : Number.POSITIVE_INFINITY;
  const failureCount = records.filter(isFailure).length;
  const passed = failureCount === 0
    && medianPayloadReduction >= THRESHOLDS.medianPayloadReduction
    && warmP95Ms <= THRESHOLDS.warmP95Ms;
  return { medianPayloadReduction, warmP95Ms, failureCount, passed };
}

function compactBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fixtureRecord(relativePath, root) {
  return {
    path: relativePath,
    sourceBytes: Buffer.byteLength(readFileSync(path.resolve(root, relativePath)), "utf8"),
    durationsMs: [],
    outlineBytes: null,
    reduction: null,
    declarations: 0,
    problems: [],
    truncated: false,
    failure: false,
    identityChanged: false,
  };
}

async function warmParserPaths(root, outline) {
  const warmed = new Set();
  const warmup = [];
  for (const relativePath of FIXTURES) {
    const parserPath = path.extname(relativePath).toLowerCase();
    if (warmed.has(parserPath)) continue;
    warmed.add(parserPath);
    try {
      const result = await outline(relativePath, { cwd: root });
      warmup.push({ parserPath, file: relativePath, problems: result.problems.map(problemCode).filter(Boolean) });
    } catch (error) {
      warmup.push({ parserPath, file: relativePath, problems: ["throw"], error: String(error).slice(0, 400) });
    }
  }
  return warmup;
}

export async function runBenchmark({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), outline = outlineResult } = {}) {
  const warmup = await warmParserPaths(root, outline);
  const files = [];
  for (const relativePath of FIXTURES) {
    const record = fixtureRecord(relativePath, root);
    let representative;
    let representativeCompact;
    let representativeContentHash;
    const observedProblems = new Set();
    for (let round = 0; round < ROUNDS; round += 1) {
      const started = performance.now();
      try {
        const result = await outline(relativePath, { cwd: root });
        const compact = JSON.stringify(result);
        const problems = Array.isArray(result?.problems) ? result.problems.map(problemCode).filter(Boolean) : [];
        for (const code of problems) observedProblems.add(code);
        if (!representative) {
          representative = result;
          representativeCompact = compact;
          representativeContentHash = result.contentHash;
        } else if (compact !== representativeCompact || result.contentHash !== representativeContentHash) {
          record.identityChanged = true;
          record.failure = true;
        }
        if (problems.some((code) => ["parse_error", "deadline"].includes(code))) record.failure = true;
      } catch (error) {
        record.failure = true;
        observedProblems.add("throw");
        record.error = String(error).slice(0, 400);
      } finally {
        record.durationsMs.push(performance.now() - started);
      }
    }
    if (representative) {
      record.outlineBytes = compactBytes(representative);
      record.reduction = reductionPercent(record.sourceBytes, record.outlineBytes);
      record.declarations = representative.declarations.length;
      record.problems = [...observedProblems];
      record.truncated = representative.truncated;
    } else {
      record.problems = [...observedProblems];
    }
    files.push(record);
  }

  const gate = evaluateGate(files);
  const warmupFailures = warmup.filter((entry) => entry.problems.some((code) => ["parse_error", "deadline", "throw"].includes(code))).length;
  const report = {
    version: 1,
    benchmark: "outline",
    baseCommit: BASE_COMMIT,
    roundsPerFile: ROUNDS,
    warmup,
    files,
    aggregate: { ...gate, failureCount: gate.failureCount + warmupFailures, thresholds: THRESHOLDS },
    failureCount: gate.failureCount + warmupFailures,
    process: {
      maxRSSKiB: process.resourceUsage().maxRSS,
      maxRSSUnit: "KiB (Linux)",
      scratchHighWaterBytes: 0,
    },
  };
  report.aggregate.passed = report.aggregate.failureCount === 0
    && report.aggregate.medianPayloadReduction >= THRESHOLDS.medianPayloadReduction
    && report.aggregate.warmP95Ms <= THRESHOLDS.warmP95Ms;
  report.passed = report.aggregate.passed;
  return report;
}

async function main() {
  const report = await runBenchmark();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ version: 1, benchmark: "outline", baseCommit: BASE_COMMIT, passed: false, aggregate: { failureCount: 1 }, error: String(error).slice(0, 400) })}\n`);
    process.exitCode = 1;
  }
}
