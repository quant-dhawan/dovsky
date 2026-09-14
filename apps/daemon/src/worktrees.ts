import { lstatSync, realpathSync, readdirSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isSafeId } from "@dovsky/protocol";
import { worktreePrune, worktreeRemove } from "./git.js";

const KINDS = ["review", "bench", "proof", "evaluation", "rollout", "pr"] as const;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export interface ReapWorktreesRequest {
  artifactDirectory: string;
  projects: readonly string[];
  /** `true` is permitted only after terminal state and no live/unverifiable execution lease; `null` means no known job. */
  isTerminal(jobId: string): boolean | null;
  maxAgeMs?: number;
  now?: number;
}

function jobId(kind: typeof KINDS[number], name: string): string | null {
  const value = kind === "bench"
    ? /^(.+)-\d+$/.exec(name)?.[1] ?? null
    : kind === "evaluation"
      ? /^(.*)-(?:review-baseline|baseline|candidate)$/.exec(name)?.[1] ?? null
      : name;
  return value !== null && isSafeId(value) ? value : null;
}

function isOld(stat: Stats, now: number, maxAgeMs: number): boolean {
  return Number.isFinite(stat.mtimeMs) && now - stat.mtimeMs > maxAgeMs;
}

function realAdministrativeDirectory(path: string, root: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path
      && (path === root || path.startsWith(root + "/"));
  } catch { return false; }
}

/** Refuses non-directory roots and never follows a link while deleting an orphaned task-owned tree. */
function removeOwnedTree(path: string): boolean {
  let entries = 0;
  const inspect = (current: string, depth: number): boolean => {
    if (++entries > 100_000 || depth > 128) return false;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || stat.isFile()) return true;
    if (!stat.isDirectory()) return false;
    return readdirSync(current).every(name => inspect(join(current, name), depth + 1));
  };
  if (!inspect(path, 0)) return false;
  const remove = (current: string): boolean => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || stat.isFile()) { unlinkSync(current); return true; }
    if (!stat.isDirectory()) return false;
    for (const name of readdirSync(current)) if (!remove(join(current, name))) return false;
    rmdirSync(current);
    return true;
  };
  return remove(path);
}

/**
 * Reaps only direct, recognizable job worktrees under daemon-owned artifact roots.
 * Unrecognizable names are deliberately left alone: no job identity means no deletion authority.
 */
export function reapWorktrees({ artifactDirectory, projects, isTerminal, maxAgeMs = MAX_AGE_MS, now = Date.now() }: ReapWorktreesRequest): void {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(now)) throw new Error("Invalid worktree reaper age policy");
  const artifactRoot = resolve(artifactDirectory);
  if (!realAdministrativeDirectory(artifactRoot, artifactRoot)) throw new Error("Invalid worktree artifact root");
  const projectRoots = [...new Set(projects.map(project => resolve(project)))];
  for (const kind of KINDS) {
    const parent = join(artifactRoot, `${kind}-worktrees`);
    let names: string[];
    try {
      if (!realAdministrativeDirectory(parent, artifactRoot)) continue;
      names = readdirSync(parent);
    } catch { continue; }
    for (const name of names) {
      const id = jobId(kind, name);
      if (id === null) continue;
      const path = join(parent, name);
      if (dirname(path) !== parent) continue;
      let stat: Stats;
      try { stat = lstatSync(path); } catch { continue; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      let terminal: boolean | null;
      try { terminal = isTerminal(id); } catch { continue; }
      if (terminal === false || (terminal === null && !isOld(stat, now, maxAgeMs))) continue;
      // isTerminal is caller code and may synchronously mutate its artifact fixture. Re-establish the
      // administrative boundary before passing this path to Git or the fallback remover.
      if (!realAdministrativeDirectory(parent, artifactRoot)) continue;
      try {
        stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      } catch { continue; }
      let removed = false;
      for (const project of projectRoots) {
        try { worktreeRemove(project, path); removed = true; break; }
        catch { /* The entry may be an orphan or belong to another configured project. */ }
      }
      if (!removed) {
        try { removeOwnedTree(path); }
        catch { /* A racing or malformed tree remains for explicit inspection. */ }
      }
    }
  }
  for (const project of projectRoots) {
    try { worktreePrune(project); }
    catch { /* A removed/misconfigured project must not stop other reaping. */ }
  }
}
