import { accessSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readSync, readdirSync, readlinkSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { SandboxConfig } from '@dovsky/protocol';
import { assertRealDirectory, readRegularFile, safeTreePath } from './file-state.js';
import { captureDelta, materializeBaseline } from './job-delta.js';
import type { CommandSpec, IsolationAvailability, IsolationHandle, IsolationRequest, JobIsolation, ExecutionHandle, ReadonlyDependencyMount } from './isolation.js';
import { observeScope, ScopeStartError, SystemdScopeExecutor, validateLimits } from './execution-scope.js';
import { acquireProviderHome, validateProviderStateKey, type ProviderHomeOwnership } from './provider-home.js';

export interface SandboxOptions {
  /** Dedicated daemon-owned directory, outside every canonical project/baseline. */
  sandboxRoot: string;
  /** Root supplies operator socket/database directories, artifacts and other admin roots. */
  hiddenPaths: string[];
  operatorHome?: string;
  executor?: SystemdScopeExecutor;
}
export interface SandboxMount { source: string; target: string; readOnly: boolean; }
export interface SandboxPlan { argv: string[]; mounts: SandboxMount[]; env: NodeJS.ProcessEnv; }
interface MountContext {
  privateRepo: string;
  sandboxDir: string;
  runDirectory: string;
  homeDirectory: string;
  tmpDirectory: string;
  visibleCwd: string;
  projectPath: string;
  jobSocketPath: string;
  readOnly: boolean;
  operatorHome: string;
  hiddenPaths: string[];
  config: SandboxConfig;
  dependencyMounts?: readonly ReadonlyDependencyMount[];
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};
const overlaps = (a: string, b: string): boolean => inside(a, b) || inside(b, a);
function absolute(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) throw new Error(`Expected normalized absolute path: ${path}`);
  return path;
}
function prefix(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const data = Buffer.alloc(4096); return data.subarray(0, readSync(fd, data, 0, data.length, 0)).toString(); }
  finally { closeSync(fd); }
}

interface RuntimeTree {
  root: string;
  visibleRoot: string;
  resolve(path: string, allowMissing?: boolean): { logical: string; physical: string };
}

/** Resolve links in the mounted tree, never through the cache's/canonical tree's workspace links. */
function dependencyTree(c: MountContext): RuntimeTree {
  const mounts = c.dependencyMounts ?? [];
  const physical = (path: string): string => {
    const mount = mounts.find(m => inside(join(c.privateRepo, m.relativePath), path));
    return mount ? join(mount.source, relative(join(c.privateRepo, mount.relativePath), path)) : path;
  };
  return { root: c.privateRepo, visibleRoot: c.visibleCwd, resolve: (path, allowMissing = false) => {
      if (!inside(c.privateRepo, path)) throw new Error('Dependency link escapes the private project');
      const parts = relative(c.privateRepo, path).split('/');
      let logical = c.privateRepo, links = 0;
      while (parts.length) {
        const part = parts.shift()!;
        if (!part || part === '.') continue;
        if (part.toLowerCase() === '.git' || (part === '..' && logical === c.privateRepo)) throw new Error('Dependency link escapes the private project or exposes Git administration');
        if (part === '..') { logical = dirname(logical); continue; }
        logical = join(logical, part);
        const file = physical(logical);
        let stat;
        try { stat = lstatSync(file); }
        catch (error) {
          // A workspace build may create a not-yet-existing dist entrypoint.
          if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT'
            && !mounts.some(m => inside(join(c.privateRepo, m.relativePath), logical))) {
            const target = resolve(logical, ...parts);
            if (!inside(c.privateRepo, target) || parts.some(p => p === '..' || p.toLowerCase() === '.git')) throw new Error('Dependency link escapes the private project');
            return { logical: target, physical: physical(target) };
          }
          throw error;
        }
        if (stat.isSymbolicLink()) {
          const link = readlinkSync(file);
          if (isAbsolute(link) || link.includes('\0') || ++links > 40) throw new Error('Unsafe dependency link');
          logical = dirname(logical);
          parts.unshift(...link.split('/'));
          continue;
        }
        if ((!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) throw new Error('Dependency path contains a hardlink or special file');
        if (parts.length && !stat.isDirectory()) throw new Error('Dependency path ancestor is not a directory');
      }
      return { logical, physical: physical(logical) };
  } };
}

