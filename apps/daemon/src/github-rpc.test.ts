import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { DovskyDaemon } from "./daemon.js";
import type { DaemonConfig } from "./config.js";
import { evidenceHash } from "./evaluation.js";
import { gitBytes, treeFingerprint, worktreeAdd } from "./git.js";
import { captureBaseline, diffSnapshots } from "./job-delta.js";
import type { GitHubCommandResult, GitHubCommandRunner } from "./github.js";
import type { JobIsolation } from "./isolation.js";

const JOB_ID = "job-12345678";
const ROOM_ID = "room-12345678";

function git(cwd: string, ...args: string[]): void { gitBytes(cwd, args); }

function unlock(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) for (const name of readdirSync(path)) unlock(join(path, name));
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dovsky-github-rpc-"));
  const project = join(root, "project"), remote = join(root, "remote.git"), artifacts = join(root, "artifacts");
  mkdirSync(project); mkdirSync(remote); mkdirSync(artifacts);
  git(project, "init", "-q"); git(remote, "init", "--bare", "-q");
  git(project, "config", "user.name", "Fixture"); git(project, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(project, "tracked.txt"), "before\n");
  git(project, "add", "."); git(project, "commit", "-qm", "baseline");
  git(project, "remote", "add", "origin", remote); git(project, "push", "-q", "origin", "HEAD:main");
  const baseline = captureBaseline(project, join(root, "baseline"));
  writeFileSync(join(project, "tracked.txt"), "after\n");
  writeFileSync(join(project, "new.txt"), "new\n");
  const final = captureBaseline(project, join(root, "final"));
  const delta = diffSnapshots(baseline, final);
  const evidence = "review evidence";
  const config: DaemonConfig = {
    socketPath: join(root, "run", "daemon.sock"), databasePath: join(root, "state", "daemon.db"), artifactDirectory: artifacts, maxActive: 1,
    projects: [{ id: "project", name: "Fixture", path: project, github: { enabled: true, remote: "origin", repository: "owner/project", baseBranch: "main", commitName: "Fixture", commitEmail: "fixture@example.invalid", draft: false },
      workflows: [{ id: "change", name: "Change", readOnly: false, qualityCommands: [], providers: {} }] }],
  };
  let creates = 0;
  let calls = 0;
  let createFailures = 0;
  const statusHead = "a".repeat(40);
  const runner: GitHubCommandRunner = async (argv): Promise<GitHubCommandResult> => {
    calls += 1;
    if (argv[0] !== "gh") throw new Error(`unexpected command: ${argv.join(" ")}`);
    if (argv[1] === "auth") return { status: 0, stdout: "Logged in\n", stderr: "" };
    if (argv[1] === "pr" && argv[2] === "list") return { status: 0, stdout: "[]\n", stderr: "" };
    if (argv[1] === "pr" && argv[2] === "create") {
      creates += 1;
      if(createFailures>0){createFailures-=1;return {status:1,stdout:"",stderr:"fixture failure"};}
      return { status: 0, stdout: "https://github.com/owner/project/pull/7\n", stderr: "" };
    }
    if (argv[1] === "pr" && argv[2] === "view") return { status: 0, stdout: JSON.stringify({ number: 7, state: "MERGED", url: "https://github.com/owner/project/pull/7", headRefOid: statusHead, isDraft: false, mergedAt: "2026-09-13T00:00:00.000Z", mergeCommit: { oid: "b".repeat(40) } }), stderr: "" };
    throw new Error(`unexpected gh command: ${argv.join(" ")}`);
  };
  const isolation: JobIsolation = {
    available: async () => ({ available: true, backend: "bwrap", reason: null, bwrapVersion: null }),
    prepare: async () => { throw new Error("unused in github RPC tests"); },
  };
  const daemon = new DovskyDaemon(config, { isolation, githubRunner: runner });
  const db = daemon.database;
  db.createRoom(ROOM_ID, "Fixture pull request", "project", "change");
  db.createJob({ id: JOB_ID, roomId: ROOM_ID, provider: "codex", projectId: "project", workflowId: "change", prompt: "fixture", cwd: project }, "turn-12345678");
  const app = { state: "complete", canonicalPath: project, intentPath: join(root, "apply.json"), baselinePath: baseline.directory, finalPath: final.directory,
    expected: baseline.manifest.identity, contentHash: final.manifest.identity.contentHash };
  const report = { suiteHash: "fixture", candidate: [], baseline: null, problems: [] };
  const path = join(root, "review-evidence.md"); writeFileSync(path, evidence);
  const baselinePath = resolve(artifacts, "jobs", JOB_ID); mkdirSync(baselinePath, { recursive: true });
  writeFileSync(resolve(baselinePath, "coordination-baseline.json"), JSON.stringify({ commit: baseline.manifest.commit, fingerprint: baseline.manifest.identity.fingerprint, dirty: [], untracked: [] }));
  db.addArtifact(randomUUID(), JOB_ID, "evidence", "review-evidence.md", "text/markdown", Buffer.byteLength(evidence), path);
  db.db.prepare(`UPDATE jobs SET state='succeeded', sandbox_json=?, execution_baseline_path=?, end_fingerprint=?, end_content_hash=?, evaluation_json=?, evaluation_report_json=?, evaluation_evidence_hash=?, acceptance_json=? WHERE id=?`).run(
    JSON.stringify({ application: app }), baseline.directory, treeFingerprint(project), final.manifest.identity.contentHash,
    JSON.stringify({ baselineJobId: JOB_ID, level: "low", reason: "fixture", criteria: [], expectedBaselineFailures: [], runnerSource: "", runnerPath: "fixture.mjs", runnerHash: "fixture", qualityCommands: [], reviewRequired: false }),
    JSON.stringify(report), evidenceHash(evidence), JSON.stringify({ verdict: "accepted", note: "fixture", checked: [] }), JOB_ID,
  );
  db.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(JOB_ID);
  t.after(() => { daemon.close(); if (existsSync(root)) { unlock(root); rmSync(root, { recursive: true, force: true }); } });
  return { daemon, db, baseline, final, project, artifacts, evidenceHash: evidenceHash(evidence), baselineRecordPath: resolve(baselinePath, "coordination-baseline.json"),
    failNextCreate(){createFailures+=1;},get calls() { return calls; }, get creates() { return creates; } };
}

