#!/usr/bin/env node
// Opt-in subscription-backed smoke; never runs in npm test. No product release actions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DovskyDaemon } from "../apps/daemon/dist/index.js";

if (process.argv[2] !== "--run-claude") throw new Error("Explicit --run-claude is required; this consumes the logged-in Claude subscription");
const root = mkdtempSync(resolve(tmpdir(), "dovsky-real-provider-smoke-"));
const project = resolve(root, "project");
mkdirSync(project);
execFileSync("git", ["init", "-q", project]);
execFileSync("git", ["-C", project, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "--allow-empty", "-qm", "Disposable smoke baseline"]);
const daemon = new DovskyDaemon({
  socketPath: resolve(root, "bus.sock"), databasePath: resolve(root, "state/bus.db"), artifactDirectory: resolve(root, "artifacts"),
  maxActive: 1,
  projects: [{ id: "smoke", name: "Disposable coordination smoke", path: project, workflows: [{
    id: "review", name: "No tools or edits", readOnly: true, qualityCommands: [],
    providers: { claude: { argv: ["claude", "-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "manual", "--tools", ""] } },
  }] }],
});
const call = (method, params = {}) => daemon.call(method, params, randomUUID());
async function wait(id) {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const job = await call("jobs.get", { jobId: id });
    if (["succeeded", "failed", "cancelled"].includes(job.state)) return job;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("Real-provider smoke exceeded two minutes for an execution");
}
try {
  daemon.start();
  const created = await call("rooms.create", {
    title: "Real-provider coordination smoke", projectId: "smoke", workflowId: "review", recipients: ["claude"], model: "fable", effort: "low",
    prompt: 'This is a coordination-protocol smoke test only. Do not use tools, edit files, or perform external actions. We intentionally need an operator decision before the task completes. Return a brief waiting message and exactly this standalone final line: DOVSKY_RESULT: {"outcome":"awaiting_decision","phase":"Smoke decision","blocker":"Operator decision pending","nextAction":"Record a smoke decision and resume","acknowledgedControls":[]}. On a subsequent resumed turn, the operator control may authorize completion of this smoke task only.',
  });
  const first = await wait(created.jobIds[0]);
  assert.equal(first.state, "succeeded", first.failure?.summary);
  assert.equal(first.task.state, "awaiting_decision");
  const thread = daemon.database.getJob(first.id).threadId;
  assert.ok(thread, "The real provider must report a resumable thread");
  console.log("PASS real Fable: awaiting decision, not falsely completed");
  const control = await call("tasks.controls.create", { taskId: first.taskId, kind: "decision", body: "Complete this synthetic coordination task now. No tools, edits, tests, deployments, or other external actions are authorized. Acknowledge this control ID in the final DOVSKY_RESULT and set outcome completed." });
  assert.equal(control.deliveredAt, null);
  assert.equal(daemon.database.countQueued(), 0);
  const resumed = await call("tasks.resume", { taskId: first.taskId });
  const second = await wait(resumed.jobId);
  assert.equal(second.state, "succeeded", second.failure?.summary);
  assert.equal(second.task.state, "completed");
  assert.equal(second.taskId, first.taskId);
  assert.equal(daemon.database.getJob(second.id).resumeThreadId, thread);
  assert.ok(daemon.coordination.get(first.taskId).controls[0].acknowledgedAt);
  console.log("PASS real Fable: same-thread resume, control delivered and explicitly acknowledged");
  console.log("No product changes, human acceptance records, or release operations were performed.");
} finally {
  await daemon.stop(); daemon.close();
  rmSync(root, { recursive: true, force: true });
}
