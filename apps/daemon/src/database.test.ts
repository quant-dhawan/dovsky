/**
 * Uncached-token aggregates: `usage()`, `jobUsageSummary()` (behind `getJobSummary().usage`), and the
 * `routing.observation.v1` event `observeRouting()` emits. `uncached = input - cached`, clamped at 0, and is
 * computed only over attempts whose cache figure is known (measuredAttempts); a job with no measured attempt
 * reports `uncachedInputTokens: null` rather than silently falling back to the raw input total.
 *
 * `cached_input_tokens` was added after `input_tokens`/`output_tokens` (`ALTER TABLE attempts ADD COLUMN
 * cached_input_tokens INTEGER`, database.ts:355-357), so an attempt with input/output but a NULL cache figure is a
 * real, not synthetic, case: 40 of 191 attempts in the live DB measured 2026-09-01..09 have exactly this shape. It
 * is reproduced below with a direct SQL UPDATE (`finishAttempt` always writes all three columns together, so it
 * cannot produce this shape on its own).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DovskyDatabase } from "./database.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dovsky-database-"));
  const db = new DovskyDatabase(join(root, "state.db"));
  db.createRoom("room", "Usage", "test", "default");
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return db;
}

/** Queues a job through to 'running' so attempts can be attached to it, matching real job lifecycle order. */
function runningJob(db: DovskyDatabase, id: string): void {
  db.createJob({ id, roomId: "room", provider: "codex", projectId: "test", workflowId: "default", prompt: "fixture" }, `${id}-turn`);
  db.transitionJob(id, ["queued"], "starting", { startedAt: new Date().toISOString() });
  db.transitionJob(id, ["starting"], "running");
}

test("uncached tokens: measured, fully-uncached and NULL-cache attempts", async (t) => {
  const db = fixture(t);

  // job-mixed: one measured attempt (cached a real subset of input) and one attempt from before the cache column
  // existed (input/output present, cached_input_tokens NULL) -- the 40-of-191 shape.
  runningJob(db, "job-mixed");
  db.incrementAttempt("job-mixed", "job-mixed-a1", "job-mixed-turn", null, ["provider"]);
  db.finishAttempt("job-mixed-a1", "succeeded", null, true, { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50 });
  db.incrementAttempt("job-mixed", "job-mixed-a2", "job-mixed-turn", null, ["provider"]);
  db.finishAttempt("job-mixed-a2", "succeeded", null, true, { inputTokens: 500, cachedInputTokens: 0, outputTokens: 30 });
  db.db.prepare("UPDATE attempts SET cached_input_tokens=NULL WHERE id='job-mixed-a2'").run();

  // job-fully-uncached: one measured attempt whose cache figure is a real, known zero.
  runningJob(db, "job-fully-uncached");
  db.incrementAttempt("job-fully-uncached", "job-uncached-a1", "job-fully-uncached-turn", null, ["provider"]);
  db.finishAttempt("job-uncached-a1", "succeeded", null, true, { inputTokens: 300, cachedInputTokens: 0, outputTokens: 10 });

  // job-unmeasured: usage entirely unreported (import, or a failed provider stream).
  runningJob(db, "job-unmeasured");
  db.incrementAttempt("job-unmeasured", "job-unmeasured-a1", "job-unmeasured-turn", null, ["provider"]);
  db.finishAttempt("job-unmeasured-a1", "failed", null, false, null);

  // -- jobUsageSummary, read through getJobSummary().usage --------------------------------------------------------
  const mixed = db.getJobSummary("job-mixed").usage;
  assert.deepEqual(
    { attempts: mixed?.attempts, measuredAttempts: mixed?.measuredAttempts, unmeasuredAttempts: mixed?.unmeasuredAttempts, usageComplete: mixed?.usageComplete },
    { attempts: 2, measuredAttempts: 1, unmeasuredAttempts: 1, usageComplete: false },
  );
  assert.deepEqual(
    [mixed?.inputTokens, mixed?.cachedInputTokens, mixed?.uncachedInputTokens, mixed?.outputTokens],
    [1500, 200, 800, 80],
    "uncached is summed only over the measured attempt (1000-200=800), not the full 1500 input",
  );

  const fullyUncached = db.getJobSummary("job-fully-uncached").usage;
  assert.deepEqual(
    [fullyUncached?.inputTokens, fullyUncached?.cachedInputTokens, fullyUncached?.uncachedInputTokens],
    [300, 0, 300],
    "a real cached:0 still yields a known (not null) uncached figure equal to input",
  );

  const unmeasured = db.getJobSummary("job-unmeasured").usage;
  assert.deepEqual(
    [unmeasured?.measuredAttempts, unmeasured?.inputTokens, unmeasured?.cachedInputTokens, unmeasured?.uncachedInputTokens],
    [0, null, null, null],
    "no measured attempt means uncached is unknown, not 0 and not equal to input",
  );

  // -- usage(), across all three jobs -------------------------------------------------------------------------------
  const usage = db.usage();
  const byId = new Map(usage.jobs.map((job) => [job.jobId, job]));
  assert.equal(byId.get("job-mixed")?.uncachedInputTokens, 800);
  assert.equal(byId.get("job-fully-uncached")?.uncachedInputTokens, 300);
  assert.equal(byId.get("job-unmeasured")?.uncachedInputTokens, null);
  assert.deepEqual(
    {
      attempts: usage.totals.attempts,
      measuredAttempts: usage.totals.measuredAttempts,
      unmeasuredAttempts: usage.totals.unmeasuredAttempts,
      usageComplete: usage.totals.usageComplete,
    },
    { attempts: 4, measuredAttempts: 2, unmeasuredAttempts: 2, usageComplete: false },
  );
  assert.deepEqual(
    [usage.totals.inputTokens, usage.totals.cachedInputTokens, usage.totals.uncachedInputTokens, usage.totals.outputTokens],
    [1800, 200, 1100, 90],
    "the NULL-cache and fully-unmeasured attempts contribute 0 to the uncached total, never their full input",
  );

  // -- routing.observation.v1, emitted by observeRouting() on the terminal transition --------------------------------
  db.transitionJob("job-mixed", ["running"], "succeeded");
  db.transitionJob("job-unmeasured", ["running"], "failed");
  const events = db.listEvents("room", 0, 200).filter((e) => e.type === "routing.observation.v1");
  const mixedObservation = events.find((e) => e.jobId === "job-mixed")?.data as { inputTokens: number | null; uncachedInputTokens?: number | null };
  const unmeasuredObservation = events.find((e) => e.jobId === "job-unmeasured")?.data as {
    inputTokens: number | null;
    uncachedInputTokens?: number | null;
  };
  assert.deepEqual([mixedObservation?.inputTokens, mixedObservation?.uncachedInputTokens], [1500, 800]);
  assert.deepEqual([unmeasuredObservation?.inputTokens, unmeasuredObservation?.uncachedInputTokens], [null, null]);
});

