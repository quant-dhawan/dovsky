import { gitSpawn } from './git.js';
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertRealDirectory, readRegularFile, safeTreePath } from "./file-state.js";
import { captureBaseline, materializeBaseline } from "./job-delta.js";
import type { ReadonlyDependencyMount } from "./isolation.js";

export interface EvaluationDependencyInstall {
  argv: readonly string[];
  cwd: string;
  /** Complete private project to expose to the installer; cwd may be a nested lock root. */
  treePath: string;
  /** Exact roots governed by this nearest-lock installation group. */
  roots: readonly string[];
  network: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface EvaluationDependencyRequest {
  projectPath: string;
  armPath: string;
  dependencyRoots: readonly string[];
  cacheRoot: string;
  mode: "bwrap" | "worktree";
  network: boolean;
  /** Root persists invalidation when canonical lockfiles change without reinstalling canonical modules. */
  allowCanonicalDependencies?: boolean;
  /** Root must enforce the bounds/policy in isolation and settle only after ALL descendants stop, including on rejection. */
  install: (request: EvaluationDependencyInstall) => Promise<{ exitCode: number | null; timedOut: boolean }>;
}

export class EvaluationDependencyError extends Error {
  readonly code = "gate_broken";
  constructor(reason: string) { super(`gate_broken: ${reason}`); this.name = "EvaluationDependencyError"; }
}

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);
const administrative = new Set([".git", ".agentbus", ".dovsky", ".agents", ".codex", ".claude", ".cache", ".npm"]);
const fail = (reason: string): never => { throw new EvaluationDependencyError(reason); };

function statIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function dependencyDirectory(tree: string, root: string): string | null {
  const path = safeTreePath(tree, root), stat = statIfPresent(path);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`dependency root is not a real directory: ${root}`);
  return path;
}

function nearestLock(tree: string, root: string): { path: string; hash: string } | null {
  let directory = dirname(root);
  while (true) {
    const path = directory === "." ? "package-lock.json" : `${directory}/package-lock.json`;
    const absolute = safeTreePath(tree, path);
    if (statIfPresent(absolute)) return { path, hash: sha256(readRegularFile(absolute, 16 * 1024 * 1024)) };
    if (directory === ".") return null;
    directory = dirname(directory);
  }
}

/** Resolve links as they will resolve in the arm after exact directory mounts. Never rewrite npm links. */
function validateDependencyLinks(arm: string, mounts: readonly ReadonlyDependencyMount[]): void {
  const physical = (path: string): string => {
    const mount = mounts.find(item => path === item.relativePath || path.startsWith(item.relativePath + "/"));
    return mount ? resolve(mount.source, relative(mount.relativePath, path)) : safeTreePath(arm, path);
  };
  const resolveLink = (path: string): void => {
    let pending = path.split("/"), resolved: string[] = [], links = 0;
    while (pending.length) {
      const part = pending.shift()!;
      if (!part || part === ".") continue;
      if (part === "..") { if (!resolved.length) fail("dependency link escapes the arm"); resolved.pop(); continue; }
      if (administrative.has(part.toLowerCase())) fail("dependency link exposes administrative paths");
      const next = [...resolved, part].join("/"), stat = statIfPresent(physical(next));
      if (stat?.isSymbolicLink()) {
        if (++links > 40) fail("dependency symlink loop or excessive depth");
        const target = readlinkSync(physical(next));
        if (isAbsolute(target) || target.includes("\\")) fail("dependency links must remain relative to the arm");
        pending = [...target.split("/"), ...pending];
      } else {
        if (stat && pending.length && !stat.isDirectory()) fail("dependency link traverses a non-directory");
        resolved.push(part);
      }
    }
    if (resolved.includes("node_modules") && !statIfPresent(physical(resolved.join("/")))) fail("missing installed dependency link target");
    // Missing workspace build output is allowed; its relative link will resolve after the arm builds.
  };
  let entries = 0;
  const inspect = (path: string, relativePath: string, depth: number): void => {
    if (++entries > 100_000 || depth > 128) fail("dependency inspection exceeds bounds");
    const stat = lstatSync(path);
    if (administrative.has(basename(path).toLowerCase())) fail("dependency directory contains administrative paths");
    if (stat.isSymbolicLink()) resolveLink(relativePath);
    else if (stat.isDirectory()) for (const name of readdirSync(path)) inspect(resolve(path, name), `${relativePath}/${name}`, depth + 1);
    else if (!stat.isFile() || stat.nlink !== 1) fail("dependency directory contains special files or hardlinks");
  };
  for (const mount of mounts) inspect(mount.source, mount.relativePath, 0);
}

// Only called on mkdtemp trees owned by this invocation; snapshot directories are read-only.
function removeTemporary(path: string): void {
  if (lstatSync(path).isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) {
      const child = resolve(path, name);
      if (lstatSync(child).isDirectory()) removeTemporary(child);
    }
  }
  rmSync(path, { recursive: true, force: true });
}