/** Each mount is identified by its nearest private-tree lock, as in the dependency planner. */
function nearestDependencyLockHash(tree: string, relativePath: string): string {
  let directory = dirname(relativePath);
  while (true) {
    const path = safeTreePath(tree, join(directory, 'package-lock.json'));
    if (lstatSync(path, { throwIfNoEntry: false })) {
      return createHash('sha256').update(readRegularFile(path, 16 * 1024 * 1024)).digest('hex');
    }
    if (directory === '.') throw new Error(`Dependency lockfile missing: ${relativePath}`);
    directory = dirname(directory);
  }
}

function validateDependencyMounts(c: MountContext): RuntimeTree {
  if (!Array.isArray(c.dependencyMounts)) throw new Error('Dependency mounts must be an explicit array');
  const mounts: readonly ReadonlyDependencyMount[] = c.dependencyMounts;
  for (const mount of mounts) {
    if (!mount || typeof mount.source !== 'string' || typeof mount.relativePath !== 'string'
      || typeof mount.lockHash !== 'string' || !/^[a-f0-9]{64}$/.test(mount.lockHash)) throw new Error('Invalid dependency mount or lock hash mismatch');
    const parts = mount.relativePath.split('/');
    if (isAbsolute(mount.relativePath) || mount.relativePath.includes('\0') || mount.relativePath.includes('\\')
      || parts.at(-1) !== 'node_modules' || parts.some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')
      || parts.slice(0, -1).includes('node_modules')) throw new Error('Invalid relative dependency target');
    const source = absolute(mount.source);
    assertRealDirectory(source);
    if (basename(source) !== 'node_modules' || source.split('/').some(p => p.toLowerCase() === '.git')
      || c.hiddenPaths.some(path => overlaps(path, source)) || overlaps(source, c.privateRepo)
      || inside(source, c.operatorHome) || inside(source, c.projectPath)
      || (inside(c.projectPath, source) && source !== join(c.projectPath, mount.relativePath))) throw new Error('Dependency source exposes a protected or non-exact directory');
    const target = safeTreePath(c.privateRepo, mount.relativePath);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Unsafe dependency mount target');
    if (c.hiddenPaths.some(path => overlaps(path, join(c.visibleCwd, mount.relativePath)))) throw new Error('Dependency target exposes administration');
    if (mount.lockHash !== nearestDependencyLockHash(c.privateRepo, mount.relativePath)) throw new Error('Dependency lock hash mismatch');
  }
  for (let i = 0; i < mounts.length; i++) for (let j = i + 1; j < mounts.length; j++) {
    if (overlaps(mounts[i]!.source, mounts[j]!.source)
      || overlaps(join(c.privateRepo, mounts[i]!.relativePath), join(c.privateRepo, mounts[j]!.relativePath))) throw new Error('Overlapping dependency mounts');
  }
  const tree = dependencyTree(c);
  let entries = 0;
  const inspect = (source: string, logical: string, depth: number): void => {
    if (++entries > 500_000 || depth > 128) throw new Error('Dependency tree exceeds validation bound');
    if (basename(source).toLowerCase() === '.git') throw new Error('Dependency tree exposes Git administration');
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) { tree.resolve(logical, true); return; }
    if (stat.isDirectory()) {
      for (const name of readdirSync(source)) inspect(join(source, name), join(logical, name), depth + 1);
    } else if (!stat.isFile() || stat.nlink !== 1) throw new Error('Dependency tree contains a hardlink or special file');
  };
  for (const mount of mounts) inspect(mount.source, join(c.privateRepo, mount.relativePath), 0);
  return tree;
}

