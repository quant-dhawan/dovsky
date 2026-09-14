import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureBaseline, captureDelta, materializeBaseline } from "./job-delta.js";
import { gitBytes, gitText } from "./git.js";
import { buildPullRequestBody, createPullRequestLeaf, GitHubLeafError, probePullRequest, pullRequestBranch, statusPullRequest, type GitHubCommandResult, type GitHubCommandRunner, type PullRequestLeafInput } from "./github.js";

function fixture(): { root: string; repo: string; remote: string; input: PullRequestLeafInput } {
  const root = mkdtempSync(join(tmpdir(), "dovsky-github-leaf-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(repo); mkdirSync(remote);
  gitBytes(repo, ["init", "-q"]); gitBytes(remote, ["init", "--bare", "-q"]);
  gitBytes(repo, ["config", "user.name", "Fixture"]); gitBytes(repo, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, "tracked.txt"), "before\n");
  gitBytes(repo, ["add", "."]); gitBytes(repo, ["commit", "-qm", "baseline"]);
  gitBytes(repo, ["remote", "add", "origin", remote]); gitBytes(repo, ["push", "-q", "origin", "HEAD:main"]);
  const baseline = captureBaseline(repo, join(root, "baseline"));
  const privateRepo = join(root, "private"); materializeBaseline(repo, privateRepo, baseline);
  writeFileSync(join(privateRepo, "tracked.txt"), "after\n");
  writeFileSync(join(privateRepo, "new.bin"), Buffer.from([0, 255, 42]));
  const delta = captureDelta(baseline, privateRepo, join(root, "final"));
  const evidence = "evidence";
  const input: PullRequestLeafInput = {
    jobId: "job-1234", roomId: "room-1234", repository: "owner/project", remote: "origin", baseBranch: "main",
    projectPath: repo, worktreePath: join(root, "pr-worktree"), startCommit: gitText(repo, ["rev-parse", "HEAD"]),
    fingerprint: delta.final.manifest.identity.fingerprint, contentHash: delta.final.manifest.identity.contentHash, evidenceHash: createHash("sha256").update(evidence).digest("hex"), title: "Fixture change",
    commitName: "Fixture", commitEmail: "fixture@example.invalid", delta,
    body: { acceptance: "accepted", criteria: ["gate"], gates: [["test", "pass"]], review: "approved", identity: "fixture identity", evidence },
    accepted: true,
  };
  return { root, repo, remote, input };
}

function cleanupFixture(root: string): void {
  const unlock = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) for (const name of readdirSync(path)) unlock(join(path, name));
  };
  if (existsSync(root)) { unlock(root); rmSync(root, { recursive: true, force: true }); }
}

function fakeGh(_input: PullRequestLeafInput, bodyReads: string[]): GitHubCommandRunner {
  return async (argv, cwd, env): Promise<GitHubCommandResult> => {
    assert.equal(typeof cwd, "string");
    if (argv[0] === "gh" && argv[1] === "auth") return { status: 0, stdout: "Logged in\n", stderr: "" };
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") return { status: 0, stdout: "[]\n", stderr: "" };
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create") {
      const bodyFile = argv[argv.indexOf("--body-file") + 1]!;
      assert.equal(env?.GH_PROMPT_DISABLED, "1");
      bodyReads.push(readFileSync(bodyFile, "utf8"));
      return { status: 0, stdout: "https://github.com/owner/project/pull/7\n", stderr: "" };
    }
    throw new Error(`unexpected argv: ${argv.join(" ")}`);
  };
}

test("body sanitizes stored text, clips evidence, and stays within the bound", () => {
  const body = buildPullRequestBody({ acceptance: "ok\u001b[31m", identity: "identity", evidence: "x".repeat(70 * 1024) });
  assert.equal(body.includes("\u001b"), false);
  assert.ok(body.includes("[review evidence truncated at 60 KiB]"));
  assert.ok(Buffer.byteLength(body) <= 65_536);
});

