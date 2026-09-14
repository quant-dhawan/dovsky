import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { EvaluationLevel, JobSummary, RoomDetail } from "@dovsky/protocol";
import { FixtureDaemon as DovskyDaemon, removeFixtureTree } from './__fixtures__/runtime-isolation.js';
import type { DaemonConfig } from "./config.js";
import { compareScenarios, parseScenarios, resolveEvaluation } from "./evaluation.js";
import type { EvaluationSpec } from "./model.js";
import { prepareEvaluationTree } from "./evaluation-tree.js";
import { fontFixture } from "./__fixtures__/font.js";

const fixture = new URL("./__fixtures__/provider.js", import.meta.url).pathname;
function harness(reply = "VERDICT: APPROVED", scenario = 'readFileSync(resolve(target,"tracked.txt"),"utf8")==="baseline\\n"') {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-evaluation-test-"));
  const project = resolve(root, "project");
  mkdirSync(project);
  const git = (...args: string[]) => { const r = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
  git("init", "-q"); git("config", "user.email", "eval@example.invalid"); git("config", "user.name", "Evaluation");
  writeFileSync(resolve(project, ".gitignore"), "node_modules\ndist/\n");
  writeFileSync(resolve(project, "package.json"), '{"name":"evaluation-fixture","version":"1.0.0","type":"module","dependencies":{"typescript":"file:packages/typescript"}}');
  writeFileSync(resolve(project, "package-lock.json"), '{"name":"evaluation-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"evaluation-fixture","version":"1.0.0","dependencies":{"typescript":"file:packages/typescript"}},"node_modules/typescript":{"resolved":"packages/typescript","link":true},"packages/typescript":{"version":"1.0.0","bin":{"tsc":"cli"}}}}');
  mkdirSync(resolve(project, "packages/typescript"), { recursive: true });
  writeFileSync(resolve(project, "packages/typescript/package.json"), '{"name":"typescript","version":"1.0.0","bin":{"tsc":"cli"}}');
  writeFileSync(resolve(project, "packages/typescript/cli"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(resolve(project, "tracked.txt"), "baseline\n");
  writeFileSync(resolve(project, "runner.mjs"), `import {readFileSync,existsSync} from "node:fs"; import {resolve} from "node:path"; const target=process.argv[2]; console.log(JSON.stringify({scenarios:[{id:"behavior",passed:${scenario},detail:"fixture outcome",durationMs:1}]}));`);
  // A second project uses an exact local dependency tree; never expose Dovsky's own installation.
  mkdirSync(resolve(project, "node_modules/.bin"), { recursive: true });
  mkdirSync(resolve(project, "node_modules/typescript"));
  writeFileSync(resolve(project, "node_modules/typescript/package.json"), '{"name":"typescript","version":"1.0.0","bin":{"tsc":"cli"}}');
  writeFileSync(resolve(project, "node_modules/typescript/cli"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(resolve(project, "node_modules/.bin/tsc"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  git("add", "."); git("commit", "-qm", "baseline");
  const config: DaemonConfig = {
    socketPath: resolve(root, "bus.sock"), databasePath: resolve(root, "state/bus.db"), artifactDirectory: resolve(root, "artifacts"),
    maxActive: 1,
    projects: [{ id: "eval", name: "Evaluation", path: project, workflows: [
      { id: "change", name: "Change", readOnly: false, qualityCommands: [[process.execPath, "-e", "process.exit(0)"]], evaluation: { enabled: true, defaultLevel: "medium", runner: "runner.mjs" }, review: { enabled: true, provider: "other", tier: "hard", maxCorrections: 0, small: { maxFiles: 3, maxLines: 150, tier: "routine" } }, providers: { codex: { argv: [process.execPath, fixture, "edit"] }, claude: { argv: [process.execPath, fixture, "edit"] } } },
      { id: "review", name: "Review", readOnly: true, qualityCommands: [], providers: { claude: { argv: [process.execPath, fixture, "verdict", reply] }, codex: { argv: [process.execPath, fixture, "verdict", reply] } } },
    ] }],
  };
  const daemon = new DovskyDaemon(config);
  const call = <T = unknown>(method: string, params: Record<string, unknown> = {}) => daemon.call(method, params, randomUUID()) as Promise<T>;
  const send = (params: Record<string, unknown> = {}) => call<{ roomId: string; jobIds: string[] }>("rooms.create", { title: "Evaluation", projectId: "eval", workflowId: "change", prompt: "Create changed.txt", recipients: ["codex"], force: true, acceptance: { criteria: ["The changed file exists"] }, ...params });
  const wait = async (id: string, reviewed = true) => {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const job = await call<JobSummary>("jobs.get", { jobId: id });
      if (["failed", "cancelled"].includes(job.state) || job.state === "succeeded" && (!reviewed || Boolean(job.review?.verdict) || job.review?.state === "failed")) return job;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Evaluation job timed out");
  };
  const decide = (job: JobSummary, verdict = "accepted", checked = [0]) => call<JobSummary>("jobs.acceptance.record", { jobId: job.id, verdict, note: "Exercised the file behavior", checked, fingerprint: job.evaluation!.fingerprint, evidenceHash: job.evaluation!.evidenceHash });
  const close = async () => { await daemon.stop(); daemon.close(); removeFixtureTree(root); };
  return { root, project, config, daemon, call, send, wait, decide, close, git };
}

test("approved font identity is visible to hard review, retains human gating, and is revoked by policy drift", async () => {
  const h = harness();
  try {
    const workflow = h.config.projects[0]!.workflows[0]!;
    workflow.fontAssets = [fontFixture().approval];
    workflow.providers.codex!.argv = [process.execPath, fixture, "edit-font"];
    h.daemon.start();
    const sent = await h.send();
    const job = await h.wait(sent.jobIds[0]!);
    assert.equal(job.state, "succeeded");
    assert.equal(job.review?.verdict, "approved");
    assert.equal(job.review?.tier, "hard");
    assert.ok(job.evaluation?.evidenceHash);
    const evidence = readFileSync(h.daemon.database.evidencePath(job.id)!, "utf8");
    assert.match(evidence, /operator-pinned-font-identity-v1/);
    assert.match(evidence, /status: COMPLETE/);
    const check = () => h.call<{ accepted: boolean; problems: string[] }>("jobs.acceptance.check", { jobId: job.id });
    assert.equal((await check()).accepted, false);
    assert.ok((await check()).problems.includes("Human acceptance checklist required"));
    await h.decide(job); // Synthetic test-only attestation, never a production record.
    assert.equal((await check()).accepted, true);
    workflow.fontAssets = [];
    assert.ok((await check()).problems.includes("Font approval policy changed; run a new evaluated job"));
    assert.equal((await check()).accepted, false);
  } finally { await h.close(); }
});

test("font approval is frozen before the provider runs, not adopted from later configuration", async () => {
  const h = harness();
  try {
    const workflow = h.config.projects[0]!.workflows[0]!;
    workflow.providers.codex!.argv = [process.execPath, fixture, "edit-font-delayed"];
    h.daemon.start();
    const sent = await h.send();
    let privateFont: string | null = null;
    for (let tries = 0; tries < 200 && !privateFont; tries++) {
      const privateRepo = h.daemon.fixturePrivateRepository(sent.jobIds[0]!);
      if (privateRepo && existsSync(resolve(privateRepo, "fixture.woff2"))) privateFont = resolve(privateRepo, "fixture.woff2");
      else await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(privateFont, 'provider did not create the font in its private repository');
    assert.equal(existsSync(resolve(h.project, "fixture.woff2")), false, 'canonical application happened before the policy-drift test');
    workflow.fontAssets = [fontFixture().approval];
    const job = await h.wait(sent.jobIds[0]!);
    assert.deepEqual(JSON.parse(readFileSync(resolve(h.root, "artifacts", "jobs", job.id, "font-policy.json"), "utf8")), []);
    assert.equal(job.evaluation?.evidenceHash, null);
    assert.equal((await h.call<{ accepted: boolean }>("jobs.acceptance.check", { jobId: job.id })).accepted, false);
  } finally { await h.close(); }
});

test("a worker cannot approve its own binary through a repository manifest", async () => {
  const h = harness();
  try {
    h.config.projects[0]!.workflows[0]!.providers.codex!.argv = [process.execPath, fixture, "edit-font"];
    writeFileSync(resolve(h.project, "font-policy.json"), JSON.stringify([fontFixture().approval]));
    h.daemon.start();
    const sent = await h.send();
    const job = await h.wait(sent.jobIds[0]!);
    assert.equal(job.evaluation?.evidenceHash, null);
    assert.match(readFileSync(h.daemon.database.evidencePath(job.id)!, "utf8"), /INCOMPLETE \(binary: fixture.woff2/);
    assert.equal((await h.call<{ accepted: boolean }>("jobs.acceptance.check", { jobId: job.id })).accepted, false);
  } finally { await h.close(); }
});

test("new medium work requires criteria; low needs justification; legacy work stays unevaluated", async () => {
  const h = harness();
  try {
    await assert.rejects(h.send({ acceptance: { criteria: [] } }), /acceptance criteria/);
    await assert.rejects(h.send({ evalLevel: "low" }), /eval-reason/);
    await assert.rejects(h.send({ review: "none" }), /cannot be disabled/);
    await assert.rejects(h.send({ reviewTier: "quick" }), /hard or frontier/);
    const low = await h.send({ evalLevel: "low", evalReason: "Bounded mechanical edit", review: "none" });
    assert.equal((await h.call<RoomDetail>("rooms.get", { roomId: low.roomId })).room.needsAttention, false);
    assert.equal((await h.call<{ items: unknown[] }>("rooms.list", { status: "attention" })).items.length, 0);
    h.daemon.start();
    const job = await h.wait(low.jobIds[0]!, false);
    assert.equal(job.evaluation?.state, "accepted");
    assert.equal(job.evaluation?.report, null);
    assert.equal((await h.call<{ accepted: boolean }>("jobs.acceptance.check", { jobId: job.id })).accepted, true);
    h.config.projects[0]!.workflows[0]!.evaluation!.enabled = false;
    const legacy = await h.send({ acceptance: undefined });
    assert.equal((await h.wait(legacy.jobIds[0]!)).evaluation, null);
  } finally { await h.close(); }
});

test("decision-only controls and their ACK preserve exact candidate acceptance without a new audit", async () => {
  const h = harness();
  try {
    h.daemon.start();
    const created = await h.send({ evalLevel: "low", evalReason: "Bounded fixture", review: "none" });
    const job = await h.wait(created.jobIds[0]!, false);
    const artifactDir = resolve(h.root, "build");
    mkdirSync(artifactDir);
    writeFileSync(resolve(artifactDir, "artifact.txt"), "Frozen artifact fixture");
    const head = spawnSync("git", ["-C", h.project, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const candidate = await h.call<{ id: string }>("releases.candidates.register", { taskId: job.taskId, roomId: job.roomId, sourceJobId: job.id, cwd: h.project, baseCommit: head, artifactDir, evidenceHash: job.evaluation!.evidenceHash });
    const decision = await h.call<{ id: string }>("tasks.controls.create", { taskId: job.taskId, kind: "decision", body: "Release permission will be recorded separately; tests are not claimed" });
    assert.equal((await h.call<{ accepted: boolean }>("jobs.acceptance.check", { jobId: job.id })).accepted, true);
    await h.call("releases.candidates.verify", { candidateId: candidate.id });
    await h.call("tasks.checkpoint", { taskId: job.taskId, jobId: job.id });
    await h.call("tasks.controls.ack", { taskId: job.taskId, jobId: job.id, controlIds: [decision.id] });
    assert.equal(h.daemon.coordination.get(job.taskId!).controls[0]!.acknowledgmentActor, "coordinator");
    await assert.rejects(h.call("tasks.resume", { taskId: job.taskId }), /Task is completed/);
    assert.equal(h.daemon.database.countQueued(), 0);
    await h.call("tasks.controls.create", { taskId: job.taskId, kind: "pause", body: "Hold release actions" });
    await assert.rejects(h.call("releases.candidates.verify", { candidateId: candidate.id }), /paused/);
    await h.call("tasks.controls.create", { taskId: job.taskId, kind: "resume", body: "Release hold lifted; permission is still separate" });
    await h.call("releases.candidates.verify", { candidateId: candidate.id });
    await h.call("tasks.controls.create", { taskId: job.taskId, kind: "instruction", body: "Make a substantive correction" });
    assert.equal((await h.call<{ accepted: boolean }>("jobs.acceptance.check", { jobId: job.id })).accepted, false);
  } finally { await h.close(); }
});

test("an unreconstructable low-risk review baseline preserves work but blocks acceptance", async () => {
  const h = harness();
  try {
    symlinkSync("tracked.txt", resolve(h.project, "untracked-link"));
    h.daemon.start();
    const created = await h.send({ evalLevel: "low", evalReason: "Bounded fixture", review: "none" });
    const job = await h.wait(created.jobIds[0]!, false);
    assert.equal(job.state, "succeeded", job.failure?.summary);
    assert.equal(job.evaluation?.state, "blocked");
    assert.equal((await h.call<{ accepted: boolean }>("jobs.acceptance.check", { jobId: job.id })).accepted, false);
    assert.ok(h.daemon.database.getJob(job.id)?.result);
    const evidence = readFileSync(h.daemon.database.evidencePath(job.id)!, "utf8");
    assert.match(evidence, /status: INCOMPLETE/);
    assert.match(evidence, /INCOMPLETE original-room review/);
    assert.match(evidence, /### changed\.txt \(added\)/);
  } finally { await h.close(); }
});

test("medium runs isolated scenarios and hard review; human checklist gates acceptance independently of grades", async () => {
  const h = harness();
  try {
    h.daemon.start();
    const created = await h.send();
    const job = await h.wait(created.jobIds[0]!);
    assert.equal(job.state, "succeeded", job.failure?.summary);
    assert.equal(job.review?.tier, "hard");
    assert.equal(job.evaluation?.report?.candidate[0]?.passed, true);
    assert.equal(job.evaluation?.state, "pending");
    assert.equal((await h.call<{ items: unknown[] }>("rooms.list", { status: "attention" })).items.length, 1);
    await h.call("jobs.grade", { jobId: job.id, grade: "good" });
    assert.equal((await h.call<{ accepted: boolean }>("jobs.acceptance.check", { jobId: job.id })).accepted, false);
    await assert.rejects(h.decide(job, "accepted", []), /every human acceptance criterion/);
    assert.equal((await h.decide(job, "rejected", [])).evaluation?.state, "rejected");
    assert.equal((await h.decide(job)).evaluation?.state, "accepted");
    assert.equal((await h.call<{ accepted: boolean }>("jobs.acceptance.check", { jobId: job.id })).accepted, true);
    const detail = await h.call<RoomDetail>("rooms.get", { roomId: created.roomId });
    assert.equal(detail.room.needsAttention, false);
    assert.equal((await h.call<{ items: unknown[] }>("rooms.list", { status: "attention" })).items.length, 0);
    assert.equal((await h.call<{ items: unknown[] }>("rooms.list", { status: "completed" })).items.length, 1);
    const evidence = readFileSync(h.daemon.database.evidencePath(job.id)!, "utf8");
    assert.match(evidence, /Acceptance criteria/);
    assert.match(evidence, /fixture outcome/);
    writeFileSync(resolve(h.project, "changed.txt"), "Changed after testing");
    const stale = await h.call<{ accepted: boolean; problems: string[] }>("jobs.acceptance.check", { jobId: job.id });
    assert.equal(stale.accepted, false);
    assert.match(stale.problems.join(" "), /working tree changed/);
    await assert.rejects(h.decide(job), /working tree changed/);
  } finally { await h.close(); }
});

test("a backend-only dependency layout is isolated and frozen for continuations", async () => {
  const h = harness("VERDICT: APPROVED", 'existsSync(resolve(target,"backend/node_modules/typescript/package.json")) && !existsSync(resolve(target,"node_modules"))');
  try {
    mkdirSync(resolve(h.project, "backend"));
    renameSync(resolve(h.project, "node_modules"), resolve(h.project, "backend/node_modules"));
    const policy = h.config.projects[0]!.workflows[0]!.evaluation!;
    policy.dependencyRoots = ["backend/node_modules"];
    const created = await h.send();
    const contract = h.daemon.database.getJob(created.jobIds[0]!)!.evaluation!;
    policy.dependencyRoots = ["node_modules"];
    assert.deepEqual(resolveEvaluation({}, h.config.projects[0]!.workflows[0]!, h.project, contract)?.dependencyRoots, ["backend/node_modules"]);
    h.daemon.start();
    const job = await h.wait(created.jobIds[0]!);
    assert.equal(job.state, "succeeded", job.failure?.summary);
    assert.equal(job.evaluation?.report?.candidate[0]?.passed, true);
  } finally { await h.close(); }
});

test("scoped dependency installation populates a private cache and an offline job reuses it", async () => {
  const h = harness();
  try {
    rmSync(resolve(h.project, "node_modules"), { recursive: true });
    const workflow = h.config.projects[0]!.workflows[0]!;
    workflow.providers.codex!.argv = [process.execPath, fixture, "dependency-check"];
    h.daemon.start();
    const params = { evalLevel: "low", evalReason: "Dependency cache fixture", review: "none" };
    const created = await h.send(params);
    const first = await h.wait(created.jobIds[0]!, false);
    assert.equal(first.state, "succeeded", first.failure?.summary);
    assert.match(h.daemon.database.getJob(first.id)!.result ?? '', /dependency available/);
    assert.equal(existsSync(resolve(h.project, "node_modules")), false);
    const installs = (jobId: string) => h.daemon.database.db.prepare(
      "SELECT state FROM execution_leases WHERE job_id=? AND command_kind='bench' AND command_number>=2000000000 ORDER BY prepared_at",
    ).all(jobId).map(row => String(row.state));
    assert.deepEqual(installs(first.id), ['exited']);

    workflow.sandbox = { network: false };
    const repeated = await h.send(params);
    const second = await h.wait(repeated.jobIds[0]!, false);
    assert.equal(second.state, "succeeded", second.failure?.summary);
    assert.match(h.daemon.database.getJob(second.id)!.result ?? '', /dependency available/);
    assert.deepEqual(installs(second.id), []);
    assert.equal(existsSync(resolve(h.project, "node_modules")), false);

    removeFixtureTree(resolve(h.root, 'dependency-cache'));
    const missing = await h.send(params);
    const third = await h.wait(missing.jobIds[0]!, false);
    assert.equal(third.state, 'failed');
    assert.equal(third.failure?.code, 'gate_broken');
    assert.match(third.failure?.summary ?? '', /network-disabled dependency cache miss/);
  } finally { await h.close(); }
});

test("nested evaluation trees remap workspace binaries before their build output exists", async () => {
  const h = harness();
  try {
    rmSync(resolve(h.project, "node_modules"), { recursive: true });
    mkdirSync(resolve(h.project, "node_modules/.bin"), { recursive: true });
    mkdirSync(resolve(h.project, "node_modules/@local"));
    mkdirSync(resolve(h.project, "packages/tool"), { recursive: true });
    writeFileSync(resolve(h.project, "packages/tool/package.json"), '{"name":"@local/tool"}');
    h.git("add", "packages/tool/package.json"); h.git("commit", "-qm", "workspace package");
    symlinkSync("../../packages/tool", resolve(h.project, "node_modules/@local/tool"));
    symlinkSync("../@local/tool/dist/cli.js", resolve(h.project, "node_modules/.bin/tool"));
    const alias = resolve(h.root, "project-alias");
    symlinkSync(h.project, alias);
    const first = resolve(h.root, "first");
    const second = resolve(h.root, "second");
    prepareEvaluationTree(alias, first, "HEAD", Buffer.alloc(0), [], alias);
    prepareEvaluationTree(first, second, "HEAD", Buffer.alloc(0), [], first);
    assert.equal(readlinkSync(resolve(second, "node_modules/.bin/tool")), resolve(second, "packages/tool/dist/cli.js"));
  } finally { await h.close(); }
});

test("red-before receives dependency binaries and retains the original new tests on followup", async () => {
  const h = harness("VERDICT: APPROVED", "true");
  try {
    mkdirSync(resolve(h.project, "backend"));
    renameSync(resolve(h.project, "node_modules"), resolve(h.project, "backend/node_modules"));
    const workflow = h.config.projects[0]!.workflows[0]!;
    workflow.evaluation!.dependencyRoots = ["backend/node_modules"];
    workflow.providers.codex!.argv = [process.execPath, fixture, "fix"];
    writeFileSync(resolve(h.project, "tracked.txt"), "dirty original\n");
    writeFileSync(resolve(h.project, "original-note.txt"), "pre-existing\n");
    h.daemon.start();
    const created = await h.send({ verify: "node test/tracked.test.mjs", redBefore: "test -x backend/node_modules/.bin/tsc && test -f original-note.txt && node -p \"require('node:fs').readFileSync('tracked.txt','utf8')\" && node test/tracked.test.mjs" });
    const first = await h.wait(created.jobIds[0]!);
    assert.equal(first.state, "succeeded", first.failure?.summary);
    writeFileSync(resolve(h.project, "tracked.txt"), "baseline\n");
    writeFileSync(resolve(h.project, "test/operator.test.mjs"), 'throw new Error("unrelated operator test");');
    h.git("add", "test/operator.test.mjs"); h.git("commit", "-qm", "unrelated operator test");
    writeFileSync(resolve(h.project, "test/untracked-operator.test.mjs"), 'throw new Error("unrelated untracked test");');
    const next = await h.call<{ jobIds: string[] }>("messages.create", { roomId: created.roomId, recipient: "codex", body: "Correct again", force: true });
    const second = await h.wait(next.jobIds[0]!);
    assert.equal(second.state, "succeeded", second.failure?.summary);
    const room = await h.call<RoomDetail>("rooms.get", { roomId: created.roomId });
    const proofs = room.checks.filter((check) => check.state === "passed" && check.summary?.startsWith("Red at "));
    assert.equal(proofs.length, 2);
    for (const proof of proofs) assert.doesNotMatch(proof.summary!, /operator\.test/);
    const proofLog = readFileSync(resolve(h.config.artifactDirectory, "jobs", first.id, "proof-1.jsonl"), "utf8");
    assert.match(proofLog, /dirty original/);
    const review = readFileSync(h.daemon.database.evidencePath(second.id)!, "utf8");
    assert.match(review, /original room snapshot/);
    assert.match(review, /### test\/tracked\.test\.mjs \(added\)/);
    assert.match(review, /-dirty original/);
    assert.ok(second.review?.jobId);
    const reviewer = h.daemon.database.getJob(second.review.jobId)!;
    assert.ok(reviewer.result, JSON.stringify(reviewer));
    assert.match(reviewer.result, /tracked=dirty original/);
  } finally { await h.close(); }
});

test("a failed gate still preserves room-owned regression tests and full implementation review", async () => {
  const h = harness("VERDICT: APPROVED", "true");
  try {
    h.config.projects[0]!.workflows[0]!.providers.codex!.argv = [process.execPath, fixture, "fix"];
    h.daemon.start();
    const created = await h.send({ verify: "test -f ready.txt && node test/tracked.test.mjs", redBefore: "node test/tracked.test.mjs" });
    const first = await h.wait(created.jobIds[0]!);
    assert.equal(first.state, "failed");
    writeFileSync(resolve(h.project, "ready.txt"), "ready");
    const next = await h.call<{ jobIds: string[] }>("messages.create", { roomId: created.roomId, recipient: "codex", body: "Retry the same verification", force: true });
    const second = await h.wait(next.jobIds[0]!);
    assert.equal(second.state, "succeeded", second.failure?.summary);
    const evidence = readFileSync(h.daemon.database.evidencePath(second.id)!, "utf8");
    assert.match(evidence, /### test\/tracked\.test\.mjs \(added\)/);
    assert.match(evidence, /-baseline/);
    assert.match(evidence, /\+fixed/);
  } finally { await h.close(); }
});

test("high comparisons preserve dirty baselines and declared failures; corrections require fresh acceptance", async () => {
  const h = harness("VERDICT: APPROVED", 'existsSync(resolve(target,"changed.txt")) && !existsSync(resolve(target,"tracked.txt")) && readFileSync(resolve(target,"preexisting.txt"),"utf8")==="dirty"');
  try {
    rmSync(resolve(h.project, "tracked.txt"));
    writeFileSync(resolve(h.project, "preexisting.txt"), "dirty");
    h.daemon.start();
    const created = await h.send({ evalLevel: "high", acceptance: { criteria: ["The changed file exists"], expectedBaselineFailures: ["behavior"] } });
    const job = await h.wait(created.jobIds[0]!);
    assert.equal(job.state, "succeeded", job.failure?.summary);
    assert.equal(job.evaluation?.report?.baseline?.[0]?.passed, false);
    assert.equal(job.evaluation?.report?.candidate[0]?.passed, true);
    await h.decide(job, "rejected", []);
    for (const params of [{ evalLevel: "low", evalReason: "Skip" }, { acceptance: { criteria: [], expectedBaselineFailures: ["behavior"] } }, { review: "none" }, { verify: "true" }]) {
      await assert.rejects(h.call("messages.create", { roomId: created.roomId, recipient: "claude", body: "Fix", force: true, ...params }));
    }
    const next = await h.call<{ jobIds: string[] }>("messages.create", { roomId: created.roomId, recipient: "codex", body: "Correct the rejected work", force: true });
    const pending = await h.call<JobSummary>("jobs.get", { jobId: next.jobIds[0] });
    assert.equal(pending.evaluation?.decision, null);
    assert.equal(pending.evaluation?.level, "high");
    assert.equal((await h.call<{ accepted: boolean }>("jobs.acceptance.check", { jobId: job.id })).accepted, false);
    const corrected = await h.wait(next.jobIds[0]!);
    assert.equal(corrected.state, "succeeded", corrected.failure?.summary);
    assert.equal(corrected.evaluation?.report?.baseline?.[0]?.passed, false);
    assert.equal((await h.decide(corrected)).evaluation?.state, "accepted");
  } finally { await h.close(); }
});

test("human acceptance can explicitly submit routing feedback without inferring a grade", async () => {
  const h = harness();
  try {
    h.daemon.start();
    const created = await h.send();
    const job = await h.wait(created.jobIds[0]!);
    const body = { jobId: job.id, verdict: "rejected", note: "Synthetic operator observed a model defect", checked: [], fingerprint: job.evaluation!.fingerprint, evidenceHash: job.evaluation!.evidenceHash };
    await assert.rejects(h.call("jobs.acceptance.record", { ...body, routingGrade: "invalid" }), /routingGrade/);
    assert.equal(h.daemon.database.getJob(job.id)!.acceptanceDecision, null);
    const rejected = await h.call<JobSummary>("jobs.acceptance.record", { ...body, routingGrade: "bad" });
    assert.equal(rejected.grade, "bad");
    assert.equal(rejected.gradeSource, "human");
    assert.equal(rejected.evaluation?.state, "rejected");
    const accepted = await h.call<JobSummary>("jobs.acceptance.record", { ...body, verdict: "accepted", checked: [0], routingGrade: "good" });
    assert.equal(accepted.grade, "good");
    assert.equal(accepted.evaluation?.state, "accepted");
    // An environment-related rejection must not silently overwrite model feedback.
    const ungraded = await h.call<JobSummary>("jobs.acceptance.record", { ...body, routingGrade: null });
    assert.equal(ungraded.grade, "good");
  } finally { await h.close(); }
});

test("medium to high keeps the original pre-change baseline", async () => {
  const h = harness();
  try {
    writeFileSync(resolve(h.project, "runner.mjs"), 'import {existsSync} from "node:fs"; import {resolve} from "node:path"; console.log(JSON.stringify({scenarios:[{id:"behavior",passed:true,detail:existsSync(resolve(process.argv[2],"changed.txt"))?"after":"before",durationMs:1}]}));');
    h.daemon.start();
    const created = await h.send();
    assert.equal((await h.wait(created.jobIds[0]!)).state, "succeeded");
    const raised = await h.call<{ jobIds: string[] }>("messages.create", { roomId: created.roomId, recipient: "codex", body: "Verify at high risk", force: true, evalLevel: "high" });
    const job = await h.wait(raised.jobIds[0]!);
    assert.equal(job.state, "succeeded", job.failure?.summary);
    assert.equal(job.evaluation?.report?.baseline?.[0]?.detail, "before");
    assert.equal(job.evaluation?.report?.candidate[0]?.detail, "after");
    assert.equal(h.daemon.database.getJob(job.id)!.evaluation!.baselineJobId, created.jobIds[0]);
  } finally { await h.close(); }
});

test("inconclusive and malformed reviews block acceptance", async () => {
  for (const reply of ["VERDICT: INCONCLUSIVE", "not a verdict"]) {
    const h = harness(reply);
    try {
      h.daemon.start();
      const created = await h.send({ evalLevel: "low", evalReason: "Mechanical edit" });
      const job = await h.wait(created.jobIds[0]!);
      assert.equal(job.evaluation?.state, "blocked");
      await assert.rejects(h.decide(job), /Model review/);
    } finally { await h.close(); }
  }
});

test("scenario reports reject omissions and regressions instead of treating missing evidence as a pass", () => {
  assert.throws(() => parseScenarios('{"scenarios":[]}'));
  assert.throws(() => parseScenarios('{"scenarios":[{"id":"x","passed":true}]}'));
  const s = (id: string, passed: boolean) => ({ id, passed, detail: "", durationMs: 1 });
  const spec = { level: "high" as EvaluationLevel, runnerHash: "frozen", expectedBaselineFailures: [] } as unknown as EvaluationSpec;
  assert.match(compareScenarios(spec, [s("x", false)], [s("x", true)]).problems.join(), /Candidate failed/);
  assert.match(compareScenarios(spec, [s("x", true)], [s("y", true)]).problems.join(), /sets differ/);
  assert.match(compareScenarios(spec, [s("x", true)], null).problems.join(), /missing/);
  assert.match(compareScenarios(spec, [s("x", true)], [s("x", false)]).problems.join(), /Unexpected baseline failure/);
});

test("handoffs and retries of older jobs retain the latest room acceptance contract", async () => {
  const h = harness();
  try {
    const first = await h.send({ evalLevel: "low", evalReason: "Mechanical edit", review: "none" });
    const oldId = first.jobIds[0]!;
    h.daemon.database.transitionJob(oldId, ["queued"], "starting");
    h.daemon.database.transitionJob(oldId, ["starting"], "running");
    h.daemon.database.transitionJob(oldId, ["running"], "succeeded", { result: "Old result" });
    const raised = await h.call<{ jobIds: string[] }>("messages.create", { roomId: first.roomId, recipient: "codex", body: "Broader behavior", force: true, evalLevel: "high", review: "other", acceptance: { criteria: ["The changed file exists", "Cancellation works"] } });
    const contract = h.daemon.database.getJob(raised.jobIds[0]!)!;
    assert.throws(() => resolveEvaluation({}, h.config.projects[0]!.workflows[1]!, h.project, contract.evaluation), /cannot replace an evaluated room/);
    const handoff = await h.call<{ jobId: string }>("handoffs.create", { sourceJobId: oldId, targetProvider: "claude", instruction: "Continue", force: true });
    await h.call("jobs.grade", { jobId: oldId, grade: "bad" });
    const retry = await h.call<{ jobId: string }>("jobs.retry", { jobId: oldId, force: true });
    for (const id of [handoff.jobId, retry.jobId]) {
      const job = h.daemon.database.getJob(id)!;
      assert.deepEqual(job.evaluation, contract.evaluation);
      assert.deepEqual(job.gates, contract.gates);
      assert.deepEqual(job.review, contract.review);
    }
    for (const [method, params] of [["handoffs.create", { sourceJobId: oldId, targetProvider: "claude", instruction: "Weaken" }], ["jobs.retry", { jobId: oldId }]] as const) {
      await assert.rejects(h.call(method, { ...params, force: true, evalLevel: "low", evalReason: "Skip" }), /cannot weaken/);
      await assert.rejects(h.call(method, { ...params, force: true, review: "none" }), /cannot be disabled/);
    }
    assert.equal((await h.call<RoomDetail>("rooms.get", { roomId: first.roomId })).room.evaluation?.level, "high");
  } finally { await h.close(); }
});
