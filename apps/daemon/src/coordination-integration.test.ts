import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { FixtureDaemon as DovskyDaemon, removeFixtureTree } from './__fixtures__/runtime-isolation.js';
import type { DaemonConfig } from "./config.js";

function fixture(context: TestContext): DovskyDaemon {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-coordination-integration-"));
  const project = resolve(root, 'project');
  mkdirSync(project);
  execFileSync('git', ['init', '-q', project]);
  writeFileSync(resolve(project, 'baseline'), 'fixture');
  execFileSync('git', ['-C', project, 'add', 'baseline']);
  execFileSync('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']);
  const daemon = new DovskyDaemon({
    socketPath: resolve(root, "run", "bus.sock"), databasePath: resolve(root, "state", "bus.db"),
    artifactDirectory: resolve(root, "artifacts"),
    maxActive: 1,
    projects: [{ id: "project", name: "Fixture", path: project, workflows: [{
      id: "change", name: "Change", readOnly: false, qualityCommands: [],
      providers: { codex: { argv: [process.execPath] } },
    }] }],
  });
  context.after(async () => { await daemon.stop(); daemon.close(); removeFixtureTree(root); });
  daemon.database.createRoom("room", "Fixture", "project", "change");
  return daemon;
}

function job(daemon: DovskyDaemon, id: string, predecessorJobId?: string, predecessorPending = false): void {
  daemon.database.createJob({ id, roomId: "room", projectId: "project", workflowId: "change", provider: "codex", prompt: "Fixture only", ...(predecessorJobId ? { predecessorJobId, predecessorPending } : {}) }, randomUUID());
}

test("reading daemon drain needs no mutation key and never changes admission", async (context) => {
  const daemon = fixture(context);
  assert.deepEqual(await daemon.call("daemon.drain", {}), { draining: false, activeJobs: 0, queuedJobs: 0 });
  await daemon.call("daemon.drain", { enabled: true }, randomUUID());
  assert.deepEqual(await daemon.call("daemon.drain", {}), { draining: true, activeJobs: 0, queuedJobs: 0 });
});

test("legacy job cancellation cannot leave its only logical task working indefinitely", async (context) => {
  const daemon = fixture(context);
  job(daemon, "first");
  await daemon.call("jobs.cancel", { jobId: "first" }, randomUUID());
  assert.equal(daemon.database.getJob("first")?.state, "cancelled");
  assert.equal(daemon.coordination.get("first").task.state, "cancelled");
});

test("restart notices interrupted predecessors even when latest task job is queued", async (context) => {
  const daemon = fixture(context);
  job(daemon, "first");
  daemon.database.transitionJob("first", ["queued"], "starting");
  daemon.coordination.claim("first", daemon.config.projects[0]!.path, true);
  daemon.database.transitionJob("first", ["starting"], "running");
  job(daemon, "continuation", "first");
  await daemon.call("daemon.drain", { enabled: true }, randomUUID());
  daemon.start();
  assert.equal(daemon.database.getJob("first")?.state, "failed");
  assert.equal(daemon.coordination.get("first").task.state, "unknown");
  assert.equal(daemon.database.getJob("continuation")?.state, "cancelled");
  assert.equal(daemon.database.db.prepare("SELECT task_id FROM task_ownership").get()!.task_id, "first");
});

test("queueing a continuation replaces the prior blocked WIP state", (context) => {
  const daemon = fixture(context);
  job(daemon, "first");
  daemon.coordination.setState("first", { outcome: "blocked", phase: "Need a decision", blocker: "Awaiting input", nextAction: "Resume after input", acknowledgedControls: [] });
  job(daemon, "continuation", "first");
  const task = daemon.coordination.get("first").task;
  assert.equal(task.latestJobId, "continuation");
  assert.equal(task.state, "working");
});