/** Plan mounts only. Caller holds project/arm locks and supplies an arm without the legacy symlink farm. */
export async function prepareEvaluationDependencies(request: EvaluationDependencyRequest): Promise<readonly ReadonlyDependencyMount[]> {
  try {
    const project = resolve(request.projectPath), arm = resolve(request.armPath), cache = resolve(request.cacheRoot);
    assertRealDirectory(project); assertRealDirectory(arm);
    if (inside(project, arm) || inside(arm, project)) fail("project and materialized arm must be disjoint");
    for (const tree of [project, arm]) if (inside(tree, cache) || inside(cache, tree)) fail("dependency cache must be dedicated and outside project/arm");
    if (!["bwrap", "worktree"].includes(request.mode) || typeof request.network !== "boolean" || typeof request.install !== "function") fail("invalid dependency preparation policy");
    if (request.allowCanonicalDependencies !== undefined && typeof request.allowCanonicalDependencies !== 'boolean') fail('invalid canonical dependency provenance');
    if (!Array.isArray(request.dependencyRoots) || request.dependencyRoots.length > 32) fail("invalid dependency roots");
    const roots = [...new Set(request.dependencyRoots)];
    for (const root of roots) {
      if (typeof root !== "string" || root.length > 4096 || root.includes("\\") || isAbsolute(root)
        || root.split("/").some(part => !part || part.startsWith(".") || part.includes("\0"))
        || basename(root) !== "node_modules" || root.split("/").slice(0, -1).includes("node_modules")) fail(`invalid dependency root: ${root}`);
    }
    const mounts: ReadonlyDependencyMount[] = [];
    const missing = new Map<string, { hash: string; roots: string[] }>();
    for (const root of roots) {
      const installed = dependencyDirectory(project, root), armInstalled = dependencyDirectory(arm, root);
      const armLock = nearestLock(arm, root), canonicalLock = nearestLock(project, root);
      if (!armLock || !canonicalLock) {
        if (installed || armInstalled) fail(`dependency lockfile missing: ${root}`);
        if (!armLock) continue; // A plain fixture with no installed dependencies or arm lock.
      }
      if (request.allowCanonicalDependencies !== false && installed && armLock!.path === canonicalLock?.path && armLock!.hash === canonicalLock.hash) {
        mounts.push({ source: installed, relativePath: root, lockHash: armLock!.hash });
      } else {
        if (request.mode === "worktree") fail(`worktree dependency lock mismatch or unavailable installation: ${root}`);
        const group = missing.get(armLock!.path) ?? { hash: armLock!.hash, roots: [] };
        group.roots.push(root); missing.set(armLock!.path, group);
      }
    }
    if (missing.size) {
      assertRealDirectory(dirname(cache));
      if (!statIfPresent(cache)) mkdirSync(cache, { mode: 0o700 });
      assertRealDirectory(cache);
      const temporary = mkdtempSync(resolve(cache, ".s2-dependencies-"));
      try {
        const baseline = captureBaseline(arm, resolve(temporary, "baseline"));
        for (const [lockPath, group] of missing) {
          // Source identity prevents stale copied file: dependencies sharing an unchanged lock.
          const identity = { version: 1, lockPath, lockHash: group.hash, contentHash: baseline.manifest.identity.contentHash };
          const key = `${group.hash}-${sha256(JSON.stringify(identity))}`;
          const entry = resolve(cache, key), guard = resolve(cache, `.s2-lock-${key}`);
          const cacheMounts = (directory: string): ReadonlyDependencyMount[] => {
            assertRealDirectory(directory);
            const tree = resolve(directory, "tree");
            assertRealDirectory(tree);
            if (sha256(readRegularFile(safeTreePath(tree, lockPath), 16 * 1024 * 1024)) !== group.hash) fail("cached dependency lock changed");
            return group.roots.map(root => ({ source: dependencyDirectory(tree, root) ?? fail(`installer omitted dependency directory: ${root}`), relativePath: root, lockHash: group.hash }));
          };
          const readCache = (): ReadonlyDependencyMount[] | null => {
            if (!statIfPresent(entry)) return null;
            assertRealDirectory(entry);
            if (readRegularFile(resolve(entry, "complete.json"), 4096).toString() !== JSON.stringify(identity)) fail("unknown or incomplete dependency cache entry");
            return cacheMounts(entry);
          };
          let selected = readCache();
          if (!selected) {
            if (!request.network) fail("network-disabled dependency cache miss");
            let acquired = false;
            const deadline = Date.now() + 30_000;
            while (!acquired && !selected) {
              try { mkdirSync(guard, { mode: 0o700 }); acquired = true; }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
              if (!acquired) {
                selected = readCache();
                if (Date.now() >= deadline) fail("dependency cache population is busy");
                if (!selected) await delay(25);
              }
            }
            if (acquired) {
              try {
                selected = readCache();
                if (!selected) {
                  const population = resolve(temporary, key);
                  mkdirSync(population, { mode: 0o700 });
                  const tree = resolve(population, "tree");
                  materializeBaseline(arm, tree, baseline);
                  if (sha256(readRegularFile(safeTreePath(tree, lockPath), 16 * 1024 * 1024)) !== group.hash) fail("arm lock changed during dependency preparation");
                  const cwd = resolve(tree, dirname(lockPath));
                  const result = await request.install({ argv: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", cwd],
                    cwd, treePath: tree, roots: [...group.roots], network: request.network, timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 });
                  if (result.exitCode !== 0 || result.timedOut) fail("dependency installation failed or timed out");
                  const installed = cacheMounts(population);
                  validateDependencyLinks(arm, [...mounts, ...installed]);
                  writeFileSync(resolve(population, "complete.json"), JSON.stringify(identity), { flag: "wx", mode: 0o400 });
                  // The exclusive guard serializes publication; never replace any existing unknown tree.
                  if (statIfPresent(entry)) fail("dependency cache appeared during population");
                  renameSync(population, entry);
                  selected = readCache()!;
                }
              } finally { rmdirSync(guard); }
            }
          }
          mounts.push(...selected!);
        }
      } finally { removeTemporary(temporary); }
    }
    mounts.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    validateDependencyLinks(arm, mounts);
    return Object.freeze(mounts.map(mount => Object.freeze(mount)));
  } catch (error) {
    if (error instanceof EvaluationDependencyError) throw error;
    throw new EvaluationDependencyError(error instanceof Error ? error.message.slice(0, 2048) : "dependency preparation failed");
  }
}

