import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { GrantReleaseAuthorization, ReleaseCommandResult } from "@dovsky/protocol";
import { DovskyDatabase } from "./database.js";
import { createCommandReleaseAdapter, RELEASE_SCHEMA_SQL, ReleaseService, type ReleaseAdapter, type ReleaseServiceOptions } from "./releases.js";
import { confirmScopeGone, observeScope, signalScope } from "./execution-scope.js";
import { readProcessIdentity } from "./execution-lease.js";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolvePromise = accept; });
  return { promise, resolve: resolvePromise };
}

async function harness(overrides: Partial<ReleaseAdapter> = {}, runner?: ReleaseServiceOptions["runCommand"], verifyInitially = true) {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-releases-"));
  const cwd = resolve(root, "source");
  const output = resolve(root, "build");
  const remote = resolve(root, "remote-state");
  mkdirSync(cwd);
  mkdirSync(output);
  writeFileSync(resolve(cwd, "app.txt"), "baseline");
  writeFileSync(resolve(cwd, "config.json"), '{"binding":"test"}');
  writeFileSync(resolve(cwd, "001.sql"), "CREATE TABLE example(id INTEGER);");
  writeFileSync(resolve(output, "index.html"), "<p>approved artifact</p>");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "release-test@example.invalid");
  git(cwd, "config", "user.name", "Release Test");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "baseline");
  const db = new DovskyDatabase(resolve(root, "state.db"));
  db.db.exec(RELEASE_SCHEMA_SQL);
  const roomId = randomUUID();
  const jobId = randomUUID();
  const taskId = randomUUID();
  db.createRoom(roomId, "Release fixture", "test", "change");
  db.createJob({ id: jobId, roomId, provider: "codex", projectId: "test", workflowId: "change", prompt: "Fixture only" }, randomUUID());
  let accepted = true;
  const adapter: ReleaseAdapter = {
    id: "test-deploy", action: "deploy", target: "fixture:production",
    command: ({ candidate, operation }) => ({ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],process.argv[2])", remote, operation.id], cwd: candidate.artifactDir }),
    preflight: async ({ operation }) => { assert.equal(operation.expectedBefore, "baseline"); },
    readback: async ({ operation }) => ({ state: existsSync(remote) && readFileSync(remote, "utf8") === operation.id ? "verified" : "not_applied", detail: "Observed fixture state", settled: true }),
    ...overrides,
  };
  const options: ReleaseServiceOptions = {
    artifactDirectory: resolve(root, "artifacts"),
    currentFingerprint: (path) => createHash("sha256").update(git(path, "rev-parse", "HEAD")).update(readFileSync(resolve(path, "app.txt")))
      .update(readFileSync(resolve(path, "config.json"))).update(readFileSync(resolve(path, "001.sql"))).digest("hex"),
    assertCandidateAccepted: (candidate) => { if (!accepted || candidate.sourceJobId !== jobId || candidate.evidenceHash !== "review-evidence-1") throw new Error("Human acceptance is missing or stale"); },
    adapters: [adapter], ...(runner ? { runCommand: runner } : {}),
  };
  const service = new ReleaseService(db, options);
  const input = { taskId, roomId, sourceJobId: jobId, cwd, baseCommit: git(cwd, "rev-parse", "HEAD"), artifactDir: output,
    evidenceHash: "review-evidence-1", configuration: { buildTool: "test-1", credentialVersion: "v3" }, configurationFiles: ["config.json"], migrationFiles: ["001.sql"] };
  const candidate = service.registerCandidate(input);
  const grantInput: GrantReleaseAuthorization = { taskId, roomId, repository: candidate.repository, actions: [adapter.action], targets: [adapter.target],
    instruction: "Publish this fixture after its checks pass", source: { reference: "fixture-user-message", actor: "operator" } };
  const grant = service.grantAuthorization(grantInput);
  const verifier: ReleaseAdapter = {
    id: "fixture-artifact-verifier", action: "verify", target: "fixture:artifact-verification",
    command: ({ candidate, operation }) => ({ argv: [process.execPath, "-e",
      "const fs=require('node:fs');const assert=require('node:assert/strict');assert.equal(fs.readFileSync(process.argv[1],'utf8'),'<p>approved artifact</p>');assert.equal(fs.readFileSync(process.argv[2],'utf8'),'baseline');fs.writeFileSync(process.argv[3],process.argv[4])",
      resolve(candidate.artifactDir, "index.html"), resolve(candidate.cwd, "app.txt"), resolve(root, "verification-proof"), operation.id], cwd: candidate.artifactDir }),
    preflight: async () => {},
    readback: async ({ operation }) => ({ state: existsSync(resolve(root, "verification-proof")) && readFileSync(resolve(root, "verification-proof"), "utf8") === operation.id ? "verified" : "not_applied", detail: "Compared fixture source and frozen artifact bytes", settled: true }),
  };
  // Verification itself executes the fixture checker; it is never fabricated from an approval record.
  const verificationService = new ReleaseService(db, { artifactDirectory: options.artifactDirectory, currentFingerprint: options.currentFingerprint,
    assertCandidateAccepted: options.assertCandidateAccepted, adapters: [verifier] });
  const verificationGrant = verificationService.grantAuthorization({ ...grantInput, actions: ["verify"], targets: [verifier.target], instruction: "Verify fixture source and built artifact" });
  const verify = async (candidateId: string) => {
    const operation = verificationService.prepareOperation({ candidateId, authorizationId: verificationGrant.id, adapterId: verifier.id, step: "artifact-proof", expectedBefore: "baseline" });
    const result = await verificationService.executeOperation(operation.id);
    assert.equal(result.state, "verified", JSON.stringify(result.readback));
    return result;
  };
  if (verifyInitially) await verify(candidate.id);
  const prepare = (step = "publish", candidateId = candidate.id) => service.prepareOperation({ candidateId, authorizationId: grant.id, adapterId: adapter.id, step, expectedBefore: "baseline" });
  return { root, cwd, output, remote, db, roomId, taskId, jobId, options, service, adapter, input, candidate, grantInput, grant, prepare, verify,
    setAccepted: (value: boolean) => { accepted = value; },
    cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("candidate registration copies exact built bytes and detects source, configuration, migration and artifact tampering", async () => {
  const value = await harness();
  try {
    assert.notEqual(value.candidate.artifactDir, value.output);
    writeFileSync(resolve(value.output, "index.html"), "later unrelated build");
    assert.equal(readFileSync(resolve(value.candidate.artifactDir, "index.html"), "utf8"), "<p>approved artifact</p>");
    assert.equal(value.service.verifyCandidate(value.candidate.id).id, value.candidate.id);
    writeFileSync(resolve(value.candidate.artifactDir, "index.html"), "tampered");
    assert.throws(() => value.service.verifyCandidate(value.candidate.id), /artifact.*changed/);
    writeFileSync(resolve(value.candidate.artifactDir, "index.html"), "<p>approved artifact</p>");
    writeFileSync(resolve(value.cwd, "config.json"), '{"binding":"different"}');
    assert.throws(() => value.service.verifyCandidate(value.candidate.id), /source changed/);
    writeFileSync(resolve(value.cwd, "config.json"), '{"binding":"test"}');
    writeFileSync(resolve(value.cwd, "001.sql"), "DROP TABLE example;");
    assert.throws(() => value.service.verifyCandidate(value.candidate.id), /source changed/);
  } finally { value.cleanup(); }
});

test("changing candidate configuration identity creates a new candidate and exact-candidate grants do not transfer", async () => {
  const value = await harness();
  try {
    const exact = value.service.grantAuthorization({ ...value.grantInput, candidateId: value.candidate.id });
    const next = value.service.registerCandidate({ ...value.input, configuration: { buildTool: "test-2", credentialVersion: "v3" } });
    assert.notEqual(next.id, value.candidate.id);
    assert.notEqual(next.configurationHash, value.candidate.configurationHash);
    assert.throws(() => value.service.prepareOperation({ candidateId: next.id, authorizationId: exact.id, adapterId: value.adapter.id, step: "publish", expectedBefore: "baseline" }), /outside scope/);
    await value.verify(next.id);
    assert.equal(value.prepare("publish", next.id).authorizationId, value.grant.id);
  } finally { value.cleanup(); }
});

test("snapshot rejects symlinks and acceptance cannot be supplied by permission metadata", async () => {
  const value = await harness();
  try {
    symlinkSync(resolve(value.cwd, "config.json"), resolve(value.output, "linked-config"));
    assert.throws(() => value.service.registerCandidate(value.input), /symbolic links/);
    value.setAccepted(false);
    assert.throws(() => value.prepare(), /acceptance/);
    assert.equal(value.service.getAuthorization(value.grant.id).source.authenticated, false);
    const claimedHuman = { ...value.grantInput, source: { reference: "agent-claimed-human", actor: "human", authenticated: true } };
    assert.equal(value.service.grantAuthorization(claimedHuman).source.authenticated, false);
  } finally { value.cleanup(); }
});

test("duplicate approval and operation delivery preserve a single semantic operation including operation-ID argv", async () => {
  const value = await harness();
  try {
    assert.equal(value.service.grantAuthorization(value.grantInput).id, value.grant.id);
    const first = value.prepare();
    assert.equal(value.prepare().id, first.id);
    assert.equal(value.service.listForTask(value.taskId).operations.filter((operation) => operation.action === "deploy").length, 1);
    const done = await value.service.executeOperation(first.id);
    assert.equal(done.state, "verified");
    assert.equal(done.attempts, 1);
    assert.equal(readFileSync(value.remote, "utf8"), first.id);
    assert.equal((await value.service.executeOperation(first.id)).attempts, 1);
    assert.throws(() => value.service.prepareOperation({ candidateId: value.candidate.id, authorizationId: value.grant.id,
      adapterId: value.adapter.id, step: "publish", expectedBefore: "different" }), /different intent/);
  } finally { value.cleanup(); }
});

test("a second release cannot own an unresolved target, including after service restart", async () => {
  const value = await harness();
  try {
    const first = value.prepare();
    assert.throws(() => value.prepare("competing"), /owned by another/);
    const restarted = new ReleaseService(value.db, value.options);
    assert.equal(restarted.recoverInterruptedOperations(), 0);
    assert.throws(() => restarted.prepareOperation({ candidateId: value.candidate.id, authorizationId: value.grant.id,
      adapterId: value.adapter.id, step: "competing", expectedBefore: "baseline" }), /owned by another/);
    assert.equal(restarted.getOperation(first.id).state, "prepared");
  } finally { value.cleanup(); }
});

test("approval revocation during an awaited preflight prevents dispatch and preserves revocation on replay", async () => {
  const entered = deferred<void>();
  const resume = deferred<void>();
  let commands = 0;
  const value = await harness({ preflight: async () => { entered.resolve(); await resume.promise; } }, async () => { commands += 1; return { exitCode: 0, signal: null, timedOut: false }; });
  try {
    const operation = value.prepare();
    const execution = value.service.executeOperation(operation.id);
    await entered.promise;
    value.service.revokeAuthorization(value.grant.id, "Stop this release");
    resume.resolve();
    await assert.rejects(execution, /revoked/);
    assert.equal(commands, 0);
    assert.notEqual(value.service.grantAuthorization(value.grantInput).revokedAt, null);
  } finally { value.cleanup(); }
});

test("cancellation racing preflight prevents dispatch", async () => {
  const entered = deferred<void>();
  const resume = deferred<void>();
  const value = await harness({ preflight: async () => { entered.resolve(); await resume.promise; } });
  try {
    const operation = value.prepare();
    const execution = value.service.executeOperation(operation.id);
    await entered.promise;
    value.service.cancelOperation(operation.id);
    resume.resolve();
    await assert.rejects(execution, /cancelled/);
    assert.equal(value.service.getOperation(operation.id).state, "cancelled");
    assert.equal(existsSync(value.remote), false);
  } finally { value.cleanup(); }
});

test("intent is durable before the fake external mutation and a lost response is reconciled without resubmission", async () => {
  let value!: Awaited<ReturnType<typeof harness>>;
  let submits = 0;
  value = await harness({}, async () => {
    submits += 1;
    const operation = value.service.listForTask(value.taskId).operations.find((item) => item.action === "deploy")!;
    const independent = new DovskyDatabase(resolve(value.root, "state.db"));
    try {
      assert.equal(independent.db.prepare("SELECT state FROM release_operations WHERE id=?").get(operation.id)?.state, "executing");
      assert.equal(independent.db.prepare("SELECT operation_id FROM release_targets").get()?.operation_id, operation.id);
    } finally { independent.close(); }
    writeFileSync(value.remote, operation.id);
    throw new Error("Reply lost after external success");
  });
  try {
    const operation = value.prepare();
    assert.equal((await value.service.executeOperation(operation.id)).state, "verified");
    assert.equal((await value.service.executeOperation(operation.id)).state, "verified");
    assert.equal(submits, 1);
  } finally { value.cleanup(); }
});

test("restart fences stale executor callbacks and retains target ownership until observed settlement", async () => {
  const entered = deferred<void>();
  const result = deferred<ReleaseCommandResult>();
  const value = await harness({ readback: async () => ({ state: "not_applied", detail: "No current version", settled: false }) }, async () => { entered.resolve(); return result.promise; });
  try {
    const operation = value.prepare();
    const execution = value.service.executeOperation(operation.id);
    await entered.promise;
    const restarted = new ReleaseService(value.db, value.options);
    assert.equal(restarted.recoverInterruptedOperations(), 1);
    assert.notEqual(restarted.getOperation(operation.id).ownerToken, operation.ownerToken);
    assert.equal((await restarted.reconcileOperation(operation.id)).state, "reconcile_required");
    assert.throws(() => value.prepare("competing"), /owned by another/);
    result.resolve({ exitCode: 0, signal: null, timedOut: false });
    await assert.rejects(execution, /superseded/);
    assert.equal(restarted.getOperation(operation.id).commandResult, null);
    const settled = new ReleaseService(value.db, { ...value.options, adapters: [{ ...value.adapter,
      readback: async () => ({ state: "not_applied", detail: "Target confirms no active request and no effect", settled: true }) }] });
    assert.equal((await settled.reconcileOperation(operation.id)).state, "not_applied");
    assert.equal(settled.retryOperation(operation.id).id, operation.id);
  } finally { value.cleanup(); }
});

test("cancellation during a partial migration records the checkpoint, stops subsequent steps and never kills or rolls back", async () => {
  const entered = deferred<void>();
  const result = deferred<ReleaseCommandResult>();
  let value!: Awaited<ReturnType<typeof harness>>;
  value = await harness({ action: "migrate", readback: async () => ({ state: "reconcile_required", detail: "Migration 001 committed; 002 incomplete" }) }, async () => {
    writeFileSync(value.remote, "001 committed");
    entered.resolve();
    return result.promise;
  });
  try {
    const operation = value.prepare("migrate");
    const execution = value.service.executeOperation(operation.id);
    await entered.promise;
    const cancellation = value.service.cancelOperation(operation.id);
    assert.equal(cancellation.state, "executing");
    assert.notEqual(cancellation.cancellationRequestedAt, null);
    assert.throws(() => value.prepare("later-deploy"), /revoked/);
    assert.equal(readFileSync(value.remote, "utf8"), "001 committed");
    result.resolve({ exitCode: 1, signal: null, timedOut: false });
    const uncertain = await execution;
    assert.equal(uncertain.state, "reconcile_required");
    assert.match(uncertain.readback!.detail, /001 committed/);
    assert.equal(value.db.db.prepare("SELECT operation_id FROM release_targets").get()?.operation_id, operation.id);
    await assert.rejects(value.service.executeOperation(operation.id), /reconciliation/);
  } finally { value.cleanup(); }
});

test("timeout cannot manufacture settlement or absence of future effects", async () => {
  const value = await harness({ readback: async () => ({ state: "verified", detail: "Version appears current", settled: false }) }, async () => ({ exitCode: null, signal: null, timedOut: true }));
  try {
    const operation = value.prepare();
    assert.equal((await value.service.executeOperation(operation.id)).state, "reconcile_required");
    assert.throws(() => value.service.retryOperation(operation.id), /proven absence/);
  } finally { value.cleanup(); }
});

test("fixed local command adapter checks predecessor output and parses explicit readback; argv is never RPC supplied", async () => {
  const value = await harness();
  try {
    const adapter = createCommandReleaseAdapter({ id: "configured", action: "deploy", target: "fixture:configured", cwd: "artifact",
      argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],process.argv[2])", value.remote, "{operationId}"],
      preflightArgv: [process.execPath, "-e", "process.stdout.write('baseline')"],
      readbackArgv: [process.execPath, "-e", "const fs=require('node:fs');process.stdout.write(JSON.stringify({state:fs.readFileSync(process.argv[1],'utf8')===process.argv[2]?'verified':'reconcile_required',detail:'Fixture version readback',settled:true}))", value.remote, "{operationId}"] });
    const service = new ReleaseService(value.db, { ...value.options, adapters: [adapter] });
    const grant = service.grantAuthorization({ ...value.grantInput, targets: [adapter.target] });
    const operation = service.prepareOperation({ candidateId: value.candidate.id, authorizationId: grant.id, adapterId: adapter.id, step: "configured", expectedBefore: "baseline" });
    assert.equal((await service.executeOperation(operation.id)).state, "verified");
    const stale = service.prepareOperation({ candidateId: value.candidate.id, authorizationId: grant.id, adapterId: adapter.id, step: "stale", expectedBefore: "old-remote" });
    await assert.rejects(service.executeOperation(stale.id), /predecessor changed/);
    assert.equal(service.getOperation(stale.id).state, "prepared");
    assert.throws(() => service.prepareOperation({ candidateId: value.candidate.id, authorizationId: grant.id, adapterId: "web-supplied-command", step: "arbitrary", expectedBefore: "baseline" }), /not configured locally/);
  } finally { value.cleanup(); }
});

