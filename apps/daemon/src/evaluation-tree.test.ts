import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { assertPrivateRepository, gitBytes, gitText, treeFingerprint } from "./git.js";
import { captureBaseline, materializeBaseline } from "./job-delta.js";
import { EvaluationDependencyError, prepareEvaluationDependencies, prepareEvaluationTree, type EvaluationDependencyInstall, type EvaluationDependencyRequest } from "./evaluation-tree.js";

const put = (path: string, content: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const hash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const lock = (version: string): string => JSON.stringify({ name: "s2-fixture", lockfileVersion: 3,
  packages: { "": { name: "s2-fixture", version }, "node_modules/example": { version } } });

function fixture(t: TestContext, withGit = true) {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-s2-dependencies-"));
  const project = resolve(root, "project"), arm = resolve(root, "arm"), cache = resolve(root, "cache");
  mkdirSync(project); mkdirSync(cache);
  put(resolve(project, ".gitignore"), "node_modules/\n");
  put(resolve(project, "package.json"), JSON.stringify({ name: "s2-fixture", version: "1.0.0", private: true }));
  put(resolve(project, "package-lock.json"), lock("1.0.0"));
  put(resolve(project, "tracked.txt"), "original");
  // Foundation baselines are immutable; remove our own disposable fixture permissions on cleanup.
  t.after(() => {
    for (const directory of [resolve(root, "baseline"), resolve(root, "baseline/blobs")]) {
      if (existsSync(directory)) chmodSync(directory, 0o700);
    }
    rmSync(root, { recursive: true, force: true });
  });
  if (withGit) {
    gitBytes(project, ["init", "-q"]);
    gitBytes(project, ["add", "."]);
    gitBytes(project, ["-c", "user.name=S2 Fixture", "-c", "user.email=s2@example.invalid", "commit", "-qm", "fixture"]);
    const snapshot = captureBaseline(project, resolve(root, "baseline"));
    materializeBaseline(project, arm, snapshot);
  } else cpSync(project, arm, { recursive: true });
  const calls: EvaluationDependencyInstall[] = [];
  const install: EvaluationDependencyRequest["install"] = async command => {
    calls.push(command);
    put(resolve(command.cwd, "node_modules/example/index.js"), "cached");
    return { exitCode: 0, timedOut: false };
  };
  const request: EvaluationDependencyRequest = { projectPath: project, armPath: arm, dependencyRoots: ["node_modules"],
    cacheRoot: cache, mode: "bwrap", network: true, install };
  const installed = (): void => put(resolve(project, "node_modules/example/index.js"), "canonical");
  const changed = (): void => put(resolve(arm, "package-lock.json"), lock("2.0.0"));
  return { root, project, arm, cache, calls, request, installed, changed };
}

const broken = async (request: EvaluationDependencyRequest, reason: RegExp): Promise<void> => {
  await assert.rejects(prepareEvaluationDependencies(request), error => {
    assert.ok(error instanceof EvaluationDependencyError);
    assert.equal(error.code, "gate_broken");
    assert.match(error.message, reason);
    return true;
  });
};

test("equal arm locks select exact canonical directories without installing or changing either tree", async t => {
  const f = fixture(t, false); f.installed();
  const before = hash(resolve(f.project, "package-lock.json")), armBefore = hash(resolve(f.arm, "package-lock.json"));
  const mounts = await prepareEvaluationDependencies({ ...f.request, network: false });
  assert.deepEqual(mounts, [{ source: resolve(f.project, "node_modules"), relativePath: "node_modules", lockHash: hash(resolve(f.arm, "package-lock.json")) }]);
  assert.equal(f.calls.length, 0);
  assert.equal(Object.isFrozen(mounts), true); assert.equal(Object.isFrozen(mounts[0]), true);
  assert.equal(hash(resolve(f.project, "package-lock.json")), before); assert.equal(hash(resolve(f.arm, "package-lock.json")), armBefore);
  assert.equal(readFileSync(resolve(f.project, "node_modules/example/index.js"), "utf8"), "canonical");
  assert.deepEqual(readdirSync(f.cache), []);
  assert.equal(existsSync(resolve(f.arm, "node_modules")), false);
  assert.deepEqual(await prepareEvaluationDependencies({ ...f.request, mode: "worktree" }), mounts);
});

test("changed locks install in a complete private snapshot and reuse only a complete cache offline", async t => {
  const f = fixture(t); f.installed(); f.changed();
  put(resolve(f.arm, "tracked.txt"), "dirty arm");
  put(resolve(f.arm, "packages/local/package.json"), '{"name":"local"}');
  put(resolve(f.arm, "packages/local/data.txt"), "untracked arm");
  const before = treeFingerprint(f.project), armBefore = treeFingerprint(f.arm);
  const request = { ...f.request, install: async (command: EvaluationDependencyInstall) => {
    assertPrivateRepository(command.cwd);
    assert.equal(command.treePath, command.cwd);
    assert.equal(readFileSync(resolve(command.cwd, "tracked.txt"), "utf8"), "dirty arm");
    assert.equal(readFileSync(resolve(command.cwd, "packages/local/data.txt"), "utf8"), "untracked arm");
    assert.deepEqual(command.argv, ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", command.cwd]);
    assert.equal(command.timeoutMs, 120000); assert.equal(command.maxOutputBytes, 1048576); assert.equal(command.network, true);
    assert.notEqual(command.cwd, f.arm); assert.notEqual(command.cwd, f.project);
    return f.request.install(command);
  } };
  const mounts = await prepareEvaluationDependencies(request);
  assert.equal(f.calls.length, 1);
  assert.equal(mounts[0]!.lockHash, hash(resolve(f.arm, "package-lock.json")));
  assert.equal(relative(f.cache, mounts[0]!.source).split("/").length, 3);
  assert.equal(readFileSync(resolve(mounts[0]!.source, "example/index.js"), "utf8"), "cached");
  assert.equal(readFileSync(resolve(f.project, "node_modules/example/index.js"), "utf8"), "canonical");
  assert.equal(treeFingerprint(f.project), before); assert.equal(treeFingerprint(f.arm), armBefore);
  assert.deepEqual(await prepareEvaluationDependencies({ ...request, network: false }), mounts);
  assert.equal(f.calls.length, 1);
  assert.equal(readdirSync(f.cache).length, 1);
});

test('runtime-invalidated canonical modules cannot be readmitted by equality after lock application', async t => {
  const f = fixture(t); f.installed(); f.changed();
  // The new lock has been applied; the canonical installation still contains the old dependency bytes.
  writeFileSync(resolve(f.project, 'package-lock.json'), readFileSync(resolve(f.arm, 'package-lock.json')));
  const request = Object.assign({}, f.request, { allowCanonicalDependencies: false });
  const mounts = await prepareEvaluationDependencies(request);
  assert.equal(f.calls.length, 1, 'A runtime-invalidated installation needs a matching cache/private install');
  assert.notEqual(mounts[0]!.source, resolve(f.project, 'node_modules'));
  assert.equal(readFileSync(resolve(mounts[0]!.source, 'example/index.js'), 'utf8'), 'cached');
  assert.equal(readFileSync(resolve(f.project, 'node_modules/example/index.js'), 'utf8'), 'canonical');
  assert.deepEqual(await prepareEvaluationDependencies({ ...request, network: false }), mounts);
});

test("source changes with the same lock get a new cache for copied local packages", async t => {
  const f = fixture(t); f.installed(); f.changed();
  const first = await prepareEvaluationDependencies(f.request);
  put(resolve(f.arm, "local.txt"), "new local source");
  await broken({ ...f.request, network: false }, /network-disabled/);
  const second = await prepareEvaluationDependencies(f.request);
  assert.notEqual(first[0]!.source, second[0]!.source); assert.equal(f.calls.length, 2);
  assert.equal(existsSync(first[0]!.source), true);
});

test("plain projects can omit missing dependencies but installed roots require both locks", async t => {
  const f = fixture(t, false);
  rmSync(resolve(f.project, "package-lock.json")); rmSync(resolve(f.arm, "package-lock.json"));
  assert.deepEqual(await prepareEvaluationDependencies(f.request), []);
  f.installed();
  await broken(f.request, /lockfile missing/);
  put(resolve(f.project, "package-lock.json"), lock("1.0.0"));
  await broken(f.request, /lockfile missing/);
  put(resolve(f.arm, "package-lock.json"), lock("1.0.0"));
  rmSync(resolve(f.project, "package-lock.json"));
  await broken(f.request, /lockfile missing/);
  assert.equal(f.calls.length, 0);
});

test("worktree mismatch and offline cache miss refuse before any installer call", async t => {
  const f = fixture(t); f.installed(); f.changed();
  await broken({ ...f.request, mode: "worktree" }, /worktree dependency lock mismatch/);
  await broken({ ...f.request, network: false }, /network-disabled/);
  assert.equal(f.calls.length, 0); assert.deepEqual(readdirSync(f.cache), []);
});

test("worktree lock mismatch refuses without needing Git or a cache", async t => {
  const f = fixture(t, false); f.installed(); f.changed();
  await broken({ ...f.request, mode: "worktree" }, /worktree dependency lock mismatch/);
  assert.equal(f.calls.length, 0); assert.deepEqual(readdirSync(f.cache), []);
});

test("roots reject absolute, traversal, administrative, overlapping and symlink paths", async t => {
  const f = fixture(t, false); f.installed();
  for (const root of ["/node_modules", "../node_modules", "./node_modules", "a/../node_modules", "a//node_modules",
    "a\\node_modules", ".git/node_modules", ".cache/node_modules", ".dovsky/node_modules", "node_modules/x/node_modules", "src", "node_modules/", "x\0/node_modules"]) {
    await broken({ ...f.request, dependencyRoots: [root] }, /invalid dependency root/);
  }
  symlinkSync(f.project, resolve(f.arm, "alias"));
  await broken({ ...f.request, dependencyRoots: ["alias/node_modules"] }, /Unsafe tree ancestor/);
  symlinkSync(resolve(f.project, "node_modules"), resolve(f.arm, "node_modules"));
  await broken(f.request, /not a real directory/);
  for (const cacheRoot of [f.project, resolve(f.project, "cache"), f.arm, f.root]) await broken({ ...f.request, cacheRoot }, /dedicated/);
  assert.equal(f.calls.length, 0);
});

test('canonical mounts reject predecessor and current administrative directories', async t => {
  for (const name of ['.agentbus', '.dovsky']) {
    const f = fixture(t, false); f.installed();
    put(resolve(f.project, `node_modules/${name}/private`), 'secret');
    await broken(f.request, /administrative/);
    assert.equal(f.calls.length, 0, name);
  }
});

test("symlink lockfiles and cache roots are refused without following them", async t => {
  const f = fixture(t, false); f.installed();
  rmSync(resolve(f.arm, "package-lock.json"));
  symlinkSync(resolve(f.project, "package-lock.json"), resolve(f.arm, "package-lock.json"));
  await broken(f.request, /symbolic|ELOOP/i);
  rmSync(resolve(f.arm, "package-lock.json")); f.changed();
  const alias = resolve(f.root, "cache-alias"); symlinkSync(f.cache, alias);
  await broken({ ...f.request, cacheRoot: alias }, /Unsafe directory ancestor/);
  assert.deepEqual(readdirSync(f.cache), []);
});

test("nearest workspace locks select canonical and cached roots independently", async t => {
  const f = fixture(t); f.installed();
  for (const tree of [f.arm, f.project]) {
    put(resolve(tree, "packages/tool/package.json"), '{"name":"tool"}');
    put(resolve(tree, "packages/tool/package-lock.json"), lock(tree === f.arm ? "2.0.0" : "1.0.0"));
  }
  put(resolve(f.project, "packages/tool/node_modules/example/index.js"), "canonical workspace");
  const mounts = await prepareEvaluationDependencies({ ...f.request, dependencyRoots: ["node_modules", "packages/tool/node_modules"] });
  assert.equal(mounts[0]!.source, resolve(f.project, "node_modules"));
  assert.equal(mounts[1]!.relativePath, "packages/tool/node_modules");
  assert.equal(mounts[1]!.lockHash, hash(resolve(f.arm, "packages/tool/package-lock.json")));
  assert.match(f.calls[0]!.cwd, /\/tree\/packages\/tool$/); assert.equal(f.calls.length, 1);
  assert.equal(relative(f.calls[0]!.treePath, f.calls[0]!.cwd), "packages/tool");
});

test("workspace roots sharing their ancestor lock use one complete installation", async t => {
  const f = fixture(t); f.installed(); f.changed();
  put(resolve(f.arm, "packages/tool/package.json"), '{"name":"tool"}');
  const mounts = await prepareEvaluationDependencies({ ...f.request, dependencyRoots: ["node_modules", "packages/tool/node_modules"],
    install: async command => { put(resolve(command.cwd, "packages/tool/node_modules/inner/index.js"), "inner"); return f.request.install(command); } });
  assert.equal(mounts.length, 2); assert.equal(f.calls.length, 1);
  assert.equal(mounts[0]!.lockHash, mounts[1]!.lockHash);
});

test("failed, thrown, timed-out and incomplete installs clean only their own population", async t => {
  const f = fixture(t); f.installed(); f.changed();
  const sentinel = resolve(f.cache, "unknown/sentinel"); put(sentinel, "retain");
  const outcomes = [
    async () => ({ exitCode: 1, timedOut: false }),
    async () => ({ exitCode: 0, timedOut: true }),
    async () => { throw new Error("fake installer failure"); },
    async () => ({ exitCode: 0, timedOut: false }),
  ];
  for (const install of outcomes) {
    await broken({ ...f.request, install }, /failed|failure|omitted/);
    assert.deepEqual(readdirSync(f.cache), ["unknown"]);
    assert.equal(readFileSync(sentinel, "utf8"), "retain");
  }
});

test("malformed cache entries and modified cached locks are preserved and refused", async t => {
  const f = fixture(t); f.installed(); f.changed();
  const [mount] = await prepareEvaluationDependencies(f.request);
  const entry = dirname(dirname(mount!.source)), marker = resolve(entry, "complete.json");
  const original = readFileSync(marker);
  chmodSync(marker, 0o600); writeFileSync(marker, "{}");
  await broken(f.request, /unknown or incomplete/);
  assert.equal(readFileSync(marker, "utf8"), "{}"); assert.equal(f.calls.length, 1);
  writeFileSync(marker, original);
  put(resolve(entry, "tree/package-lock.json"), "tampered");
  await broken(f.request, /cached dependency lock changed/);
  assert.equal(readFileSync(resolve(entry, "tree/package-lock.json"), "utf8"), "tampered");
});

test("simultaneous identical requests publish once and never expose partial dependencies", async t => {
  const f = fixture(t); f.installed(); f.changed();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let installs = 0;
  const request = { ...f.request, install: async (command: EvaluationDependencyInstall) => {
    installs++; put(resolve(command.cwd, "node_modules/partial"), "partial"); enter();
    await blocked;
    return f.request.install(command);
  } };
  const first = prepareEvaluationDependencies(request);
  await entered;
  const second = prepareEvaluationDependencies(request);
  assert.equal(readdirSync(f.cache).some(name => /^[a-f0-9]/.test(name)), false);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.equal(installs, 1); assert.equal(readdirSync(f.cache).length, 1);
});

test("an unknown cache appearing during install is retained rather than overwritten", async t => {
  const f = fixture(t); f.installed(); f.changed();
  await broken({ ...f.request, install: async command => {
    const key = readdirSync(f.cache).find(name => name.startsWith(".s2-lock-"))!.slice(".s2-lock-".length);
    mkdirSync(resolve(f.cache, key));
    return f.request.install(command);
  } }, /appeared/);
  const entries = readdirSync(f.cache);
  assert.equal(entries.length, 1); assert.deepEqual(readdirSync(resolve(f.cache, entries[0]!)), []);
  await broken(f.request, /ENOENT/);
  assert.equal(f.calls.length, 1);
});

test("relative workspace and .bin links resolve against the arm for canonical and cached mounts", async t => {
  const f = fixture(t); f.installed();
  for (const tree of [f.project, f.arm]) put(resolve(tree, "packages/tool/package.json"), '{"name":"@local/tool"}');
  const links = (tree: string): void => {
    mkdirSync(resolve(tree, "node_modules/@local"), { recursive: true }); mkdirSync(resolve(tree, "node_modules/.bin"), { recursive: true });
    symlinkSync("../../packages/tool", resolve(tree, "node_modules/@local/tool"));
    symlinkSync("../@local/tool/dist/cli.js", resolve(tree, "node_modules/.bin/tool"));
  };
  links(f.project);
  const canonical = await prepareEvaluationDependencies(f.request);
  f.changed();
  const cached = await prepareEvaluationDependencies({ ...f.request, install: async command => {
    links(command.cwd); return f.request.install(command);
  } });
  for (const [index, mounts] of [canonical, cached].entries()) {
    const source = mounts[0]!.source, view = resolve(f.root, `stable-view-${index}`);
    mkdirSync(view);
    cpSync(source, resolve(view, "node_modules"), { recursive: true, verbatimSymlinks: true });
    put(resolve(view, "packages/tool/dist/cli.js"), "arm executable");
    assert.equal(readlinkSync(resolve(view, "node_modules/@local/tool")), "../../packages/tool");
    assert.equal(readlinkSync(resolve(view, "node_modules/.bin/tool")), "../@local/tool/dist/cli.js");
    assert.equal(realpathSync(resolve(view, "node_modules/.bin/tool")), resolve(view, "packages/tool/dist/cli.js"));
    assert.equal(existsSync(resolve(dirname(source), "packages/tool/dist/cli.js")), false);
  }
});

test("canonical workspace links permit missing arm build output and retain relative .bin chains", async t => {
  const f = fixture(t, false); f.installed();
  put(resolve(f.arm, "packages/tool/package.json"), '{"name":"@local/tool"}');
  mkdirSync(resolve(f.project, "node_modules/@local")); mkdirSync(resolve(f.project, "node_modules/.bin"));
  symlinkSync("../../packages/tool", resolve(f.project, "node_modules/@local/tool"));
  symlinkSync("../@local/tool/dist/cli.js", resolve(f.project, "node_modules/.bin/tool"));
  const [mount] = await prepareEvaluationDependencies(f.request);
  assert.equal(mount!.source, resolve(f.project, "node_modules"));
  cpSync(mount!.source, resolve(f.arm, "node_modules"), { recursive: true, verbatimSymlinks: true });
  put(resolve(f.arm, "packages/tool/dist/cli.js"), "arm executable");
  assert.equal(readlinkSync(resolve(f.arm, "node_modules/.bin/tool")), "../@local/tool/dist/cli.js");
  assert.equal(realpathSync(resolve(f.arm, "node_modules/.bin/tool")), resolve(f.arm, "packages/tool/dist/cli.js"));
  assert.equal(existsSync(resolve(f.project, "packages/tool/dist/cli.js")), false);
});

test("escaping, absolute, administrative, cyclic and dangling dependency links refuse", async t => {
  const f = fixture(t, false); f.installed();
  const link = resolve(f.project, "node_modules/unsafe");
  for (const target of ["../../outside", resolve(f.project, "tracked.txt"), "../.git/config", "unsafe", "missing"]) {
    symlinkSync(target, link);
    await broken(f.request, /escape|relative|administrative|loop|missing/);
    rmSync(link);
  }
  put(resolve(f.arm, "packages/tool/package.json"), '{}');
  symlinkSync("../../../../outside", resolve(f.arm, "packages/tool/escape"));
  symlinkSync("../packages/tool/escape", link);
  await broken(f.request, /escapes/);
});

test("invalid installed outputs are not published and cache hits revalidate links", async t => {
  const f = fixture(t); f.installed(); f.changed();
  await broken({ ...f.request, install: async command => {
    mkdirSync(resolve(command.cwd, "node_modules")); symlinkSync(f.project, resolve(command.cwd, "node_modules/escape"));
    return { exitCode: 0, timedOut: false };
  } }, /relative/);
  assert.deepEqual(readdirSync(f.cache), []);
  const mounts = await prepareEvaluationDependencies(f.request);
  symlinkSync("../../../../outside", resolve(mounts[0]!.source, "escape"));
  await broken({ ...f.request, network: false }, /escapes/);
  assert.equal(f.calls.length, 1);
});

test("legacy prepareEvaluationTree remains callable with its existing signature", t => {
  const f = fixture(t); f.installed();
  const target = resolve(f.root, "legacy");
  prepareEvaluationTree(f.project, target, gitText(f.project, ["rev-parse", "HEAD"]), Buffer.alloc(0), [], f.project);
  assert.equal(lstatSync(resolve(target, "node_modules/example")).isSymbolicLink(), true);
  assert.equal(readFileSync(resolve(target, "node_modules/example/index.js"), "utf8"), "canonical");
});