test("github.pr.create requires the exact key and accepted immutable job identity", async t => {
  const f = fixture(t);
  await assert.rejects(f.daemon.call("github.pr.create", { jobId: JOB_ID, fingerprint: f.final.manifest.identity.fingerprint, evidenceHash: f.evidenceHash }, "wrong-key"), { code: "INVALID_REQUEST" });
  await assert.rejects(f.daemon.call("github.pr.create", { jobId: JOB_ID, fingerprint: "0".repeat(64), evidenceHash: f.evidenceHash }, `pr:${JOB_ID}`), { code: "STATE_CONFLICT" });
  assert.equal(f.db.getPullRequest(JOB_ID), null);
});

test("github.pr.create refuses a dirty coordination baseline before external or durable publication", async t => {
  const f = fixture(t);
  writeFileSync(f.baselineRecordPath, JSON.stringify({ commit: f.baseline.manifest.commit, fingerprint: f.baseline.manifest.identity.fingerprint, dirty: ["tracked.txt"], untracked: [] }));
  await assert.rejects(f.daemon.call("github.pr.create", { jobId: JOB_ID, fingerprint: f.final.manifest.identity.fingerprint, evidenceHash: f.evidenceHash }, `pr:${JOB_ID}`), { code: "STATE_CONFLICT" });
  assert.equal(f.calls, 0);
  assert.equal(f.db.getPullRequest(JOB_ID), null);
  assert.equal(f.db.db.prepare("SELECT count(*) AS count FROM operations WHERE idempotency_key=?").get(`pr:${JOB_ID}`)?.count, 0);
});

test("github.pr.create publishes an evaluated correction from the original clean baseline", async t => {
  const f = fixture(t);
  const correctionId = "job-correction-1234";
  writeFileSync(join(f.project, "tracked.txt"), "refuted\n");
  const intermediate = captureBaseline(f.project, resolve(f.baseline.directory, "..", "intermediate"));
  writeFileSync(join(f.project, "tracked.txt"), "after\n");
  f.db.createJob({ id: correctionId, roomId: ROOM_ID, provider: "codex", projectId: "project", workflowId: "change", prompt: "correction", cwd: f.project }, "turn-correction");
  const application = { state: "complete", canonicalPath: f.project, intentPath: resolve(f.artifacts, "correction-apply.json"), baselinePath: intermediate.directory,
    finalPath: f.final.directory, expected: intermediate.manifest.identity, contentHash: f.final.manifest.identity.contentHash };
  const evidence = "correction review evidence";
  const evidencePath = resolve(f.artifacts, "correction-review-evidence.md");
  writeFileSync(evidencePath, evidence);
  f.db.addArtifact(randomUUID(), correctionId, "evidence", "review-evidence.md", "text/markdown", Buffer.byteLength(evidence), evidencePath);
  f.db.db.prepare(`UPDATE jobs SET state='succeeded', sandbox_json=?, execution_baseline_path=?, end_fingerprint=?, end_content_hash=?, evaluation_json=?, evaluation_report_json=?, evaluation_evidence_hash=?, acceptance_json=? WHERE id=?`).run(
    JSON.stringify({ application }), intermediate.directory, f.final.manifest.identity.fingerprint, f.final.manifest.identity.contentHash,
    JSON.stringify({ baselineJobId: JOB_ID, level: "low", reason: "correction", criteria: [], expectedBaselineFailures: [], runnerSource: "", runnerPath: "fixture.mjs", runnerHash: "fixture", qualityCommands: [], reviewRequired: false }),
    JSON.stringify({ suiteHash: "fixture", candidate: [], baseline: null, problems: [] }), evidenceHash(evidence), JSON.stringify({ verdict: "accepted", note: "fixture", checked: [] }), correctionId,
  );
  f.db.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(correctionId);

  const result = await f.daemon.call("github.pr.create", { jobId: correctionId, fingerprint: f.final.manifest.identity.fingerprint, evidenceHash: evidenceHash(evidence) }, `pr:${correctionId}`) as { state: string; headSha: string };
  assert.equal(result.state, "open");
  assert.equal(gitBytes(f.project, ["show", `${result.headSha}:tracked.txt`]).toString(), "after\n");
  assert.equal(gitBytes(f.project, ["show", `${result.headSha}:new.txt`]).toString(), "new\n");
});