test("probe is read-only, checks auth before PR and remote branch, and uses a deterministic branch", async (t) => {
  const f = fixture(); const calls: string[][] = [];
  t.after(() => cleanupFixture(f.root));
  const runner: GitHubCommandRunner = async (argv) => {
    calls.push([...argv]);
    if (argv[1] === "auth") return { status: 1, stdout: "", stderr: "not logged in" };
    throw new Error("later probes must not run after auth failure");
  };
  const result = await probePullRequest(f.input, runner);
  assert.deepEqual(result, { configured: false, branch: "dovsky/room-123-job-1234", existing: null, branchExists: false, branchHead: null, reason: "NOT_CONFIGURED" });
  assert.deepEqual(calls, [["gh", "auth", "status", "--hostname", "github.com"]]);
  assert.equal(pullRequestBranch(f.input.roomId, f.input.jobId), "dovsky/room-123-job-1234");
});

test("create can consume the exact preflight without repeating auth or remote probes", async (t) => {
  const f = fixture(); t.after(() => cleanupFixture(f.root));
  const preflight = await probePullRequest(f.input, async (argv) => {
    if (argv[1] === "auth") return { status: 0, stdout: "", stderr: "" };
    if (argv[2] === "list") return { status: 0, stdout: "[]", stderr: "" };
    throw new Error("preflight runner received an unexpected command");
  });
  const calls: string[][] = [];
  const runner: GitHubCommandRunner = async (argv) => {
    calls.push([...argv]);
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create") return { status: 0, stdout: "https://github.com/owner/project/pull/10\n", stderr: "" };
    throw new Error("supplied preflight must prevent repeated auth/list probes");
  };
  const result = await createPullRequestLeaf(f.input, runner, undefined, preflight);
  assert.equal(result.number, 10); assert.deepEqual(calls.map(argv => argv.slice(0, 3)), [["gh", "pr", "create"]]);
  await assert.rejects(createPullRequestLeaf(f.input, runner, undefined, { ...preflight, branch: "wrong-branch" }), /preflight identity/);
});

test("accepted local fixture creates a detached PR branch with only the delta and leaves the source clean", async (t) => {
  const f = fixture(); const bodyReads: string[] = []; const progress: string[] = [];
  t.after(() => cleanupFixture(f.root));
  const result = await createPullRequestLeaf(f.input, fakeGh(f.input, bodyReads), { onCommitted: async (headSha) => { progress.push(`committed:${headSha}`); }, onPushed: (headSha) => { progress.push(`pushed:${headSha}`); } });
  assert.equal(result.state, "open"); assert.equal(result.number, 7); assert.equal(result.url, "https://github.com/owner/project/pull/7");
  const branch = pullRequestBranch(f.input.roomId, f.input.jobId);
  assert.equal(gitText(f.remote, ["show", `refs/heads/${branch}:tracked.txt`]), "after");
  assert.deepEqual(gitBytes(f.remote, ["show", `refs/heads/${branch}:new.bin`]), Buffer.from([0, 255, 42]));
  assert.equal(gitText(f.repo, ["status", "--porcelain"]), "");
  assert.equal(existsSync(f.input.worktreePath), false);
  assert.equal(bodyReads.length, 1); assert.ok(bodyReads[0]!.includes("## Acceptance"));
  assert.equal(progress.length, 2); assert.match(progress[0]!, /^committed:[0-9a-f]{40}$/); assert.equal(progress[1], `pushed:${progress[0]!.slice("committed:".length)}`);
});

test("unaccepted or existing PR paths do not create a worktree", async (t) => {
  const f = fixture();
  t.after(() => cleanupFixture(f.root));
  await assert.rejects(createPullRequestLeaf({ ...f.input, accepted: false }, fakeGh(f.input, [])), /accepted evidence/);
  let createCalls = 0;
  const runner: GitHubCommandRunner = async (argv) => {
    if (argv[1] === "auth") return { status: 0, stdout: "", stderr: "" };
    if (argv[2] === "list") return { status: 0, stdout: JSON.stringify([{ number: 3, state: "OPEN", url: "https://github.com/owner/project/pull/3", headRefOid: "a".repeat(40), isDraft: false, mergedAt: null, mergeCommit: null }]), stderr: "" };
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create") createCalls += 1;
    return { status: 2, stdout: "", stderr: "" };
  };
  const result = await createPullRequestLeaf({ ...f.input, remote: "missing-remote" }, runner);
  assert.equal(result.state, "open"); assert.equal(result.number, 3); assert.equal(result.isDraft, false); assert.equal(result.mergedAt, null); assert.equal(result.mergeCommit, null); assert.equal(createCalls, 0); assert.equal(existsSync(f.input.worktreePath), false);
});

