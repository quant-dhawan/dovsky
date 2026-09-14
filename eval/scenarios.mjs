#!/usr/bin/env node
// Runner revision 2 (report schema 1). The daemon freezes this self-contained file before a worker starts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const target = resolve(process.argv[2]);
// Building is part of this project's frozen runner, not a daemon assumption.
for (const project of ["packages/protocol", "apps/daemon"]) {
  execFileSync(process.execPath, [resolve(target, "node_modules/typescript/bin/tsc"), "-p", `${project}/tsconfig.json`], { cwd: target, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
}
const { RpcServer } = await import(pathToFileURL(resolve(target, "apps/daemon/dist/index.js")).href);
const { FixtureDaemon: DovskyDaemon, removeFixtureTree } = await import(pathToFileURL(resolve(target, 'apps/daemon/dist/__fixtures__/runtime-isolation.js')).href);
const exec = promisify(execFile);
const root = mkdtempSync(resolve(tmpdir(), "dovsky-scenarios-"));
// Keep provider behavior independent of the candidate's own test fixtures.
const provider = resolve(root, "provider.mjs");
writeFileSync(provider, [
  'import {readFileSync,writeFileSync,existsSync} from "node:fs";',
  'const mode=process.argv[2]; const input=readFileSync(0,"utf8");',
  'const controls=JSON.parse(/^Pending controls \\(in order\\): (.+)$/m.exec(input)?.[1]??"[]");',
  'const result=(outcome="completed")=>"DOVSKY_RESULT: "+JSON.stringify({outcome,phase:outcome==="completed"?"Fixture complete":"Decision needed",blocker:outcome==="completed"?null:"Operator decision",nextAction:outcome==="completed"?null:"Record control and resume",acknowledgedControls:controls.map(c=>c.id)});',
  'if(mode==="sleep") setTimeout(()=>console.log("done"),30000);',
  'else if(mode==="control-hold") { const marker=process.argv[3]; writeFileSync(marker+".ready","ready"); const timer=setInterval(()=>{if(existsSync(marker+".release")){clearInterval(timer);console.log(result());}},20); }',
  'else if(mode==="awaiting") { const marker=process.argv[3]; const resumed=existsSync(marker); writeFileSync(marker,"started"); console.log(result(resumed?"completed":"awaiting_decision")); }',
  'else if(mode==="review") { const p=process.argv[3]; const n=existsSync(p)?Number(readFileSync(p,"utf8")):0; writeFileSync(p,String(n+1)); console.log(n===0?"1. changed.txt:1 — correction required\\nVERDICT: REFUTED":"VERDICT: APPROVED"); }',
  'else if(mode==="thread") { writeFileSync("changed.txt",input); console.log(JSON.stringify({type:"thread.started",thread_id:"fixture-thread"})); console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"FIXTURE RESULT "+JSON.stringify(process.argv)+"\\n"+result()}})); }',
  'else console.log("FIXTURE RESULT "+input+"\\n"+result());',
].join("\n"));

const scenarios = [];
const deadline = setTimeout(() => { process.stderr.write("Scenario suite exceeded 120 seconds\n"); process.exit(2); }, 120_000);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

async function scenario(id, mode, body, qualityCommands = [], review = false) {
  const started = Date.now();
  const home = resolve(root, id);
  const project = resolve(home, "project");
  mkdirSync(project, { recursive: true });
  git(project, "init", "-q");
  git(project, "config", "user.email", "eval@example.invalid");
  git(project, "config", "user.name", "Dovsky evaluation");
  writeFileSync(resolve(project, "tracked.txt"), "baseline\n");
  git(project, "add", ".");
  git(project, "commit", "-qm", "fixture baseline");
  const config = {
    socketPath: resolve(home, "bus.sock"), databasePath: resolve(home, "state/bus.db"), artifactDirectory: resolve(home, "artifacts"), maxActive: 1,
    projects: [{ id: "fixture", name: "Fixture", path: project, workflows: [
      { id: "change", name: "Change", readOnly: false, qualityCommands, providers: { codex: { argv: [process.execPath, provider, mode, resolve(home, "provider-marker")] } }, ...(review ? { review: { enabled: true, provider: "other", tier: "hard", maxCorrections: 1, small: null } } : {}) },
      { id: "review", name: "Review", readOnly: true, qualityCommands: [], providers: { claude: { argv: [process.execPath, provider, "review", resolve(home, "reviews")] } } },
    ] }],
  };
  let daemon;
  let server;
  try {
    daemon = new DovskyDaemon(config);
    server = new RpcServer(daemon, config.socketPath);
    await server.listen();
    daemon.start();
    const call = (method, params = {}) => daemon.call(method, params, randomUUID());
    const send = (prompt = "Exercise fixture") => call("rooms.create", { title: id, projectId: "fixture", workflowId: "change", prompt, recipients: ["codex"], force: true });
    const wait = async (jobId, predicate = (j) => ["succeeded", "failed", "cancelled"].includes(j.state)) => {
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        const job = await call("jobs.get", { jobId });
        if (predicate(job)) return job;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("Timed out waiting for fixture job");
    };
    const cli = (...args) => exec(process.execPath, [resolve(target, "bin/dovsky"), ...args, "--socket", config.socketPath, "--json"], { timeout: 10_000 });
    await body({ daemon, config, call, send, wait, cli, project, marker: resolve(home, "provider-marker") });
    scenarios.push({ id, passed: true, detail: "All scenario assertions passed", durationMs: Date.now() - started });
  } catch (error) {
    scenarios.push({ id, passed: false, detail: String(error.message).slice(0, 8000), durationMs: Date.now() - started });
  } finally {
    if (server) await server.close();
    if (daemon) { await daemon.stop(); daemon.close(); }
  }
}

try {
  await scenario("dispatch-result", "success", async ({ send, wait, cli }) => {
    const { jobIds } = await send("known input");
    assert.equal((await wait(jobIds[0])).state, "succeeded");
    const { stdout } = await cli("result", jobIds[0]);
    assert.match(JSON.parse(stdout).result, /FIXTURE RESULT.*known input/s);
  });
  await scenario("thread-resume", "thread", async ({ send, wait, call }) => {
    const { roomId, jobIds } = await send();
    assert.equal((await wait(jobIds[0])).state, "succeeded");
    const next = await call("messages.create", { roomId, recipient: "codex", body: "Continue", force: true });
    assert.equal((await wait(next.jobIds[0])).state, "succeeded");
    const result = await call("jobs.result", { jobId: next.jobIds[0] });
    assert.match(result.result, /fixture-thread/);
  });
  await scenario("cancellation", "sleep", async ({ send, wait, call }) => {
    const { jobIds } = await send();
    await wait(jobIds[0], (job) => job.state === "running");
    await call("jobs.cancel", { jobId: jobIds[0] });
    assert.equal((await wait(jobIds[0])).state, "cancelled");
  });
  await scenario("gate-failure", "thread", async ({ send, wait }) => {
    const { jobIds } = await send();
    const job = await wait(jobIds[0]);
    assert.equal(job.state, "failed");
    assert.equal(job.failure.code, "quality_gate");
  }, [[process.execPath, "-e", 'process.exit(require("node:fs").existsSync("changed.txt")?1:0)']]);
  await scenario("review-correction", "thread", async ({ send, call }) => {
    const { roomId } = await send();
    const until = Date.now() + 15_000;
    let detail;
    do {
      detail = await call("rooms.get", { roomId });
      if (detail.jobs.filter((j) => j.role === "review").length === 2 && detail.jobs.every((j) => j.state === "succeeded")) break;
      await new Promise((r) => setTimeout(r, 25));
    } while (Date.now() < until);
    assert.equal(detail.jobs.filter((j) => j.role === "work").length, 2);
    assert.deepEqual(detail.jobs.filter((j) => j.role === "review").map((j) => j.verdict), ["refuted", "approved"]);
  }, [], true);
  await scenario("restart-recovery", "success", async ({ daemon, config }) => {
    // Persist an orphaned run in an isolated database, then exercise startup recovery.
    await daemon.stop();
    daemon.database.createRoom("recovery-room", "Recovery", "fixture", "change");
    daemon.database.createJob({ id: "orphan", roomId: "recovery-room", provider: "codex", projectId: "fixture", workflowId: "change", prompt: "interrupted" }, "orphan-turn");
    daemon.database.transitionJob("orphan", ["queued"], "starting");
    daemon.database.transitionJob("orphan", ["starting"], "running");
    const restarted = new DovskyDaemon(config);
    try {
      restarted.start();
      const job = await restarted.call("jobs.get", { jobId: "orphan" });
      assert.equal(job.state, "failed");
      assert.equal(job.failure.code, "daemon_restart");
    } finally { await restarted.stop(); restarted.close(); }
  });
  await scenario("control-delivery-ack", "control-hold", async ({ send, wait, call, marker }) => {
    const { roomId, jobIds } = await send();
    const jobId = jobIds[0];
    await wait(jobId, (job) => job.state === "running" && existsSync(marker + ".ready"));
    const taskId = (await call("jobs.get", { jobId })).taskId;
    const control = await call("tasks.controls.create", { taskId, kind: "decision", body: "Continue the local fixture" });
    assert.equal(control.deliveredAt, null);
    assert.equal(control.acknowledgedAt, null);
    assert.equal((await call("rooms.get", { roomId })).jobs.length, 1);
    const delivered = await call("tasks.checkpoint", { taskId, jobId });
    assert.equal(delivered.controls[0].deliveredJobId, jobId);
    assert.equal(delivered.controls[0].acknowledgedAt, null);
    const acknowledged = await call("tasks.controls.ack", { taskId, jobId, controlIds: [control.id] });
    assert.equal(acknowledged.controls[0].acknowledgedJobId, jobId);
    assert.ok(acknowledged.controls[0].acknowledgedAt);
    writeFileSync(marker + ".release", "release");
    assert.equal((await wait(jobId)).state, "succeeded");
    assert.equal((await call("tasks.get", { taskId })).task.state, "completed");
    assert.equal((await call("rooms.get", { roomId })).jobs.length, 1);
  });
  await scenario("checkpoint-resume-gates", "awaiting", async ({ send, wait, call, project }) => {
    const { roomId, jobIds } = await send();
    const first = await wait(jobIds[0]);
    const taskId = first.taskId;
    assert.equal(first.state, "succeeded");
    assert.equal((await call("tasks.get", { taskId })).task.state, "awaiting_decision");
    assert.equal(existsSync(resolve(project, "completion-gate-ran")), false);
    const control = await call("tasks.controls.create", { taskId, kind: "decision", body: "Proceed with the fixture" });
    const resumed = await call("tasks.resume", { taskId });
    assert.equal(resumed.taskId, taskId);
    assert.notEqual(resumed.jobId, first.id);
    assert.equal((await wait(resumed.jobId)).state, "succeeded");
    const completed = await call("tasks.get", { taskId });
    assert.equal(completed.task.state, "completed");
    assert.equal(completed.controls.find((item) => item.id === control.id).acknowledgedJobId, resumed.jobId);
    const checks = (await call("rooms.get", { roomId })).checks.filter((item) => item.jobId === resumed.jobId);
    assert.deepEqual(checks.map(({ command, state }) => ({ command, state })), [{
      command: [process.execPath, "-e", 'require("node:fs").writeFileSync("completion-gate-ran","ran")'],
      state: "passed",
    }]);
    assert.equal(existsSync(resolve(project, "completion-gate-ran")), false);
  }, [[process.execPath, "-e", 'require("node:fs").writeFileSync("completion-gate-ran","ran")']]);
  await scenario("coordination-drain-restart", "awaiting", async ({ send, wait, call, daemon, config }) => {
    const { jobIds } = await send();
    const first = await wait(jobIds[0]);
    const taskId = first.taskId;
    const control = await call("tasks.controls.create", { taskId, kind: "instruction", body: "Continue after restart" });
    await call("daemon.drain", { enabled: true });
    await daemon.stop();
    const restarted = new DovskyDaemon(config);
    const invoke = (method, params = {}) => restarted.call(method, params, randomUUID());
    try {
      restarted.start();
      assert.equal((await invoke("daemon.drain")).draining, true);
      const retained = await invoke("tasks.get", { taskId });
      assert.equal(retained.task.state, "awaiting_decision");
      assert.equal(retained.controls[0].id, control.id);
      assert.equal(retained.controls[0].deliveredAt, null);
      assert.equal(retained.controls[0].acknowledgedAt, null);
      const resumed = await invoke("tasks.resume", { taskId });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal((await invoke("jobs.get", { jobId: resumed.jobId })).state, "queued");
      await invoke("daemon.drain", { enabled: false });
      assert.equal((await wait(resumed.jobId)).state, "succeeded");
      const completed = await invoke("tasks.get", { taskId });
      assert.equal(completed.task.state, "completed");
      assert.equal(completed.controls[0].acknowledgedJobId, resumed.jobId);
    } finally { await restarted.stop(); restarted.close(); }
  });
  process.stdout.write(JSON.stringify({ version: 1, scenarios }) + "\n");
} finally {
  clearTimeout(deadline);
  removeFixtureTree(root);
}
