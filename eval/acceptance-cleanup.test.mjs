import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { cleanupAcceptanceWorktree, reportAcceptanceCleanupFailures } from "./acceptance-cleanup.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("locked acceptance worktree makes cleanup fail visibly and still prunes", t => {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-acceptance-cleanup-"));
  const source = resolve(root, "source");
  const worktree = resolve(root, "worktree");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.email", "test@example.invalid");
  git(source, "config", "user.name", "Dovsky Test");
  writeFileSync(resolve(source, "tracked.txt"), "fixture\n");
  git(source, "add", "tracked.txt");
  git(source, "commit", "-qm", "fixture");
  git(source, "worktree", "add", "-q", worktree);
  git(source, "worktree", "lock", worktree);
  t.after(() => {
    spawnSync("git", ["-C", source, "worktree", "unlock", worktree]);
    spawnSync("git", ["-C", source, "worktree", "remove", "--force", worktree]);
    rmSync(root, { recursive: true, force: true });
  });

  const commands = [];
  const failures = cleanupAcceptanceWorktree(source, worktree, (command, args, options) => {
    commands.push(args.slice(-2).join(" "));
    return spawnSync(command, args, options);
  });
  assert.equal(commands.length, 2);
  assert.match(commands[0], /--force/);
  assert.match(commands[1], /worktree prune/);
  assert.equal(failures.length, 1);
  assert.match(failures[0], new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const priorExitCode = process.exitCode;
  const messages = [];
  process.exitCode = undefined;
  try {
    reportAcceptanceCleanupFailures(failures, message => messages.push(message));
    assert.equal(process.exitCode, 1);
    assert.match(messages.join(""), /locked/);
  } finally {
    process.exitCode = priorExitCode;
  }
});