test("a pushed branch is recovered by creating one PR without a second push or worktree", async (t) => {
  const f = fixture(); const bodyReads: string[] = []; const calls: string[][] = [];
  t.after(() => cleanupFixture(f.root));
  const branch = pullRequestBranch(f.input.roomId, f.input.jobId);
  gitBytes(f.repo, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  const runner: GitHubCommandRunner = async (argv, _cwd, env) => {
    calls.push([...argv]);
    if (argv[0] === "gh" && argv[1] === "auth") return { status: 0, stdout: "", stderr: "" };
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") return { status: 0, stdout: "[]", stderr: "" };
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create") {
      assert.equal(env?.GH_PROMPT_DISABLED, "1");
      bodyReads.push(readFileSync(argv[argv.indexOf("--body-file") + 1]!, "utf8"));
      return { status: 0, stdout: "https://github.com/owner/project/pull/8\n", stderr: "" };
    }
    throw new Error(`unexpected runner command: ${argv.join(" ")}`);
  };
  const expectedHead = gitText(f.remote, ["rev-parse", `refs/heads/${branch}`]);
  const progress: string[] = [];
  const result = await createPullRequestLeaf(f.input, runner, { onPushed: (headSha) => { progress.push(`pushed:${headSha}`); } });
  assert.deepEqual(result, { state: "open", branch, headSha: expectedHead, number: 8, url: "https://github.com/owner/project/pull/8", existing: { number: 8, url: "https://github.com/owner/project/pull/8", state: "OPEN", headRefOid: expectedHead, isDraft: false, mergedAt: null, mergeCommit: null }, bodyHash: result.bodyHash, isDraft: false, mergedAt: null, mergeCommit: null });
  assert.equal(calls.filter(argv => argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create").length, 1);
  assert.equal(calls.some(argv => argv[0] === "git"), false);
  assert.equal(existsSync(f.input.worktreePath), false);
  assert.equal(gitText(f.remote, ["rev-parse", `refs/heads/${branch}`]), expectedHead);
  assert.equal(bodyReads.length, 1);
  assert.deepEqual(progress, [`pushed:${expectedHead}`]);
});

test("progress callback failures propagate while cleanup and reconciliation remain observable", async (t) => {
  const f = fixture();
  t.after(() => cleanupFixture(f.root));
  await assert.rejects(createPullRequestLeaf(f.input, fakeGh(f.input, []), { onCommitted: () => { throw new Error("commit callback failed"); } }), /commit callback failed/);
  assert.equal(existsSync(f.input.worktreePath), false);
  const branch = pullRequestBranch(f.input.roomId, f.input.jobId);
  assert.equal(gitText(f.remote, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]), "");

  const second = fixture(); t.after(() => cleanupFixture(second.root));
  let creates = 0;
  const runner: GitHubCommandRunner = async (argv) => {
    if (argv[1] === "auth") return { status: 0, stdout: "", stderr: "" };
    if (argv[2] === "list") return { status: 0, stdout: "[]", stderr: "" };
    if (argv[2] === "create") { creates += 1; return { status: 0, stdout: "https://github.com/owner/project/pull/13\n", stderr: "" }; }
    throw new Error(`unexpected runner command: ${argv.join(" ")}`);
  };
  await assert.rejects(createPullRequestLeaf(second.input, runner, { onPushed: () => { throw new Error("push callback failed"); } }), /push callback failed/);
  assert.equal(creates, 0); assert.equal(existsSync(second.input.worktreePath), false);
  assert.notEqual(gitText(second.remote, ["for-each-ref", "--format=%(objectname)", `refs/heads/${pullRequestBranch(second.input.roomId, second.input.jobId)}`]), "");
});

test("body cleanup is retained when worktree removal cannot be confirmed", async (t) => {
  const f = fixture(); let bodyPath = "";
  t.after(() => cleanupFixture(f.root));
  const runner: GitHubCommandRunner = async (argv) => {
    if (argv[0] === "gh" && argv[1] === "auth") return { status: 0, stdout: "", stderr: "" };
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") return { status: 0, stdout: "[]", stderr: "" };
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create") {
      bodyPath = argv[argv.indexOf("--body-file") + 1]!;
      renameSync(join(f.repo, ".git"), join(f.repo, ".git-hidden-for-cleanup-test"));
      return { status: 0, stdout: "https://github.com/owner/project/pull/9\n", stderr: "" };
    }
    throw new Error(`unexpected runner command: ${argv.join(" ")}`);
  };
  await assert.rejects(createPullRequestLeaf(f.input, runner), /cleanup could not be confirmed/);
  assert.notEqual(bodyPath, "");
  assert.equal(existsSync(bodyPath), false);
});

