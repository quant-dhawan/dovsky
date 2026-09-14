import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";

import type { JobSummary } from "@dovsky/protocol";
import type { DaemonConfig } from "./config.js";
import { treeFingerprint } from './daemon.js';
import { FixtureDaemon as DovskyDaemon, removeFixtureTree } from './__fixtures__/runtime-isolation.js';

const providerFixture = new URL("./__fixtures__/provider.js", import.meta.url).pathname;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function harness(context: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-rebind-"));
  const project = resolve(root, "project");
  mkdirSync(project);
  git(project, "init", "-q");
  git(project, "config", "user.email", "test@example.invalid");
  git(project, "config", "user.name", "Dovsky Test");
  writeFileSync(resolve(project, "tracked.txt"), "baseline\n");
  git(project, "add", "tracked.txt");
  git(project, "commit", "-qm", "baseline");
  const config: DaemonConfig = {
    socketPath: resolve(root, "run", "dovsky.sock"),
    databasePath: resolve(root, "state", "dovsky.db"),
    artifactDirectory: resolve(root, "artifacts"),
    maxActive: 1,
    projects: [{
      id: "project", name: "Project", path: project, workflows: [{
        id: "change", name: "Change", readOnly: false, qualityCommands: [],
        providers: { codex: { argv: [process.execPath, providerFixture, "task-edit-checkpoint"] } },
      }],
    }],
  };
  const daemon = new DovskyDaemon(config);
  context.after(async () => {
    await daemon.stop();
    daemon.close();
    removeFixtureTree(root);
  });
  return { root, project, config, daemon };
}