/** Legacy compatibility only. Root will switch callers to a private arm plus prepareEvaluationDependencies. */
export function prepareEvaluationTree(project: string, target: string, commit: string, patch: Buffer, untracked: Iterable<string>, source: string, dependencyRoots = ["node_modules"]): void {
  if (existsSync(target)) throw new Error("Evaluation worktree already exists; interrupted evidence requires a new job");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const added = gitSpawn(["-C", project, "worktree", "add", "--detach", target, commit], { encoding: "utf8", timeout: 30_000 });
  if (added.status !== 0) throw new Error(added.stderr || "Could not prepare evaluation worktree");
  if (patch.length) {
    const applied = gitSpawn(["-C", target, "apply", "--binary"], { input: patch, encoding: "utf8", timeout: 30_000 });
    if (applied.status !== 0) throw new Error(`Cannot reconstruct evaluation snapshot: ${applied.stderr}`);
  }
  for (const path of untracked) {
    const from = resolve(source, path);
    if (!existsSync(from) || !lstatSync(from).isFile()) throw new Error(`Incomplete untracked snapshot: ${path}`);
    const to = resolve(target, path);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  const projectRoot = realpathSync(project);
  for (const root of dependencyRoots) {
    const installed = resolve(project, root);
    if (!existsSync(installed)) continue; // A plain Node/Python project may have no packages.
    const modules = resolve(target, root);
    mkdirSync(modules, { recursive: true });
    const link = (name: string) => {
      const from = resolve(installed, name);
      const symbolic = lstatSync(from).isSymbolicLink();
      // Workspace binaries may not exist until the frozen runner builds the arm.
      let destination = existsSync(from) ? realpathSync(from)
        : symbolic ? resolve(dirname(from), readlinkSync(from)) : realpathSync(from);
      if (!existsSync(from)) {
        // npm's .bin link can traverse a workspace directory symlink before
        // reaching missing dist output. Resolve its deepest existing ancestor.
        const suffix: string[] = [];
        while (!existsSync(destination)) {
          suffix.unshift(basename(destination));
          destination = dirname(destination);
        }
        destination = resolve(realpathSync(destination), ...suffix);
      }
      const local = relative(projectRoot, destination);
      // Workspace symlinks must point into this arm, never the current candidate.
      const workspace = symbolic && local !== ".." && !local.startsWith(`..${sep}`)
        && !local.split(sep).includes("node_modules");
      if (!workspace && !existsSync(from)) throw new Error(`Missing installed dependency: ${from}`);
      symlinkSync(workspace ? resolve(target, local) : from, resolve(modules, name));
    };
    for (const name of readdirSync(installed)) {
      if (name.startsWith(".") && name !== ".bin") continue;
      if (name.startsWith("@") || name === ".bin") {
        mkdirSync(resolve(modules, name));
        for (const child of readdirSync(resolve(installed, name))) link(`${name}/${child}`);
      } else link(name);
    }
  }
}