test("existing PR states map strictly and skip the remote probe", async (t) => {
  const f = fixture();
  t.after(() => cleanupFixture(f.root));
  for (const [remoteState, expectedState] of [["OPEN", "open"], ["MERGED", "merged"], ["CLOSED", "closed"]] as const) {
    const runner: GitHubCommandRunner = async (argv) => {
      if (argv[1] === "auth") return { status: 0, stdout: "", stderr: "" };
      if (argv[2] === "list") return { status: 0, stdout: JSON.stringify([{ number: 11, state: remoteState, url: "https://github.com/owner/project/pull/11", headRefOid: "b".repeat(40), isDraft: false, mergedAt: remoteState === "MERGED" ? "2026-01-02T03:04:05.000Z" : null, mergeCommit: remoteState === "MERGED" ? { oid: "d".repeat(40) } : null }]), stderr: "" };
      throw new Error("existing PR must return before any remote probe or write");
    };
    const result = await createPullRequestLeaf({ ...f.input, remote: "missing-remote" }, runner);
    assert.equal(result.state, expectedState);
    assert.equal(result.number, 11);
    assert.equal(result.headSha, "b".repeat(40));
    assert.equal(result.mergedAt, remoteState === "MERGED" ? "2026-01-02T03:04:05.000Z" : null);
    assert.equal(result.mergeCommit, remoteState === "MERGED" ? "d".repeat(40) : null);
  }
});

test("malformed existing PR state, number, URL, or head fails closed", async (t) => {
  const f = fixture();
  t.after(() => cleanupFixture(f.root));
  const valid = { number: 12, state: "OPEN", url: "https://github.com/owner/project/pull/12", headRefOid: "c".repeat(40), isDraft: false, mergedAt: null, mergeCommit: null };
  const malformed: Record<string, unknown>[] = [
    { ...valid, state: "UNKNOWN" },
    { ...valid, number: 0 },
    { ...valid, url: "https://github.com/owner/project/issues/12" },
    { ...valid, headRefOid: "not-a-sha" },
  ];
  for (const record of malformed) {
    const runner: GitHubCommandRunner = async (argv) => {
      if (argv[1] === "auth") return { status: 0, stdout: "", stderr: "" };
      if (argv[2] === "list") return { status: 0, stdout: JSON.stringify([record]), stderr: "" };
      throw new Error("malformed PR must fail before any remote probe");
    };
    await assert.rejects(probePullRequest({ ...f.input, remote: "missing-remote" }, runner), (error: unknown) => error instanceof GitHubLeafError && error.code === "EXTERNAL_ERROR");
  }
});

test("duplicate PR rows are ambiguous and fail closed before remote probing", async (t) => {
  const f = fixture(); let calls = 0;
  t.after(() => cleanupFixture(f.root));
  const record = { number: 12, state: "OPEN", url: "https://github.com/owner/project/pull/12", headRefOid: "c".repeat(40), isDraft: false, mergedAt: null, mergeCommit: null };
  const runner: GitHubCommandRunner = async (argv) => {
    calls += 1;
    if (argv[1] === "auth") return { status: 0, stdout: "", stderr: "" };
    if (argv[2] === "list") return { status: 0, stdout: JSON.stringify([record, record]), stderr: "" };
    throw new Error("ambiguous PR rows must fail before any remote probe");
  };
  await assert.rejects(probePullRequest({ ...f.input, remote: "missing-remote" }, runner), (error: unknown) => error instanceof GitHubLeafError && error.code === "EXTERNAL_ERROR");
  assert.equal(calls, 2);
});

