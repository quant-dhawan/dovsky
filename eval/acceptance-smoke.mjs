#!/usr/bin/env node
// Exercise all acceptance levels on a disposable copy of this repository. No live providers or production state.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { RpcServer } from "../apps/daemon/dist/index.js";
import { FixtureDaemon as DovskyDaemon, removeFixtureTree } from '../apps/daemon/dist/__fixtures__/runtime-isolation.js';
import { prepareEvaluationTree } from "../apps/daemon/dist/evaluation-tree.js";
import { cleanupAcceptanceWorktree, reportAcceptanceCleanupFailures } from "./acceptance-cleanup.mjs";

const source = resolve(import.meta.dirname, "..");
const root = mkdtempSync(resolve(tmpdir(), "dovsky-acceptance-smoke-"));
const project = resolve(root, "project");
const git = (...args) => {
  const result = spawnSync("git", ["-C", source, ...args], { maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
};
let daemon;
let server;
try {
  prepareEvaluationTree(source, project, git("rev-parse", "HEAD").toString().trim(), git("diff", "HEAD", "--binary"), git("ls-files", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean), source, []);
  // The review workflow inherits the default dependency root; this Node-only fixture must never install from the network.
  mkdirSync(resolve(project, "node_modules"));
  // Do not share any runtime state with the installed daemon.
  const fixture = resolve(root, "provider.mjs");
  writeFileSync(fixture, 'import {writeFileSync,readFileSync} from "node:fs";const input=readFileSync(0,"utf8"); if(process.argv[2]==="review")console.log("VERDICT: APPROVED");else{writeFileSync("acceptance-smoke.txt",input);console.log("Fixture edit completed\\nDOVSKY_RESULT: "+JSON.stringify({outcome:"completed",phase:"Fixture complete",blocker:null,nextAction:null,acknowledgedControls:[]}));}');
  const runner = resolve(project, "acceptance-runner.mjs");
  writeFileSync(runner, 'import {existsSync} from "node:fs";import {resolve} from "node:path";const passed=existsSync(resolve(process.argv[2],"acceptance-smoke.txt"));const ids=["dispatch-result","thread-resume","cancellation","gate-failure","review-correction","restart-recovery","control-delivery-ack","checkpoint-resume-gates","coordination-drain-restart"];console.log(JSON.stringify({version:1,scenarios:ids.map(id=>({id,passed,detail:passed?"fixture result exists":"fixture result absent",durationMs:1}))}));');
  const config = {
    socketPath: resolve(root, "bus.sock"), databasePath: resolve(root, "state/bus.db"), artifactDirectory: resolve(root, "artifacts"), maxActive: 1,
    projects: [{ id: "smoke", name: "Acceptance smoke", path: project, workflows: [
      { id: "change", name: "Change", readOnly: false, qualityCommands: [[process.execPath, "-e", 'require("node:assert/strict").ok(require("node:fs").existsSync("acceptance-smoke.txt"))']], evaluation: { enabled: true, defaultLevel: "medium", runner: "acceptance-runner.mjs", dependencyRoots: [] }, review: { enabled: true, provider: "other", tier: "hard", maxCorrections: 1, small: null }, providers: { codex: { argv: [process.execPath, fixture, "edit"] } } },
      { id: "review", name: "Review", readOnly: true, qualityCommands: [], providers: { claude: { argv: [process.execPath, fixture, "review"] } } },
    ] }],
  };
  daemon = new DovskyDaemon(config);
  server = new RpcServer(daemon, config.socketPath);
  await server.listen();
  daemon.start();
  const call = (method, params = {}) => daemon.call(method, params, randomUUID());
  const wait = async (id) => {
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const job = await call("jobs.get", { jobId: id });
      if (["failed", "cancelled"].includes(job.state) || job.state === "succeeded" && job.review?.verdict) return job;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Smoke job timed out");
  };
  for (const level of ["low", "medium", "high"]) {
    const created = await call("rooms.create", { title: level, projectId: "smoke", workflowId: "change", recipients: ["codex"], prompt: `Write the ${level} fixture result`, evalLevel: level, evalReason: "Synthetic acceptance exercise", acceptance: { criteria: ["The fixture result file is readable"] }, force: true });
    let job = await wait(created.jobIds[0]);
    assert.equal(job.state, "succeeded", job.failure?.summary);
    assert.ok(readFileSync(resolve(project, "acceptance-smoke.txt"), "utf8").includes(level));
    if (level !== "low") {
      assert.equal(job.evaluation.state, "pending");
      assert.equal(job.evaluation.report.candidate.length, 9);
      if (level === "high") assert.equal(job.evaluation.report.baseline.length, 9);
      const decision = { jobId: job.id, verdict: "rejected", checked: [], note: "Synthetic operator rejection", fingerprint: job.evaluation.fingerprint, evidenceHash: job.evaluation.evidenceHash };
      await call("jobs.acceptance.record", decision);
      assert.equal((await call("jobs.acceptance.check", { jobId: job.id })).accepted, false);
      const followup = await call("messages.create", { roomId: created.roomId, recipient: "codex", body: `Corrected ${level} fixture result`, force: true });
      job = await wait(followup.jobIds[0]);
      assert.equal(job.state, "succeeded", job.failure?.summary);
      assert.equal(job.evaluation.decision, null);
      await call("jobs.acceptance.record", { ...decision, jobId: job.id, verdict: "accepted", checked: [0], note: "Synthetic operator exercised corrected result", fingerprint: job.evaluation.fingerprint, evidenceHash: job.evaluation.evidenceHash });
    }
    assert.equal((await call("jobs.acceptance.check", { jobId: job.id })).accepted, true);
    process.stdout.write(`PASS ${level}: evaluated and accepted in isolated state\n`);
  }
} finally {
  if (server) await server.close();
  if (daemon) { await daemon.stop(); daemon.close(); }
  const cleanupFailures = cleanupAcceptanceWorktree(source, project);
  removeFixtureTree(root);
  reportAcceptanceCleanupFailures(cleanupFailures);
}
