import { spawnSync } from "node:child_process";

function failed(command, result) {
  if (result.status === 0) return null;
  const detail = String(result.stderr ?? "").trim() || result.error?.message || result.signal || `exit ${result.status}`;
  return `${command}: ${detail}`;
}

export function cleanupAcceptanceWorktree(source, project, run = spawnSync) {
  const options = { encoding: "utf8" };
  const remove = run("git", ["-C", source, "worktree", "remove", "--force", project], options);
  const prune = run("git", ["-C", source, "worktree", "prune"], options);
  return [
    failed(`Failed to remove acceptance worktree ${project}`, remove),
    failed(`Failed to prune worktrees for ${source}`, prune),
  ].filter(Boolean);
}

export function reportAcceptanceCleanupFailures(failures, write = message => process.stderr.write(message)) {
  if (!failures.length) return;
  if (!process.exitCode) process.exitCode = 1;
  for (const message of failures) write(`${message}\n`);
}