test("delta and evidence identity mismatches reject before any PR or worktree side effect", async (t) => {
  const f = fixture(); let calls = 0;
  t.after(() => cleanupFixture(f.root));
  const mismatches: PullRequestLeafInput[] = [
    { ...f.input, startCommit: "0".repeat(40) },
    { ...f.input, fingerprint: f.input.delta.baseline.manifest.identity.fingerprint },
    { ...f.input, contentHash: f.input.delta.baseline.manifest.identity.contentHash },
    { ...f.input, fingerprint: "0".repeat(64) },
    { ...f.input, contentHash: "0".repeat(64) },
    { ...f.input, evidenceHash: "0".repeat(64) },
  ];
  const runner: GitHubCommandRunner = async () => { calls += 1; throw new Error("identity mismatch must reject before probing"); };
  for (const input of mismatches) {
    await assert.rejects(createPullRequestLeaf(input, runner), (error: unknown) => error instanceof GitHubLeafError && error.code === "STATE_CONFLICT");
    assert.equal(existsSync(input.worktreePath), false);
  }
  const branch = pullRequestBranch(f.input.roomId, f.input.jobId);
  assert.equal(gitText(f.remote, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]), "");
  assert.equal(calls, 0);
});

test("status leaf validates and normalizes every PR state", async (t) => {
  const f = fixture();
  t.after(() => cleanupFixture(f.root));
  const branch = pullRequestBranch(f.input.roomId, f.input.jobId);
  for (const [remoteState, expectedState] of [["OPEN", "open"], ["MERGED", "merged"], ["CLOSED", "closed"]] as const) {
    const runner: GitHubCommandRunner = async (argv) => {
      if (argv[1] === "auth") return { status: 0, stdout: "", stderr: "" };
      if (argv[1] === "pr" && argv[2] === "view") return { status: 0, stdout: JSON.stringify({ number: 14, state: remoteState, url: "https://github.com/owner/project/pull/14", headRefOid: "e".repeat(40), isDraft: false, mergedAt: remoteState === "MERGED" ? "2026-01-02T03:04:05Z" : null, mergeCommit: remoteState === "MERGED" ? { oid: "f".repeat(40) } : null }), stderr: "" };
      throw new Error(`unexpected status command: ${argv.join(" ")}`);
    };
    const result = await statusPullRequest({ repository: f.input.repository, projectPath: f.input.projectPath, branch, number: 14 }, runner);
    assert.deepEqual(result, { repository: "owner/project", branch, state: expectedState, number: 14, url: "https://github.com/owner/project/pull/14", headSha: "e".repeat(40), isDraft: false, mergedAt: remoteState === "MERGED" ? "2026-01-02T03:04:05.000Z" : null, mergeCommit: remoteState === "MERGED" ? "f".repeat(40) : null });
  }
});

test("status leaf rejects malformed or identity-inconsistent merge fields", async (t) => {
  const f = fixture();
  t.after(() => cleanupFixture(f.root));
  const valid = { number: 15, state: "OPEN", url: "https://github.com/owner/project/pull/15", headRefOid: "a".repeat(40), isDraft: false, mergedAt: null, mergeCommit: null };
  const malformed: Record<string, unknown>[] = [
    { ...valid, state: "MERGED", mergedAt: null, mergeCommit: "b".repeat(40) },
    { ...valid, state: "MERGED", mergedAt: null, mergeCommit: { oid: "b".repeat(40) } },
    { ...valid, mergedAt: "not-a-time" },
    { ...valid, mergeCommit: "not-a-sha" },
    { ...valid, isDraft: "false" },
    { ...valid, number: 16 },
  ];
  for (const record of malformed) {
    const runner: GitHubCommandRunner = async (argv) => {
      if (argv[1] === "auth") return { status: 0, stdout: "", stderr: "" };
      if (argv[1] === "pr" && argv[2] === "view") return { status: 0, stdout: JSON.stringify(record), stderr: "" };
      throw new Error("malformed status must not invoke another command");
    };
    await assert.rejects(statusPullRequest({ repository: f.input.repository, projectPath: f.input.projectPath, branch: pullRequestBranch(f.input.roomId, f.input.jobId), number: 15 }, runner), /invalid|inconsistent|did not match/);
  }
});