test("github.pr.create persists and replays one exact publication", async t => {
  const f = fixture(t);
  const params = { jobId: JOB_ID, fingerprint: f.final.manifest.identity.fingerprint, evidenceHash: f.evidenceHash };
  const first = await f.daemon.call("github.pr.create", params, `pr:${JOB_ID}`) as { state: string; headSha: string; number: number; url: string };
  assert.deepEqual({ state: first.state, number: first.number, url: first.url }, { state: "open", number: 7, url: "https://github.com/owner/project/pull/7" });
  assert.match(first.headSha, /^[0-9a-f]{40}$/);
  assert.equal(f.db.getPullRequest(JOB_ID)?.state, "open");
  assert.equal(f.creates, 1);
  const callsAfterCreate=f.calls;
  writeFileSync(resolve(f.project,"post-publication.txt"),"operator change\n");
  const replay = await f.daemon.call("github.pr.create", params, `pr:${JOB_ID}`);
  assert.deepEqual(replay, first);
  assert.equal(f.calls,callsAfterCreate);
  assert.equal(f.creates, 1);
  assert.equal(f.db.db.prepare("SELECT state FROM operations WHERE idempotency_key=?").get(`pr:${JOB_ID}`)?.state, "completed");
});

test("github.pr.status reconciles durable state without completing a pending creation operation", async t => {
  const f = fixture(t);
  const input = { jobId: JOB_ID, roomId: ROOM_ID, repository: "owner/project", remote: "origin", baseBranch: "main", branch: "dovsky/room-123-job-1234",
    startCommit: f.baseline.manifest.commit, fingerprint: f.final.manifest.identity.fingerprint, contentHash: f.final.manifest.identity.contentHash, evidenceHash: f.evidenceHash, intent: { version: 1, draft: false } };
  f.db.reservePullRequestOperation("operator", `pr:${JOB_ID}`, "github.pr.create", "fixture-request", input);
  f.db.recordPullRequestProgress(JOB_ID, "committed", "a".repeat(40));
  f.db.recordPullRequestProgress(JOB_ID, "pushed", "a".repeat(40));
  const result = await f.daemon.call("github.pr.status", { jobId: JOB_ID }) as { state: string; number: number };
  assert.deepEqual({ state: result.state, number: result.number }, { state: "merged", number: 7 });
  assert.equal(f.db.getPullRequest(JOB_ID)?.state, "merged");
  assert.equal(f.db.db.prepare("SELECT state FROM operations WHERE idempotency_key=?").get(`pr:${JOB_ID}`)?.state, "pending");
});

test("github.pr.create recovers a pushed branch after a failed GitHub create",async t=>{
  const f=fixture(t),params={jobId:JOB_ID,fingerprint:f.final.manifest.identity.fingerprint,evidenceHash:f.evidenceHash};
  f.failNextCreate();
  await assert.rejects(f.daemon.call("github.pr.create",params,`pr:${JOB_ID}`),{code:"EXTERNAL_ERROR"});
  const uncertain=f.db.getPullRequest(JOB_ID)!;
  assert.equal(uncertain.state,"reconcile_required"); assert.match(uncertain.headSha!,/^[0-9a-f]{40}$/);
  assert.equal(f.db.db.prepare("SELECT state FROM operations WHERE idempotency_key=?").get(`pr:${JOB_ID}`)?.state,"pending");

  const recovered=await f.daemon.call("github.pr.create",params,`pr:${JOB_ID}`) as {state:string;headSha:string};
  assert.equal(recovered.state,"open"); assert.equal(recovered.headSha,uncertain.headSha); assert.equal(f.creates,2);
  assert.equal(f.db.db.prepare("SELECT count(*) AS count FROM events WHERE job_id=? AND type='pull_request.opened'").get(JOB_ID)?.count,1);
  assert.equal(f.db.db.prepare("SELECT state FROM operations WHERE idempotency_key=?").get(`pr:${JOB_ID}`)?.state,"completed");
});

test("worktree reaping cannot remove an active pull request worktree",t=>{
  const f=fixture(t),path=resolve(f.artifacts,"pr-worktrees",JOB_ID);
  mkdirSync(resolve(f.artifacts,"pr-worktrees")); worktreeAdd(f.project,path,f.baseline.manifest.commit);
  const daemon=f.daemon as any;
  daemon.activePullRequests.add(JOB_ID); daemon.reapWorktrees(); assert.equal(existsSync(path),true);
  daemon.activePullRequests.delete(JOB_ID); daemon.reapWorktrees(); assert.equal(existsSync(path),false);
});