test("uncached tokens: clamped at 0 when a measured attempt's cache figure exceeds its input figure", async (t) => {
  const db = fixture(t);

  // job-overcached: provider-reported noise, not a real negative token count -- cached_input_tokens (300) exceeds
  // input_tokens (100) on the one measured attempt. uncached must clamp to 0, not report -200, at every surface.
  runningJob(db, "job-overcached");
  db.incrementAttempt("job-overcached", "job-overcached-a1", "job-overcached-turn", null, ["provider"]);
  db.finishAttempt("job-overcached-a1", "succeeded", null, true, { inputTokens: 100, cachedInputTokens: 300, outputTokens: 20 });

  const summary = db.getJobSummary("job-overcached").usage;
  assert.equal(summary?.uncachedInputTokens, 0, "jobUsageSummary must clamp, not report -200");

  const usage = db.usage();
  const job = usage.jobs.find((j) => j.jobId === "job-overcached");
  assert.equal(job?.uncachedInputTokens, 0, "usage() must clamp, not report -200");
  assert.equal(usage.totals.uncachedInputTokens, 0, "usage() totals must clamp, not go negative");

  db.transitionJob("job-overcached", ["running"], "succeeded");
  const events = db.listEvents("room", 0, 200).filter((e) => e.type === "routing.observation.v1");
  const observation = events.find((e) => e.jobId === "job-overcached")?.data as { uncachedInputTokens?: number | null };
  assert.equal(observation?.uncachedInputTokens, 0, "observeRouting's event must clamp, not report -200");
});

test("the queue keeps arrival order when two jobs are created in the same millisecond", async (t) => {
  const db = fixture(t);
  // The scheduler dispatches in queuedJobs() order. created_at has millisecond resolution and a job id is a random
  // UUID, so the job created second can carry the smaller id; it must still be queued, and dispatched, second.
  const createdAt = "2026-09-11T16:44:31.988Z";
  const arrival = ["ffffffff-created-first", "00000000-created-second"];
  for (const id of arrival) {
    db.createJob({ id, roomId: "room", provider: "codex", projectId: "test", workflowId: "default", prompt: "fixture", createdAt }, `${id}-turn`);
  }
  assert.deepEqual(db.queuedJobs(10).map((job) => job.id), arrival);
  const firstPage = db.queuedJobs(1);
  assert.deepEqual([...firstPage, ...db.queuedJobs(1, firstPage[0]!)].map((job) => job.id), arrival, "the page cursor follows the same order");
});
