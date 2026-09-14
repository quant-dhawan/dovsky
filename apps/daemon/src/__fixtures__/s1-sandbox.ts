import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { gitBytes } from '../git.js';
import { captureBaseline } from '../job-delta.js';
import { BubblewrapIsolation } from '../sandbox.js';
import { SystemdScopeExecutor } from '../execution-scope.js';
import type { CommandSpec, ExecutionHandle, IsolationAvailability, IsolationRequest } from '../isolation.js';
import { enrolled, limits } from './s1-scope.js';

export function directoryFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dovsky-s1-'));
  const project = join(root, 'project'), admin = join(root, 'admin'), sandboxRoot = join(root, 'sandboxes'), home = join(root, 'operator');
  for (const path of [project, admin, sandboxRoot, home]) mkdirSync(path, { mode: 0o700 });
  t.after(() => {
    const writable = (path: string): void => {
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
      }
    };
    writable(root); rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(admin, 'state.db'), 'hidden');
  return { root, project, admin, sandboxRoot, home };
}

export function treeFixture(t: TestContext) {
  const tree = directoryFixture(t), { project } = tree;
  gitBytes(project, ['init', '-q']);
  gitBytes(project, ['config', 'user.name', 'S1 fixture']); gitBytes(project, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(project, 'tracked.txt'), 'baseline\n'); writeFileSync(join(project, '.gitignore'), 'node_modules/\n');
  gitBytes(project, ['add', '.']); gitBytes(project, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline']);
  return tree;
}

export function planFixture(t: TestContext) {
  const tree = directoryFixture(t);
  const sandboxDir = join(tree.sandboxRoot, 'private'); mkdirSync(sandboxDir);
  const privateRepo = join(sandboxDir, 'repo'), runDirectory = join(sandboxDir, 'run');
  const homeDirectory = join(sandboxDir, 'home'), tmpDirectory = join(sandboxDir, 'tmp');
  for (const path of [privateRepo, runDirectory, homeDirectory, tmpDirectory]) mkdirSync(path);
  const jobSocketPath = join(tree.admin, 'job.sock'); writeFileSync(jobSocketPath, 'path-only mount fixture');
  const context = { privateRepo, sandboxDir, runDirectory, homeDirectory, tmpDirectory,
    visibleCwd: tree.project, projectPath: tree.project, jobSocketPath, readOnly: false,
    operatorHome: tree.home, hiddenPaths: [tree.admin, tree.sandboxRoot], config: limits };
  return { ...tree, context };
}

export class FixtureExecutor extends SystemdScopeExecutor {
  readonly commands: CommandSpec[] = [];
  state: 'alive' | 'absent' | 'unverifiable' = 'absent';
  failure: Error | null = null;
  override async start(spec: CommandSpec): Promise<ExecutionHandle> {
    this.commands.push(spec);
    if (this.failure) throw this.failure;
    await spec.onEnrolled(enrolled);
    this.state = 'alive';
    const result = { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, cancelled: false };
    return { ...enrolled, result: Promise.resolve(result), completion: new Promise(() => undefined),
      observe: async () => ({ state: this.state, members: this.state === 'alive' ? [42] : [], reason: null }),
      signal: async () => { this.state = 'absent'; } };
  }
}
/** Explicit fixture injection provides no host-readiness evidence. */
class FixtureIsolation extends BubblewrapIsolation {
  override async available(): Promise<IsolationAvailability> { return { available: true, backend: 'bwrap', reason: null, bwrapVersion: 'fixture only' }; }
}
export async function preparedFixture(t: TestContext, readOnly = false) {
  const tree = treeFixture(t);
  const server = createServer(client => client.end('S1_READY'));
  const socket = join(tree.admin, 'job.sock');
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  writeFileSync(join(tree.project, 'tracked.txt'), 'dirty baseline\n');
  writeFileSync(join(tree.project, 'initial.bin'), Buffer.from([0, 255, 42]));
  writeFileSync(join(tree.project, 'initial.sh'), '#!/bin/sh\n', { mode: 0o755 });
  symlinkSync('tracked.txt', join(tree.project, 'initial-link'));
  const baseline = captureBaseline(tree.project, join(tree.root, 'baseline'));
  const executor = new FixtureExecutor();
  const isolation = new FixtureIsolation({ sandboxRoot: tree.sandboxRoot, hiddenPaths: [tree.admin], operatorHome: tree.home, executor });
  const request: IsolationRequest = { jobId: 'fixture', projectPath: tree.project, visibleCwd: tree.project, baseline, readOnly, config: limits, jobSocketPath: socket };
  const handle = await isolation.prepare(request);
  return { ...tree, executor, isolation, request, handle, socket };
}