/** Resolve the executable target, including a script's ordinary interpreter. */
export function resolveRuntime(argv: string[], env: NodeJS.ProcessEnv, cwd: string, tree?: RuntimeTree): { argv: string[]; files: string[]; packageRoots: string[] } {
  const files = new Set<string>();
  const packageRoots = new Set<string>();
  const locate = (path: string): { logical: string; physical: string } => tree && inside(tree.root, path)
    ? tree.resolve(path) : { logical: realpathSync(path), physical: realpathSync(path) };
  const find = (name: string): string => {
    const paths = (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':');
    const candidates = name.includes('/') ? [resolve(cwd, name)] : (tree ? paths.map(path => resolve(cwd, path)) : paths.filter(isAbsolute)).map(path => join(path, name));
    for (const path of candidates) {
      const candidate = tree && inside(tree.visibleRoot, path) ? join(tree.root, relative(tree.visibleRoot, path)) : path;
      try {
        const actual = locate(candidate);
        if (!lstatSync(actual.physical).isFile()) continue;
        accessSync(actual.physical, constants.X_OK);
        // PATH and shebang aliases must remain resolvable inside the namespace.
        files.add(candidate);
        return actual.logical;
      } catch { /* Try the next explicit PATH directory. */ }
    }
    throw new Error(`Executable is unavailable: ${name}`);
  };
  const inspect = (path: string, depth: number): void => {
    if (depth > 4) throw new Error('Interpreter chain exceeds bound');
    if (inspected.has(path)) return;
    inspected.add(path);
    files.add(path);
    const head = prefix(locate(path).physical);
    if (!head.startsWith('#!')) return;
    // Installed JS entrypoints commonly resolve ../lib or ../vendor from their
    // real package location. Mount only the containing package, never its home.
    if ((!tree || !inside(tree.root, path)) && /^#![^\n]*\bnode(?:js)?\b/.test(head)) {
      let parent = dirname(path);
      for (let i = 0; i < 8 && parent !== '/'; i++, parent = dirname(parent)) {
        if (existsSync(join(parent, 'package.json'))) { packageRoots.add(parent); break; }
      }
    }
    const line = head.slice(2, head.indexOf('\n') < 0 ? undefined : head.indexOf('\n')).trim();
    const parts = line.split(/\s+/);
    const interpreter = parts[0];
    if (!interpreter || !isAbsolute(interpreter)) throw new Error('Script needs an absolute interpreter');
    inspect(find(interpreter), depth + 1);
    if (interpreter.endsWith('/env')) {
      const command = parts[1] === '-S' ? parts.slice(2) : parts.slice(1);
      if (!command[0] || command[0].startsWith('-') || command.some(value => /["'\\=]/.test(value))) throw new Error('Unsupported env interpreter; configure an explicit runtime command');
      inspect(find(command[0]), depth + 1);
    }
  };
  const inspected = new Set<string>();
  if (!argv[0]) throw new Error('Empty sandbox command');
  const executable = find(argv[0]);
  inspect(executable, 0);
  return { argv: [executable, ...argv.slice(1)], files: [...files], packageRoots: [...packageRoots] };
}

/** Pure mount/argv construction apart from resolving readonly host paths. */
export function buildSandboxPlan(context: MountContext, spec: CommandSpec): SandboxPlan {
  const c = context;
  if (c.config.enabled !== true || c.config.backend !== 'bwrap' || typeof c.config.network !== 'boolean') throw new Error('Production execution requires bubblewrap');
  validateLimits(c.config);
  const cwd = absolute(spec.cwd);
  if (!inside(c.visibleCwd, cwd)) throw new Error('Command cwd is outside the private project view');
  // A caller uses the stable project path even when the executable is in that tree.
  const hostCwd = join(c.privateRepo, relative(c.visibleCwd, cwd));
  assertRealDirectory(hostCwd);
  const tree = c.dependencyMounts === undefined ? undefined : validateDependencyMounts(c);
  const dependencyRoots = c.dependencyMounts === undefined ? c.config.dependencyRoots : [];
  const requested = [...spec.argv];
  if (requested[0] && isAbsolute(requested[0]) && inside(c.visibleCwd, requested[0])) requested[0] = join(c.privateRepo, relative(c.visibleCwd, requested[0]));
  // Resolve project-local PATH entries in the immutable private baseline, while
  // retaining their stable provider-visible paths in the execution environment.
  const runtimeEnv = { ...spec.env };
  if (runtimeEnv.PATH !== undefined) runtimeEnv.PATH = runtimeEnv.PATH.split(':').map(path =>
    isAbsolute(path) && inside(c.visibleCwd, path) ? join(c.privateRepo, relative(c.visibleCwd, path)) : path).join(':');
  const runtime = resolveRuntime(requested, runtimeEnv, hostCwd, tree);
  const mounts: SandboxMount[] = [];
  const hidden = c.hiddenPaths.map(absolute);
  const addReadonly = (source: string, target = source): void => {
    absolute(source); absolute(target);
    const actual = realpathSync(source);
    const stat = lstatSync(actual);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Readonly mount is not a file or directory: ${source}`);
    if (['/', '/home', '/root', '/run', '/etc', '/var', '/tmp', c.operatorHome].includes(actual)
      || hidden.some(path => overlaps(path, actual) || overlaps(path, target))
      || inside(actual, c.projectPath) || inside(actual, c.privateRepo)) throw new Error(`Readonly mount exposes a protected root: ${source}`);
    // A dependency child of the canonical project is the only allowed canonical mount.
    if (inside(c.projectPath, actual) && !dependencyRoots.some(path => inside(realpathSync(path), actual))) throw new Error('Canonical project contents are not runtime mounts');
    if (c.dependencyMounts?.some(mount => overlaps(mount.source, actual))) throw new Error('Dependency runtime must use the private project view');
    if (overlaps(target, c.runDirectory) || overlaps(target, '/proc') || overlaps(target, '/dev')) throw new Error('Readonly mount overlaps private infrastructure');
    if (mounts.some(mount => mount.target === target && mount.source !== actual)) throw new Error('Conflicting sandbox mount targets');
    if (!mounts.some(mount => mount.target === target)) mounts.push({ source: actual, target, readOnly: true });
  };
  const systemPaths = ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/bin', '/sbin', '/lib', '/lib64',
    '/usr/share/git-core', '/usr/share/zoneinfo', '/etc/hosts', '/etc/nsswitch.conf', '/etc/resolv.conf',
    '/etc/ssl/certs', '/usr/share/ca-certificates', '/etc/ca-certificates.conf', '/etc/localtime', '/etc/passwd', '/etc/group'];
  for (const path of systemPaths) if (existsSync(path)) addReadonly(path);
  for (const path of [...c.config.runtimePaths, ...dependencyRoots, ...c.config.homePaths]) {
    if (c.config.homePaths.includes(path) && !inside(c.operatorHome, realpathSync(path))) throw new Error('Home mounts must remain under the operator home');
    const target = dependencyRoots.includes(path) && inside(c.projectPath, path)
      ? join(c.visibleCwd, relative(c.projectPath, path)) : path;
    addReadonly(path, target);
  }
  for (const mount of c.dependencyMounts ?? []) {
    const target = join(c.visibleCwd, mount.relativePath);
    if (mounts.some(existing => overlaps(existing.target, target) || overlaps(existing.source, mount.source))) throw new Error('Dependency mount overlaps another runtime mount');
    mounts.push({ source: mount.source, target, readOnly: true });
  }
  for (const path of [...runtime.packageRoots, ...runtime.files]) {
    if (inside(c.privateRepo, path)) continue;
    if (!mounts.some(mount => inside(mount.source, realpathSync(path)) && inside(mount.target, path))) addReadonly(path);
  }
  const command = runtime.argv.map((value, index) => index === 0 && inside(c.privateRepo, value)
    ? join(c.visibleCwd, relative(c.privateRepo, value)) : value);
  const args = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--unshare-cgroup', '--cap-drop', 'ALL', '--hostname', 'dovsky-job'];
  if (!c.config.network) args.push('--unshare-net');
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/run', '--tmpfs', '/var/tmp',
    '--bind', c.tmpDirectory, '/tmp', '--bind', c.homeDirectory, c.operatorHome,
    '--bind', c.privateRepo, c.visibleCwd);
  // Specific dependency/home mounts must follow the private project/HOME mounts.
  for (const mount of mounts.sort((a, b) => a.target.split('/').length - b.target.split('/').length)) args.push('--ro-bind', mount.source, mount.target);
  // Mount setup may need to create ignored dependency mount points in the PRIVATE
  // clone. Seal its project mount before any requested command can execute.
  // Nested dependency mounts are already readonly; private run output stays writable.
  if (c.readOnly) args.push('--remount-ro', c.visibleCwd);
  args.push('--bind', c.runDirectory, c.runDirectory, '--ro-bind', realpathSync(c.jobSocketPath), join(c.runDirectory, 'dovsky.sock'));
  const env: NodeJS.ProcessEnv = { ...spec.env, HOME: c.operatorHome,
    CODEX_HOME: join(c.operatorHome, '.codex'), CLAUDE_CONFIG_DIR: join(c.operatorHome, '.claude'),
    XDG_STATE_HOME: join(c.operatorHome, '.local', 'state'), XDG_CONFIG_HOME: join(c.operatorHome, '.config'),
    XDG_CACHE_HOME: join(c.operatorHome, '.cache'), XDG_DATA_HOME: join(c.operatorHome, '.local', 'share'),
    TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp',
    XDG_RUNTIME_DIR: '/run', DOVSKY_SOCKET: join(c.runDirectory, 'dovsky.sock'), DOVSKY_SANDBOX: '1', PWD: cwd };
  delete env.DOVSKY_EXECUTION_GATE_READY;
  delete env.DOVSKY_EXECUTION_GATE_TIMEOUT_MS;
  delete env.DOVSKY_EXECUTION_COMMAND;
  args.push('--clearenv');
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key) || value.includes('\0')) throw new Error('Invalid sandbox environment');
    args.push('--setenv', key, value);
  }
  args.push('--chdir', cwd, '--', ...command);
  return { argv: ['/usr/bin/bwrap', ...args], mounts: [...mounts,
    { source: c.privateRepo, target: c.visibleCwd, readOnly: c.readOnly },
    { source: c.homeDirectory, target: c.operatorHome, readOnly: false },
    { source: c.tmpDirectory, target: '/tmp', readOnly: false },
    { source: c.runDirectory, target: c.runDirectory, readOnly: false },
    { source: realpathSync(c.jobSocketPath), target: join(c.runDirectory, 'dovsky.sock'), readOnly: true }], env };
}

function removeOwnedTree(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) { unlinkSync(path); return; }
  chmodSync(path, 0o700);
  for (const child of readdirSync(path)) removeOwnedTree(join(path, child));
  rmdirSync(path);
}

export class BubblewrapIsolation implements JobIsolation {
  readonly executor: SystemdScopeExecutor;
  private readonly root: string;
  private readonly hidden: string[];
  private readonly home: string;
  constructor(options: SandboxOptions) {
    this.root = absolute(options.sandboxRoot);
    this.hidden = options.hiddenPaths.map(path => realpathSync(absolute(path)));
    this.home = realpathSync(options.operatorHome ?? homedir());
    this.executor = options.executor ?? new SystemdScopeExecutor();
  }

  async available(): Promise<IsolationAvailability> {
    let bwrapVersion: string | null = null;
    try {
      if (process.platform !== 'linux') throw new Error('Sandbox requires Linux');
      const version = await this.executor.ports.run(['/usr/bin/bwrap', '--version']);
      if (version.exitCode !== 0) throw new Error(`bubblewrap unavailable: ${version.stderr}`);
      bwrapVersion = version.stdout.trim();
      // Local diagnostic only: no user argv, project, credentials or network.
      const config: SandboxConfig = { enabled: true, backend: 'bwrap', network: false, memoryMax: '128M', cpuQuota: '100%', tasksMax: 32,
        homePaths: [], runtimePaths: [], dependencyRoots: [] };
      const args = ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
        '--ro-bind', '/usr/bin', '/usr/bin', '--ro-bind', '/usr/lib', '/usr/lib'];
      for (const path of ['/lib', '/lib64', '/usr/lib64', '/bin']) if (existsSync(path)) args.push('--ro-bind', realpathSync(path), path);
      args.push('--proc', '/proc', '--dev', '/dev', '--clearenv', '--', '/usr/bin/true');
      const handle = await this.executor.start({ argv: args, cwd: '/', env: {}, stdin: '', kind: 'gate', number: 0, timeoutMs: 5000,
        killOnTimeout: true, onEnrolled: () => undefined }, config);
      const result = await handle.result;
      if (result.timedOut || result.exitCode !== 0) throw new Error(`Sandbox diagnostic failed: ${result.stderr || 'timeout/nonzero exit'}`);
      if ((await handle.observe()).state !== 'absent') throw new Error('Sandbox diagnostic scope absence is unconfirmed');
      return { available: true, backend: 'bwrap', reason: null, bwrapVersion };
    } catch (error) { return { available: false, backend: 'bwrap', reason: String(error), bwrapVersion }; }
  }

  async prepare(request: IsolationRequest): Promise<IsolationHandle> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.jobId)) throw new Error('Invalid sandbox job ID');
    if (request.providerStateKey !== undefined) validateProviderStateKey(request.providerStateKey);
    if (request.requireExistingProviderState !== undefined && typeof request.requireExistingProviderState !== 'boolean'
      || request.requireExistingProviderState && request.providerStateKey === undefined) throw new Error('Existing provider state requires an opaque key');
    const projectPath = realpathSync(absolute(request.projectPath));
    const visibleCwd = absolute(request.visibleCwd);
    const baselinePath = realpathSync(request.baseline.directory);
    if (overlaps(this.root, projectPath) || overlaps(this.root, baselinePath)) throw new Error('Sandbox storage overlaps canonical/baseline paths');
    if (['/', this.home, '/run', '/tmp', '/etc', '/usr', '/proc', '/dev'].some(path => inside(visibleCwd, path))) throw new Error('Project view overlaps sandbox infrastructure');
    if ([...this.hidden, this.root, baselinePath].some(path => overlaps(visibleCwd, path))) throw new Error('Project view overlaps administrative paths');
    if (request.config.enabled !== true || request.config.backend !== 'bwrap') throw new Error('Production execution requires bubblewrap');
    validateLimits(request.config);
    assertRealDirectory(dirname(this.root));
    if (!existsSync(this.root)) mkdirSync(this.root, { mode: 0o700 });
    assertRealDirectory(this.root);
    const socket = absolute(request.jobSocketPath);
    assertRealDirectory(dirname(socket));
    if (!lstatSync(socket).isSocket()) throw new Error('Job socket must be an actual Unix socket');
    const availability = await this.available();
    if (!availability.available) throw new Error(`Sandbox unavailable: ${availability.reason}`);
    const sandboxDir = mkdtempSync(join(this.root, `s1-${request.jobId}-`));
    const owned = lstatSync(sandboxDir);
    const assertOwned = (): void => {
      assertRealDirectory(this.root);
      const now = lstatSync(sandboxDir);
      if (!now.isDirectory() || now.isSymbolicLink() || now.ino !== owned.ino || now.dev !== owned.dev) throw new Error('Sandbox directory identity changed');
    };
    const privateRepo = join(sandboxDir, 'repo'), runDirectory = join(sandboxDir, 'run');
    let providerHome: ProviderHomeOwnership | undefined;
    let homeDirectory = join(sandboxDir, 'home');
    const tmpDirectory = join(sandboxDir, 'tmp');
    let context: MountContext;
    try {
      if (request.providerStateKey !== undefined) {
        providerHome = acquireProviderHome(this.root, request.providerStateKey, request.requireExistingProviderState);
        homeDirectory = providerHome.homeDirectory;
      } else mkdirSync(homeDirectory, { mode: 0o700 });
      for (const path of [runDirectory, tmpDirectory]) mkdirSync(path, { mode: 0o700 });
      materializeBaseline(projectPath, privateRepo, request.baseline);
      context = { privateRepo, sandboxDir, runDirectory, homeDirectory, tmpDirectory, visibleCwd, projectPath,
        jobSocketPath: socket, readOnly: request.readOnly, operatorHome: this.home,
        hiddenPaths: [...this.hidden, this.root, baselinePath], config: request.config,
        ...(request.dependencyMounts === undefined ? {} : { dependencyMounts: request.dependencyMounts.map(mount => ({ ...mount })) }) };
      if (context.dependencyMounts !== undefined) validateDependencyMounts(context);
    } catch (error) {
      assertOwned(); removeOwnedTree(sandboxDir);
      // Preparation has not attempted any command launch.
      await providerHome?.release(async () => true);
      throw error;
    }
    const executions: ExecutionHandle[] = [];
    let busy = false, disposed = false, uncertainStart: ScopeStartError | null = null;
    const idle = async (): Promise<void> => {
      if (disposed) throw new Error('Sandbox is disposed');
      assertOwned();
      providerHome?.assertOwned();
      if (uncertainStart) {
        if (!uncertainStart.enrollment || observeScope(uncertainStart.enrollment, this.executor.ports).state !== 'absent') throw new Error('Sandbox startup requires reconciliation');
        uncertainStart = null;
      }
      for (const execution of executions) if ((await execution.observe()).state !== 'absent') throw new Error('Sandbox scope is alive or unverifiable');
    };
    const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (busy) throw new Error('Sandbox operation is already pending');
      busy = true;
      try { await idle(); return await operation(); }
      finally { busy = false; }
    };
    return { jobId: request.jobId, visibleCwd, privateRepo, sandboxDir, runDirectory, baseline: request.baseline, readOnly: request.readOnly,
      command: spec => exclusive(async () => {
        try {
          for (const path of [privateRepo, runDirectory, homeDirectory, tmpDirectory]) assertRealDirectory(path);
          if (!lstatSync(socket).isSocket()) throw new Error('Job socket changed');
          const plan = buildSandboxPlan(context, spec);
          const handle = await this.executor.start({ ...spec, argv: plan.argv, cwd: '/', env: {} }, request.config);
          executions.push(handle);
          return handle;
        } catch (error) {
          if (error instanceof ScopeStartError && !error.cleanupConfirmed) uncertainStart = error;
          throw error;
        }
      }),
      extract: directory => exclusive(async () => {
        absolute(directory);
        if ([projectPath, baselinePath, this.root].some(path => overlaps(path, directory))) throw new Error('Delta output overlaps canonical, baseline or sandbox storage');
        return captureDelta(request.baseline, privateRepo, directory);
      }),
      dispose: async () => { if (disposed) return; await exclusive(async () => {
        // Keep the ownership fence if cleanup or the final absence check fails.
        const remove = async (): Promise<boolean> => { await idle(); removeOwnedTree(sandboxDir); return true; };
        if (providerHome) await providerHome.release(remove); else await remove();
        disposed = true;
      }); },
    };
  }
}

export function createJobIsolation(options: SandboxOptions): JobIsolation { return new BubblewrapIsolation(options); }