test("source acceptance and permission cannot replace a verified artifact operation for this exact candidate", async () => {
  const value = await harness({}, undefined, false);
  try {
    assert.throws(() => value.prepare(), /verification operation must verify this exact candidate/);
    assert.equal(value.service.verifyCandidate(value.candidate.id).id, value.candidate.id);
    assert.throws(() => value.prepare(), /verification operation/);
    await value.verify(value.candidate.id);
    const next = value.service.registerCandidate({ ...value.input, configuration: { buildTool: "different" } });
    assert.throws(() => value.prepare("publish-next", next.id), /verification operation/);
    await value.verify(next.id);
    assert.equal(value.prepare("publish-next", next.id).state, "prepared");
  } finally { value.cleanup(); }
});

test("a wrong artifact cannot borrow accepted-source evidence when the configured provenance checker fails", async () => {
  const value = await harness({}, undefined, false);
  try {
    writeFileSync(resolve(value.output, "index.html"), "<p>different source output</p>");
    const wrong = value.service.registerCandidate(value.input);
    assert.equal(value.service.verifyCandidate(wrong.id).id, wrong.id);
    await assert.rejects(value.verify(wrong.id), /not_applied/);
    assert.throws(() => value.prepare("wrong-artifact", wrong.id), /verification operation/);
    assert.equal(existsSync(value.remote), false);
  } finally { value.cleanup(); }
});

