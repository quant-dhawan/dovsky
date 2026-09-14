import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { FixtureDaemon as DovskyDaemon, removeFixtureTree } from './__fixtures__/runtime-isolation.js';

const providerFixture = new URL("./__fixtures__/provider.js", import.meta.url).pathname;
type Outcome = "completed" | "checkpointed";
type ReviewerCase = "queued cancellation" | "running cancellation" | "invalid verdict" | "setup failure";

function fixture(context: TestContext, outcome: Outcome, reviewerCase: ReviewerCase) {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-reviewer-coordination-"));
  const workdir = resolve(root, "project");
  mkdirSync(workdir);
  execFileSync("git", ["init", "-q", workdir]);
  writeFileSync(resolve(workdir, "tracked.txt"), "Fixture baseline\n");
  execFileSync("git", ["-C", workdir, "add", "tracked.txt"]);
  execFileSync("git", ["-C", workdir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline"]);
  const head = execFileSync("git", ["-C", workdir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const daemon = new DovskyDaemon({
    socketPath: resolve(root, "run", "bus.sock"), databasePath: resolve(root, "state", "bus.db"),
    artifactDirectory: resolve(root, "artifacts"),
    maxActive: 1,
    projects: [{ id: "fixture", name: "Fixture", path: workdir, workflows: [{
      id: "change", name: "Change fixture", readOnly: false, qualityCommands: [],
      providers: { codex: { argv: [process.execPath, providerFixture, "verdict",
        reviewerCase === "running cancellation" ? "SLEEP:10000\\nVERDICT: APPROVED" : "Missing verdict sentinel"] } },
    }] }],
  });
  context.after(async () => { await daemon.stop(); daemon.close(); removeFixtureTree(root); });
  daemon.database.createRoom("room", "Reviewer lifecycle fixture", "fixture", "change");
  // Seed an ended worker to isolate reviewer lifecycle effects; this is not evaluation or human acceptance.
  daemon.database.createJob({ id: "worker", roomId: "room", projectId: "fixture", workflowId: "change", provider: "codex", prompt: "Fixture work" }, randomUUID());
  daemon.database.transitionJob("worker", ["queued"], "starting");
  daemon.database.transitionJob("worker", ["starting"], "running");
  daemon.coordination.claim("worker", workdir, true);
  daemon.coordination.setState("worker", { outcome, phase: "Worker outcome", blocker: null, nextAction: outcome === "checkpointed" ? "Resume work" : null, acknowledgedControls: [] });
  daemon.database.transitionJob("worker", ["running"], "succeeded", { result: "Fixture work ended" });
  daemon.database.completeTurn("worker", "complete");
  daemon.database.createJob({ id: "reviewer", roomId: "room", projectId: "fixture", workflowId: "change", provider: "codex",
    role: "review", reviewOf: "worker", reviewRound: 0, reviewCommit: reviewerCase === "setup failure" ? null : head,
    evidenceComplete: true, prompt: "Review the fixture" }, randomUUID());
  return { daemon, workdir };
}

async function waitForState(daemon: DovskyDaemon, state: "running" | "failed" | "cancelled") {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = daemon.database.getJob("reviewer")!;
    if (job.state === state) return job;
    if (["failed", "cancelled", "succeeded"].includes(job.state)) assert.fail(`Reviewer reached ${job.state} instead of ${state}: ${job.failure?.summary}`);
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(`Reviewer did not reach ${state}`);
}

for (const outcome of ["completed", "checkpointed"] as const) {
  for (const reviewerCase of ["queued cancellation", "running cancellation", "invalid verdict", "setup failure"] as const) {
    test(`reviewer ${reviewerCase} preserves ${outcome} work and its ownership`, async (context) => {
      const { daemon, workdir } = fixture(context, outcome, reviewerCase);
      if (reviewerCase === "queued cancellation") {
        await daemon.call("jobs.cancel", { jobId: "reviewer" }, randomUUID());
        assert.equal(daemon.database.getJob("reviewer")!.state, "cancelled");
      } else {
        daemon.start();
        if (reviewerCase === "running cancellation") {
          await waitForState(daemon, "running");
          await daemon.call("jobs.cancel", { jobId: "reviewer" }, randomUUID());
          await waitForState(daemon, "cancelled");
        } else {
          const reviewer = await waitForState(daemon, "failed");
          assert.equal(reviewer.failure?.code, "review_protocol", reviewer.failure?.summary);
        }
      }
      const task = daemon.coordination.get("worker").task;
      assert.equal(task.state, outcome);
      assert.equal(task.phase, "Worker outcome");
      assert.equal(task.latestJobId, "worker");
      assert.equal(daemon.database.getJob("worker")!.state, "succeeded");
      const owner = daemon.database.db.prepare("SELECT task_id FROM task_ownership WHERE workdir=?").get(workdir);
      assert.equal(owner?.task_id ?? null, outcome === "checkpointed" ? "worker" : null);
    });
  }
}