test("queued continuations never run after a failed or cancelled predecessor", async (context) => {
  for (const terminal of ["failed", "cancelled"] as const) {
    const daemon = fixture(context);
    const first = `first-${terminal}`;
    const continuation = `continuation-${terminal}`;
    job(daemon, first);
    daemon.database.transitionJob(first, ["queued"], "starting", { startedAt: new Date().toISOString() });
    daemon.database.transitionJob(first, ["starting"], "running");
    job(daemon, continuation, first, true);
    if (terminal === "cancelled") {
      daemon.database.transitionJob(first, ["running"], "cancel_requested");
      daemon.database.transitionJob(first, ["cancel_requested"], "cancelled", { finishedAt: new Date().toISOString() });
    } else {
      daemon.database.transitionJob(first, ["running"], "failed", { finishedAt: new Date().toISOString() });
    }
    daemon.database.completeTurn(first, "failed");
    daemon.coordination.setState(first, terminal === "cancelled"
      ? { outcome: "cancelled", phase: "Execution cancelled", blocker: null, nextAction: null, acknowledgedControls: [] }
      : { outcome: "blocked", phase: "Execution failed", blocker: "fixture failure", nextAction: "Inspect failure before resuming", acknowledgedControls: [] });

    daemon.start();
    for (let tries = 0; tries < 100 && daemon.database.getJob(continuation)?.state !== "cancelled"; tries++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(daemon.database.getJob(continuation)?.state, "cancelled");
    assert.equal(daemon.database.getPendingTurn(continuation)?.status, "failed");
    assert.equal(daemon.database.db.prepare("SELECT count(*) AS n FROM attempts WHERE job_id=?").get(continuation)!.n, 0);
    const task = daemon.coordination.get(first).task;
    assert.equal(task.state, terminal === "cancelled" ? "cancelled" : "blocked");
    assert.match(task.phase, terminal === "cancelled" ? /cancelled/i : /predecessor failed/i);
    if (terminal === "failed") {
      await daemon.call("daemon.drain", { enabled: true }, randomUUID());
      const resumed = await daemon.call("tasks.resume", { taskId: first }, randomUUID()) as { jobId: string };
      const resumeJob = daemon.database.getJob(resumed.jobId)!;
      assert.equal(resumeJob.predecessorJobId, first, "Resume must inherit the last executed job, not an unstarted cancelled continuation");
      assert.equal(resumeJob.parentJobId, first);
    }
    await daemon.stop();
  }

  const daemon = fixture(context);
  const finishedAt = "2026-09-06T00:00:00.000Z";
  job(daemon, "terminal-first");
  daemon.database.transitionJob("terminal-first", ["queued"], "starting");
  daemon.database.transitionJob("terminal-first", ["starting"], "running");
  daemon.database.transitionJob("terminal-first", ["running"], "failed", { finishedAt });
  daemon.database.completeTurn("terminal-first", "failed");
  daemon.coordination.setState("terminal-first", { outcome: "blocked", phase: "Execution failed", blocker: "fixture failure", nextAction: "Inspect", acknowledgedControls: [] });
  job(daemon, "explicit-after-terminal", "terminal-first");
  daemon.database.db.prepare("UPDATE jobs SET created_at=? WHERE id=?").run(finishedAt, "explicit-after-terminal");
  daemon.start();
  for (let tries = 0; tries < 100 && daemon.database.getJob("explicit-after-terminal")?.state === "queued"; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.notEqual(daemon.database.getJob("explicit-after-terminal")?.state, "cancelled");
  assert.equal(daemon.database.db.prepare("SELECT count(*) AS n FROM attempts WHERE job_id=?").get("explicit-after-terminal")!.n, 1);
  await daemon.stop();
});

test("a removed provider fails the queued task and turn without retaining worktree ownership", async (context) => {
  const daemon = fixture(context);
  job(daemon, "removed-provider");
  delete daemon.config.projects[0]!.workflows[0]!.providers.codex;
  daemon.start();
  for (let tries = 0; tries < 100 && daemon.database.getJob("removed-provider")?.state !== "failed"; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(daemon.database.getJob("removed-provider")?.state, "failed");
  assert.equal(daemon.database.getPendingTurn("removed-provider")?.status, "failed");
  const task = daemon.coordination.get("removed-provider").task;
  assert.equal(task.state, "blocked");
  assert.match(task.blocker!, /Provider is not configured/);
  assert.equal(daemon.database.db.prepare("SELECT count(*) AS n FROM task_ownership").get()!.n, 0);
  assert.equal(daemon.database.db.prepare("SELECT count(*) AS n FROM resource_locks").get()!.n, 0);
});

function runningFixture(context: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-coordination-running-"));
  const project = resolve(root, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", project]);
  writeFileSync(resolve(project, "tracked.txt"), "baseline\n");
  execFileSync("git", ["-C", project, "add", "tracked.txt"]);
  execFileSync("git", ["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline"]);
  const config: DaemonConfig = {
    socketPath: resolve(root, "run", "isolated.sock"), databasePath: resolve(root, "state", "bus.db"),
    artifactDirectory: resolve(root, "artifacts"),
    maxActive: 3,
    projects: [{ id: "project", name: "Fixture", path: project, workflows: [{
      id: "review", name: "Read only fixture", readOnly: true, qualityCommands: [],
      providers: { codex: { argv: [process.execPath, new URL("./__fixtures__/coordination-provider.js", import.meta.url).pathname, root] } },
    }] }],
  };
  const value = { root, config, daemon: new DovskyDaemon(config) };
  context.after(async () => { await value.daemon.stop(); value.daemon.close(); removeFixtureTree(root); });
  return value;
}

interface Observation { event: string; jobId: string; socket: string; argv: string[] }
function observations(root: string): Observation[] {
  const path = resolve(root, "observations.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Observation) : [];
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for fixture state");
    await new Promise((done) => setTimeout(done, 10));
  }
}
async function submit(daemon: DovskyDaemon): Promise<{ roomId: string; jobIds: string[] }> {
  return await daemon.call("rooms.create", { title: "Fixture", projectId: "project", workflowId: "review", prompt: "Local fixture", recipients: ["codex"] }, randomUUID()) as { roomId: string; jobIds: string[] };
}

test("read-only followups serialize with same-millisecond causality and resolve the final thread", async (context) => {
  const { daemon, root } = runningFixture(context);
  daemon.start();
  const created = await submit(daemon);
  const first = created.jobIds[0]!;
  await until(() => observations(root).some((item) => item.jobId === first && item.event === "started"));
  assert.equal(daemon.database.getJob(first)?.threadId, null);
  const followup = await daemon.call("messages.create", { roomId: created.roomId, body: "Followup", recipient: "codex" }, randomUUID()) as { jobIds: string[] };
  const second = followup.jobIds[0]!;
  daemon.database.db.prepare("UPDATE jobs SET created_at=? WHERE id IN (?,?)").run("2026-09-06T00:00:00.000Z", first, second);
  await new Promise((done) => setTimeout(done, 60));
  assert.equal(daemon.database.getJob(second)?.state, "queued");
  assert.equal(observations(root).filter((item) => item.event === "started").length, 1);
  writeFileSync(resolve(root, `${first}.release`), "release");
  await until(() => observations(root).some((item) => item.jobId === second && item.event === "started"));
  const records = observations(root);
  assert.ok(records.findIndex((item) => item.jobId === first && item.event === "finished") < records.findIndex((item) => item.jobId === second && item.event === "started"));
  assert.equal(daemon.database.getJob(first)?.state, "succeeded");
  assert.equal(daemon.database.getJob(second)?.resumeThreadId, "late-fixture-thread");
  assert.ok(records.find((item) => item.jobId === second && item.event === "started")?.argv.includes("late-fixture-thread"));
  writeFileSync(resolve(root, `${second}.release`), "release");
  await until(() => daemon.database.getJob(second)?.state === "succeeded");
});

test("provider children receive the isolated daemon socket rather than the ambient default", async (context) => {
  const { daemon, root, config } = runningFixture(context);
  const previousSocket = process.env.DOVSKY_SOCKET;
  process.env.DOVSKY_SOCKET = resolve(root, "wrong-ambient.sock");
  context.after(() => { if (previousSocket === undefined) delete process.env.DOVSKY_SOCKET; else process.env.DOVSKY_SOCKET = previousSocket; });
  daemon.start();
  const first = (await submit(daemon)).jobIds[0]!;
  await until(() => observations(root).some((item) => item.event === "started"));
  const socket = observations(root)[0]?.socket;
  assert.equal(typeof socket, 'string');
  assert.notEqual(socket, config.socketPath);
  assert.notEqual(socket, process.env.DOVSKY_SOCKET);
  assert.ok(existsSync(socket!));
  writeFileSync(resolve(root, `${first}.release`), "release");
  await until(() => daemon.database.getJob(first)?.state === "succeeded");
  assert.equal(existsSync(socket!), false);
});

test("drain lets active work finish, holds queued work and persists across reopen", async (context) => {
  const value = runningFixture(context);
  value.daemon.start();
  const first = (await submit(value.daemon)).jobIds[0]!;
  await until(() => observations(value.root).some((item) => item.event === "started"));
  await value.daemon.call("daemon.drain", { enabled: true }, randomUUID());
  const second = (await submit(value.daemon)).jobIds[0]!;
  writeFileSync(resolve(value.root, `${first}.release`), "release");
  await until(() => value.daemon.database.getJob(first)?.state === "succeeded");
  assert.equal(value.daemon.database.getJob(second)?.state, "queued");
  await value.daemon.stop();
  value.daemon.close();
  value.daemon = new DovskyDaemon(value.config);
  value.daemon.start();
  assert.deepEqual(await value.daemon.call("daemon.drain", {}), { draining: true, activeJobs: 0, queuedJobs: 1 });
  await new Promise((done) => setTimeout(done, 60));
  assert.equal(observations(value.root).filter((item) => item.event === "started").length, 1);
  await value.daemon.call("daemon.drain", { enabled: false }, randomUUID());
  await until(() => observations(value.root).some((item) => item.jobId === second && item.event === "started"));
  writeFileSync(resolve(value.root, `${second}.release`), "release");
  await until(() => value.daemon.database.getJob(second)?.state === "succeeded");
});