test("artifact verification is rechecked after preflight and a vanished proof cannot authorize mutation", async () => {
  const entered = deferred<void>();
  const resume = deferred<void>();
  let commands = 0;
  const value = await harness({ preflight: async () => { entered.resolve(); await resume.promise; } }, async () => {
    commands += 1; return { exitCode: 0, signal: null, timedOut: false };
  });
  try {
    const operation = value.prepare();
    const execution = value.service.executeOperation(operation.id);
    await entered.promise;
    value.db.db.prepare("DELETE FROM release_operations WHERE json_extract(data_json,'$.action')='verify'").run();
    resume.resolve();
    await assert.rejects(execution, /verification operation/);
    assert.equal(commands, 0);
  } finally { value.cleanup(); }
});

test("a candidate rebase after approval prevents dispatch while preserving the scoped authorization", async () => {
  const value = await harness();
  try {
    const operation = value.prepare();
    git(value.cwd, "commit", "--allow-empty", "-qm", "new integration head");
    await assert.rejects(value.service.executeOperation(operation.id), /source changed/);
    assert.equal(value.service.getAuthorization(value.grant.id).revokedAt, null);
    assert.equal(existsSync(value.remote), false);
  } finally { value.cleanup(); }
});

test("zero exit status with explicitly unsettled readback remains unresolved", async () => {
  const value = await harness({ readback: async () => ({ state: "verified", detail: "Version is visible but background work remains", settled: false }) }, async () => ({ exitCode: 0, signal: null, timedOut: false }));
  try {
    const operation = value.prepare();
    const result = await value.service.executeOperation(operation.id);
    assert.equal(result.commandResult?.exitCode, 0);
    assert.equal(result.state, "reconcile_required");
    assert.throws(() => value.prepare("competing"), /owned by another/);
  } finally { value.cleanup(); }
});