async function waitForJob(daemon: DovskyDaemon, jobId: string, states: string[]): Promise<JobSummary> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = daemon.database.getJobSummary(jobId);
    if (states.includes(job.state)) return job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Timed out waiting for ${jobId}`);
}

async function checkpoint(value: ReturnType<typeof harness>, protect = false): Promise<JobSummary> {
  const created = await value.daemon.call("rooms.create", {
    title: "Rebind", projectId: "project", workflowId: "change", prompt: "Change then checkpoint",
    recipients: ["codex"], ...(protect ? { protect: "tracked.txt" } : {}),
  }, randomUUID()) as { jobIds: string[] };
  value.daemon.start();
  const job = await waitForJob(value.daemon, created.jobIds[0]!, ["succeeded"]);
  assert.equal(job.task?.state, "checkpointed");
  return job;
}

function worktree(project: string, path: string): void {
  git(project, "worktree", "add", "-q", "--detach", path, "HEAD");
}

test("checkpoint rebind evaluates existing target dirt against the original task baseline", async (context) => {
  const value = harness(context);
  const first = await checkpoint(value, true);
  const target = resolve(value.root, "alternate");
  worktree(value.project, target);
  writeFileSync(resolve(target, "tracked.txt"), "alternate dirty content\n");
  const expectedFingerprint = treeFingerprint(target)!;
  value.daemon.database.setThreadId(first.id, "old-worktree-thread");
  value.config.projects[0]!.workflows[0]!.providers.codex!.argv = [process.execPath, providerFixture, "task-complete"];
  await value.daemon.call("daemon.drain", { enabled: true }, randomUUID());

  const resumed = await value.daemon.call("tasks.resume", {
    taskId: first.taskId, cwd: target, expectedFingerprint,
  }, randomUUID()) as { jobId: string };
  const queued = value.daemon.database.getJob(resumed.jobId)!;
  assert.equal(queued.cwd, target);
  assert.equal(queued.parentFingerprint, expectedFingerprint);
  assert.equal(queued.resumeThreadId, null);
  assert.match(queued.prompt, /Change then checkpoint/);
  assert.match(queued.prompt, /Paused after edit/);
  assert.equal(value.daemon.database.db.prepare("SELECT task_id FROM task_ownership WHERE workdir=?").get(target)!.task_id, first.taskId);
  await value.daemon.call("daemon.drain", { enabled: false }, randomUUID());
  const finished = await waitForJob(value.daemon, resumed.jobId, ["failed"]);
  assert.match(finished.failure?.summary ?? "", /protected/i);
  assert.equal(finished.task?.workdir, target);
});

test("rebind rejects stale, foreign, owned and unsettled-release targets and rolls back a failed enqueue", async (context) => {
  const value = harness(context);
  const first = await checkpoint(value);
  const taskId = first.taskId!;
  const target = resolve(value.root, "alternate");
  worktree(value.project, target);
  const fingerprint = treeFingerprint(target)!;
  const original = value.daemon.coordination.getTask(taskId).workdir!;

  await assert.rejects(value.daemon.call("tasks.resume", { taskId, cwd: target, expectedFingerprint: "0".repeat(64) }, randomUUID()), /fingerprint/i);
  assert.equal(value.daemon.coordination.getTask(taskId).workdir, original);

  const foreign = resolve(value.root, "foreign");
  mkdirSync(foreign);
  git(foreign, "init", "-q");
  git(foreign, "config", "user.email", "test@example.invalid");
  git(foreign, "config", "user.name", "Dovsky Test");
  writeFileSync(resolve(foreign, "other.txt"), "foreign\n");
  git(foreign, "add", "other.txt");
  git(foreign, "commit", "-qm", "foreign");
  await assert.rejects(value.daemon.call("tasks.resume", { taskId, cwd: foreign, expectedFingerprint: treeFingerprint(foreign) }, randomUUID()), /worktree of project/i);

  value.daemon.database.createJob({ id: "other-task", roomId: first.roomId, provider: "codex", projectId: "project", workflowId: "change", prompt: "other", cwd: target }, randomUUID());
  value.daemon.coordination.claim("other-task", target, true);
  await assert.rejects(value.daemon.call("tasks.resume", { taskId, cwd: target, expectedFingerprint: fingerprint }, randomUUID()), /owned by another task/i);
  value.daemon.coordination.setState("other-task", { outcome: "completed", phase: "Done", blocker: null, nextAction: null, acknowledgedControls: [] });

  value.daemon.database.db.prepare("INSERT INTO release_operations(id,task_id,room_id,semantic_key,state,data_json) VALUES('release',?,?,?,'reconcile_required','{}')")
    .run(taskId, first.roomId, "rebind-release");
  await assert.rejects(value.daemon.call("tasks.resume", { taskId, cwd: target, expectedFingerprint: fingerprint }, randomUUID()), /uncertain release operation/i);
  value.daemon.database.db.prepare("DELETE FROM release_operations WHERE id='release'").run();

  const createJob = value.daemon.database.createJob;
  value.daemon.database.createJob = (() => { throw new Error("synthetic enqueue failure"); }) as typeof value.daemon.database.createJob;
  try {
    await assert.rejects(value.daemon.call("tasks.resume", { taskId, cwd: target, expectedFingerprint: fingerprint }, randomUUID()), /synthetic enqueue failure/);
  } finally {
    value.daemon.database.createJob = createJob;
  }
  assert.equal(value.daemon.coordination.getTask(taskId).workdir, original);
  assert.equal(value.daemon.database.db.prepare("SELECT task_id FROM task_ownership WHERE workdir=?").get(original)!.task_id, taskId);
  assert.equal(value.daemon.database.db.prepare("SELECT 1 FROM task_ownership WHERE workdir=?").get(target), undefined);
});

test("rebind freezes the target fingerprint and refuses dispatch after a later edit", async (context) => {
  const value = harness(context);
  const first = await checkpoint(value);
  const target = resolve(value.root, "alternate");
  worktree(value.project, target);
  const expectedFingerprint = treeFingerprint(target)!;
  await value.daemon.call("daemon.drain", { enabled: true }, randomUUID());
  value.config.projects[0]!.workflows[0]!.providers.codex!.argv = [process.execPath, providerFixture, "task-complete"];
  const resumed = await value.daemon.call("tasks.resume", {
    taskId: first.taskId, cwd: target, expectedFingerprint,
  }, randomUUID()) as { jobId: string };
  assert.equal(value.daemon.database.getJob(resumed.jobId)?.state, "queued");
  writeFileSync(resolve(target, "tracked.txt"), "changed after enqueue\n");
  await value.daemon.call("daemon.drain", { enabled: false }, randomUUID());
  const failed = await waitForJob(value.daemon, resumed.jobId, ["failed"]);
  assert.equal(failed.failure?.code, "review_stale");
  assert.equal(failed.currentAttempt, 0);
});

test("explicit verification of the existing worktree retains the provider session", async (context) => {
  const value = harness(context);
  const first = await checkpoint(value);
  value.daemon.database.setThreadId(first.id, "same-worktree-thread");
  await value.daemon.call("daemon.drain", { enabled: true }, randomUUID());
  const resumed = await value.daemon.call("tasks.resume", {
    taskId: first.taskId,
    cwd: value.project,
    expectedFingerprint: treeFingerprint(value.project),
  }, randomUUID()) as { jobId: string };
  const queued = value.daemon.database.getJob(resumed.jobId)!;
  assert.equal(queued.resumeThreadId, "same-worktree-thread");
  assert.equal(queued.cwd, null);
});
