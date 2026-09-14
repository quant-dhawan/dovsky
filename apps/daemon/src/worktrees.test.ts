import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { gitBytes, gitText, worktreeAdd } from "./git.js";
import { reapWorktrees } from "./worktrees.js";
import { DovskyDaemon } from "./daemon.js";
import type { DaemonConfig } from "./config.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dovsky-worktree-reaper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project"), artifacts = join(root, "artifacts");
  mkdirSync(project); gitBytes(project, ["init", "-q"]);
  gitBytes(project, ["config", "user.name", "Fixture"]); gitBytes(project, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(project, "tracked.txt"), "baseline\n"); gitBytes(project, ["add", "."]); gitBytes(project, ["commit", "-qm", "baseline"]);
  return { root, project, artifacts };
}

test("reaps terminal and aged orphan worktrees while retaining known live and fresh unknown entries", t => {
  const f = fixture(t);
  const terminal = join(f.artifacts, "review-worktrees", "terminal-job");
  const live = join(f.artifacts, "proof-worktrees", "live-job");
  const orphan = join(f.artifacts, "bench-worktrees", "orphan-job-1");
  const freshUnknown = join(f.artifacts, "pr-worktrees", "fresh-unknown");
  mkdirSync(join(f.artifacts, "review-worktrees"), { recursive: true }); worktreeAdd(f.project, terminal, "HEAD");
  mkdirSync(join(f.artifacts, "proof-worktrees"), { recursive: true }); worktreeAdd(f.project, live, "HEAD");
  mkdirSync(orphan, { recursive: true }); writeFileSync(join(orphan, "left-behind.txt"), "orphan\n");
  mkdirSync(freshUnknown, { recursive: true }); writeFileSync(join(freshUnknown, "left-behind.txt"), "fresh\n");
  const now = Date.UTC(2026, 8, 13);
  utimesSync(live, new Date(now - 30 * 24 * 60 * 60 * 1_000), new Date(now - 30 * 24 * 60 * 60 * 1_000));
  utimesSync(orphan, new Date(now - 30 * 24 * 60 * 60 * 1_000), new Date(now - 30 * 24 * 60 * 60 * 1_000));

  reapWorktrees({ artifactDirectory: f.artifacts, projects: [f.project], now,
    isTerminal: id => id === "terminal-job" ? true : id === "live-job" ? false : null });

  assert.equal(existsSync(terminal), false);
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(freshUnknown), true);
  const listed = gitText(f.project, ["worktree", "list", "--porcelain"]);
  assert.doesNotMatch(listed, /terminal-job|orphan-job-1/);
  assert.match(listed, /live-job/);
});

test("prunes a stale Git registry entry even when no artifact directory entry remains", t => {
  const f = fixture(t);
  const stale = join(f.artifacts, "review-worktrees", "registry-only");
  mkdirSync(join(f.artifacts, "review-worktrees"), { recursive: true }); worktreeAdd(f.project, stale, "HEAD");
  rmSync(stale, { recursive: true, force: true });

  reapWorktrees({ artifactDirectory: f.artifacts, projects: [f.project], isTerminal: () => false });

  assert.doesNotMatch(gitText(f.project, ["worktree", "list", "--porcelain"]), /registry-only/);
});

test("refuses a symlinked artifact root before it can scan or delete foreign worktrees", t => {
  const f = fixture(t);
  const foreign = join(f.root, "foreign-artifacts");
  const child = join(foreign, "review-worktrees", "foreign-terminal");
  mkdirSync(child, { recursive: true });
  const alias = join(f.root, "artifact-alias");
  symlinkSync(foreign, alias);

  assert.throws(() => reapWorktrees({ artifactDirectory: alias, projects: [f.project], isTerminal: () => true }), /Invalid worktree artifact root/);
  assert.equal(existsSync(child), true);
});

test("revalidates the artifact parent after isTerminal before deleting", t => {
  const f = fixture(t);
  const parent = join(f.artifacts, "review-worktrees");
  const candidate = join(parent, "terminal-job");
  const foreign = join(f.root, "foreign-artifacts", "review-worktrees");
  const foreignCandidate = join(foreign, "terminal-job");
  mkdirSync(candidate, { recursive: true }); writeFileSync(join(candidate, "owned.txt"), "owned\n");
  mkdirSync(foreignCandidate, { recursive: true }); writeFileSync(join(foreignCandidate, "foreign.txt"), "foreign\n");

  reapWorktrees({ artifactDirectory: f.artifacts, projects: [], isTerminal: id => {
    if (id === "terminal-job") {
      renameSync(parent, join(f.root, "held-review-worktrees"));
      symlinkSync(foreign, parent);
      return true;
    }
    return null;
  } });

  assert.equal(existsSync(foreignCandidate), true);
});

test("daemon startup reaps only terminal jobs without unresolved execution leases", async t => {
  const f=fixture(t); mkdirSync(f.artifacts,{recursive:true});
  const config:DaemonConfig={socketPath:join(f.root,"run","bus.sock"),databasePath:join(f.root,"state","bus.db"),artifactDirectory:f.artifacts,maxActive:1,
    projects:[{id:"fixture",name:"Fixture",path:f.project,workflows:[{id:"change",name:"Change",readOnly:false,qualityCommands:[],providers:{}}]}]};
  const daemon=new DovskyDaemon(config); t.after(()=>daemon.close());
  daemon.database.createRoom("room","Room","fixture","change");
  for(const id of ["settled-job","unresolved-job"]) {
    daemon.database.createJob({id,roomId:"room",provider:"codex",projectId:"fixture",workflowId:"change",prompt:"fixture"},`${id}-turn`);
    if(id==="unresolved-job")daemon.database.prepareExecutionLease("lease",id,null,"provider",1);
    daemon.database.transitionJob(id,["queued"],"starting"); daemon.database.transitionJob(id,["starting"],"running");
    daemon.database.transitionJob(id,["running"],"succeeded",{finishedAt:new Date().toISOString()});
  }
  for(const id of ["settled-job","unresolved-job"]) {
    const target=join(f.artifacts,"review-worktrees",id); mkdirSync(join(f.artifacts,"review-worktrees"),{recursive:true}); worktreeAdd(f.project,target,"HEAD");
  }
  daemon.start();
  assert.equal(existsSync(join(f.artifacts,"review-worktrees","settled-job")),false);
  assert.equal(existsSync(join(f.artifacts,"review-worktrees","unresolved-job")),true);
  await daemon.stop();
});