test("an actual timed-out fixture command is allowed to settle and is not killed", async () => {
  const value = await harness();
  try {
    const adapter: ReleaseAdapter = { ...value.adapter, command: ({ candidate, operation }) => ({
      argv: [process.execPath, "-e", "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],process.argv[2]),100)", value.remote, operation.id], cwd: candidate.artifactDir, timeoutMs: 5,
    }), readback: async ({ operation }) => ({ state: existsSync(value.remote) && readFileSync(value.remote, "utf8") === operation.id ? "verified" : "reconcile_required", detail: "Fixture completion marker", settled: existsSync(value.remote) }) };
    const service = new ReleaseService(value.db, { ...value.options, adapters: [adapter] });
    const operation = service.prepareOperation({ candidateId: value.candidate.id, authorizationId: value.grant.id, adapterId: adapter.id, step: "timeout", expectedBefore: "baseline" });
    assert.equal((await service.executeOperation(operation.id)).state, "reconcile_required");
    const deadline = Date.now() + 2000;
    while (!existsSync(value.remote) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
    assert.equal(readFileSync(value.remote, "utf8"), operation.id);
    // The output marker precedes process teardown; settlement also needs exact scope absence.
    const scope = service.getOperation(operation.id).execution!;
    assert.equal(await confirmScopeGone({ scopeUnit: scope.scopeUnit, cgroupPath: scope.cgroupPath!,
      identity: { pid: scope.pid!, processGroup: scope.processGroup!, startTicks: scope.startTicks!, bootId: scope.bootId } }), true);
    assert.equal((await service.reconcileOperation(operation.id)).state, "verified");
  } finally { value.cleanup(); }
});

test("native release timeout persists gate identity before mutation and fences until exact scope absence", async () => {
  const value = await harness();
  let enrollment: Parameters<typeof observeScope>[0] | undefined;
  try {
    const adapter: ReleaseAdapter = { ...value.adapter, command: ({ candidate, operation }) => ({
      argv: [process.execPath, "-e", "const fs=require('node:fs');const db=new(require('node:sqlite').DatabaseSync)(process.argv[1]);const row=db.prepare('SELECT scope_unit,cgroup_path,pid,process_group,process_start_ticks,boot_id FROM release_operations WHERE id=?').get(process.argv[2]);db.close();fs.writeFileSync(process.argv[3],JSON.stringify({row,pid:process.pid,cgroup:fs.readFileSync('/proc/self/cgroup','utf8')}));setInterval(()=>{},1000)", resolve(value.root, "state.db"), operation.id, value.remote],
      cwd: candidate.artifactDir, timeoutMs: 250,
    }), readback: async () => ({ state: "verified", detail: "A visible remote result is not local scope settlement", settled: true }) };
    const service = new ReleaseService(value.db, { ...value.options, adapters: [adapter] });
    const operation = service.prepareOperation({ candidateId: value.candidate.id, authorizationId: value.grant.id, adapterId: adapter.id, step: "scoped-timeout", expectedBefore: "baseline" });
    const result = await service.executeOperation(operation.id);
    assert.equal(result.commandResult?.timedOut, true);
    const proof = JSON.parse(readFileSync(value.remote, "utf8"));
    assert.match(proof.row.scope_unit, /^dovsky-job-.*-release-1\.scope$/);
    assert.ok(proof.cgroup.includes(proof.row.cgroup_path));
    assert.ok(proof.row.pid > 0 && proof.row.process_group > 0);
    assert.match(proof.row.process_start_ticks, /^\d+$/);
    assert.ok(proof.row.boot_id);
    enrollment = { scopeUnit: proof.row.scope_unit, cgroupPath: proof.row.cgroup_path, identity: { pid: proof.row.pid, processGroup: proof.row.process_group, startTicks: proof.row.process_start_ticks, bootId: proof.row.boot_id } };
    assert.equal(observeScope(enrollment).state, "alive");
    assert.equal(result.state, "reconcile_required");
    assert.throws(() => value.prepare("competing"), /owned by another/);
    const restarted = new ReleaseService(value.db, { ...value.options, adapters: [adapter] });
    assert.equal((await restarted.reconcileOperation(operation.id)).state, "reconcile_required");
    assert.equal((await restarted.reconcileOperation(operation.id, "terminate")).state, "verified");
    assert.equal(await confirmScopeGone(enrollment), true);
  } finally {
    if (enrollment) { await signalScope(enrollment, "SIGKILL"); assert.equal(await confirmScopeGone(enrollment), true); }
    else if (existsSync(value.remote)) { try { process.kill(JSON.parse(readFileSync(value.remote, "utf8")).pid, "SIGKILL"); } catch { /* Already absent. */ } }
    value.cleanup();
  }
});

test("native read-only release check escalates stubborn child from TERM to KILL and confirms absence", async () => {
  const value = await harness();
  const marker = resolve(value.root, "read-child");
  try {
    const adapter = createCommandReleaseAdapter({ id: "stubborn-read", action: "deploy", target: value.adapter.target, cwd: "artifact",
      argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 250,
      preflightArgv: [process.execPath, "-e", "const fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(process.argv[1]+'.term','TERM'));fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,cgroup:fs.readFileSync('/proc/self/cgroup','utf8')}));setInterval(()=>{},1000)", marker],
      readbackArgv: [process.execPath, "-e", "process.exit(0)"] });
    const operation = value.prepare();
    await assert.rejects(adapter.preflight({ candidate: value.candidate, operation }), /timed out/);
    const proof = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(readFileSync(marker + ".term", "utf8"), "TERM");
    const path = proof.cgroup.trim().slice(3);
    assert.ok(!existsSync(resolve("/sys/fs/cgroup", "." + path, "cgroup.procs")) || readFileSync(resolve("/sys/fs/cgroup", "." + path, "cgroup.procs"), "utf8").trim() === "");
    // The empty cgroup proves termination; init may reap the exited orphan on its next turn.
    const deadline = Date.now() + 2000;
    while (readProcessIdentity(proof.pid) && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
    assert.equal(readProcessIdentity(proof.pid), null);
  } finally {
    if (existsSync(marker)) { try { process.kill(JSON.parse(readFileSync(marker, "utf8")).pid, "SIGKILL"); } catch { /* Already absent. */ } }
    value.cleanup();
  }
});

test("native release mutation keeps writing output after its actual executor is killed", async () => {
  const value = await harness({ readback: async () => ({ state: "not_applied", detail: "Fixture effect absent", settled: true }) });
  let enrollment: Parameters<typeof observeScope>[0] | undefined;
  let runner: ReturnType<typeof spawn> | undefined;
  try {
    value.adapter.command = ({ candidate }) => ({ argv: [process.execPath, "-e", `
      const fs=require('node:fs'), marker=process.argv[1];
      process.on('uncaughtExceptionMonitor',error=>fs.writeFileSync(marker+'.error',String(error)));
      fs.writeFileSync(marker,'ready');
      let ticks=0;
      setInterval(()=>{process.stdout.write('migration stdout\\n');process.stderr.write('migration stderr\\n');fs.writeFileSync(marker+'.ticks',String(++ticks));},30);
    `, value.remote], cwd: candidate.artifactDir, timeoutMs: 10_000 });
    const operation = value.prepare("executor-crash");
    const config = { databaseUrl: new URL("./database.js", import.meta.url).href, releasesUrl: new URL("./releases.js", import.meta.url).href,
      databasePath: resolve(value.root, "state.db"), artifactDirectory: value.options.artifactDirectory,
      fingerprint: value.candidate.sourceFingerprint, adapterId: value.adapter.id, action: value.adapter.action,
      target: value.adapter.target, command: value.adapter.command({ candidate: value.candidate, operation }), operationId: operation.id };
    runner = spawn(process.execPath, ["--input-type=module", "-e", `
      const config=JSON.parse(process.argv[1]);
      const {DovskyDatabase}=await import(config.databaseUrl), {ReleaseService}=await import(config.releasesUrl);
      const database=new DovskyDatabase(config.databasePath);
      const service=new ReleaseService(database,{artifactDirectory:config.artifactDirectory,currentFingerprint:()=>config.fingerprint,
        assertCandidateAccepted:()=>{},adapters:[{id:config.adapterId,action:config.action,target:config.target,
          command:()=>config.command,preflight:async()=>{},readback:async()=>({state:'not_applied',detail:'Fixture effect absent',settled:true})}]});
      await service.executeOperation(config.operationId); database.close();
    `, JSON.stringify(config)], { stdio: "ignore" });
    const closed = new Promise<void>(done => runner!.once("close", () => done()));
    const deadline = Date.now() + 5000;
    while (!existsSync(value.remote + ".ticks") && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
    assert.ok(existsSync(value.remote + ".ticks"), "Mutation must start before crashing its executor");
    const scope = value.service.getOperation(operation.id).execution!;
    enrollment = { scopeUnit: scope.scopeUnit, cgroupPath: scope.cgroupPath!,
      identity: { pid: scope.pid!, processGroup: scope.processGroup!, startTicks: scope.startTicks!, bootId: scope.bootId } };
    const ticks = Number(readFileSync(value.remote + ".ticks", "utf8"));
    runner.kill("SIGKILL"); await closed;
    const restarted = new ReleaseService(value.db, value.options);
    assert.equal(restarted.recoverInterruptedOperations(), 1);
    await new Promise(done => setTimeout(done, 350));
    assert.equal(observeScope(enrollment).state, "alive", existsSync(value.remote + ".error") ? readFileSync(value.remote + ".error", "utf8") : "Mutation survives executor loss");
    assert.ok(Number(readFileSync(value.remote + ".ticks", "utf8")) > ticks, "Mutation keeps writing stdout/stderr after executor loss");
    assert.equal((await restarted.reconcileOperation(operation.id)).state, "reconcile_required");
    assert.throws(() => value.prepare("competing"), /owned by another/);
    assert.equal((await restarted.reconcileOperation(operation.id, "terminate")).state, "not_applied");
    assert.equal(await confirmScopeGone(enrollment), true);
  } finally {
    if (runner && runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
    if (!enrollment) {
      const scope = value.service.listForTask(value.taskId).operations.find(item => item.step === "executor-crash")?.execution;
      if (scope?.pid && scope.cgroupPath && scope.processGroup && scope.startTicks) enrollment = { scopeUnit: scope.scopeUnit, cgroupPath: scope.cgroupPath,
        identity: { pid: scope.pid, processGroup: scope.processGroup, startTicks: scope.startTicks, bootId: scope.bootId } };
    }
    if (enrollment) { await signalScope(enrollment, "SIGKILL"); assert.equal(await confirmScopeGone(enrollment), true); }
    value.cleanup();
  }
});

test("release termination requires current authorization and cannot guess an unenrolled scope", async () => {
  const value = await harness({}, async () => ({ exitCode: null, signal: null, timedOut: true }));
  try {
    const operation = value.prepare();
    value.adapter.readback = async () => ({ state: "reconcile_required", detail: "Pending fixture effect" });
    await value.service.executeOperation(operation.id);
    await assert.rejects(value.service.reconcileOperation(operation.id, "terminate"), /not fully enrolled/);
    value.service.revokeAuthorization(value.grant.id, "Operator withdrew permission");
    await assert.rejects(value.service.reconcileOperation(operation.id, "terminate"), /revoked/);
    assert.equal((await value.service.reconcileOperation(operation.id)).state, "reconcile_required");
  } finally { value.cleanup(); }
});

test("release summary exposes only adapter identity and zero-filled durable counts", async () => {
  const value = await harness();
  try {
    const operation = value.prepare("summary");
    value.db.db.prepare("UPDATE release_operations SET state='reconcile_required' WHERE id=?").run(operation.id);
    const summary = value.service.summary();
    assert.deepEqual(summary.adapters, [{ id: "test-deploy", action: "deploy", target: "fixture:production" }]);
    assert.equal(summary.candidates, 1);
    assert.deepEqual(summary.operations, { prepared: 0, executing: 0, verified: 1, not_applied: 0, reconcile_required: 1, cancelled: 0 });
    assert.equal("argv" in summary.adapters[0]!, false);
    assert.equal(JSON.stringify(summary).includes("readback"), false);
  } finally { value.cleanup(); }
});
