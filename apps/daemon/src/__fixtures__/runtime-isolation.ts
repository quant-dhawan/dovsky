/** Explicit application-test transport. Real scopes, but NO namespace-confinement claim. */
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DovskyDaemon } from '../daemon.js';
import type { DaemonConfig } from '../config.js';
import type { ExecutionHandle, JobIsolation } from '../isolation.js';
import { SystemdScopeExecutor } from '../execution-scope.js';
import { captureDelta, materializeBaseline } from '../job-delta.js';
import { acquireProviderHome } from '../provider-home.js';
import { safeTreePath } from '../file-state.js';

/** Only pass a disposable fixture root owned by the calling test. Never follows links. */
export function removeFixtureTree(root: string): void {
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  writable(root);
  rmSync(root, { recursive: true, force: true });
}

export function fixtureIsolation(root: string, onPrepared?: (jobId: string, privateRepo: string) => void): JobIsolation {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const executor = new SystemdScopeExecutor();
  return {
    available: async () => ({ available: true, backend: 'bwrap', bwrapVersion: 'explicit application fixture; no bwrap', reason: null }),
    prepare: async request => {
      const sandboxDir = mkdtempSync(join(root, 'command-'));
      const privateRepo = join(sandboxDir, 'repo'), runDirectory = join(sandboxDir, 'run');
      mkdirSync(runDirectory);
      materializeBaseline(request.projectPath, privateRepo, request.baseline);
      const ownership = request.providerStateKey === undefined ? null : acquireProviderHome(root, request.providerStateKey, request.requireExistingProviderState);
      const home = ownership?.homeDirectory ?? join(sandboxDir, 'home');
      mkdirSync(home, { recursive: true, mode: 0o700 });
      for (const mount of request.dependencyMounts ?? []) {
        const target = safeTreePath(privateRepo, mount.relativePath);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(mount.source, target, { recursive: true, dereference: false, verbatimSymlinks: true });
      }
      onPrepared?.(request.jobId, privateRepo);
      const executions: Array<{ handle: ExecutionHandle; completed: boolean }> = [];
      const absent = async (): Promise<boolean> => {
        for (const item of executions) if (!item.completed || (await item.handle.observe()).state !== 'absent') return false;
        return true;
      };
      const mapPath = (value: string): string => isAbsolute(value)
        && (value === request.visibleCwd || value.startsWith(request.visibleCwd + sep))
        ? resolve(privateRepo, relative(request.visibleCwd, value)) : value;
      return { jobId: request.jobId, privateRepo, sandboxDir, runDirectory, baseline: request.baseline,
        visibleCwd: request.visibleCwd, readOnly: request.readOnly,
        command: async spec => {
          ownership?.assertOwned();
          const env: NodeJS.ProcessEnv = { ...spec.env, HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
            XDG_STATE_HOME: join(home, '.local/state'), XDG_CONFIG_HOME: join(home, '.config'),
            XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'),
            PWD: mapPath(spec.cwd) };
          if (env.PATH) env.PATH = env.PATH.split(':').map(mapPath).join(':');
          const handle = await executor.start({ ...spec, argv: spec.argv.map(mapPath), cwd: mapPath(spec.cwd), env }, request.config);
          const item = { handle, completed: false };
          executions.push(item);
          void handle.completion.then(() => { item.completed = true; });
          return handle;
        },
        extract: async directory => {
          if (!await absent()) throw new Error('Fixture extraction requires completed scopes');
          return captureDelta(request.baseline, privateRepo, directory);
        },
        dispose: async () => {
          if (!await absent()) throw new Error('Fixture disposal requires completed scopes');
          if (ownership) await ownership.release(absent);
          removeFixtureTree(sandboxDir);
        },
      };
    },
  };
}

/** Tests opt in by importing this class; production never imports this module. */
export class FixtureDaemon extends DovskyDaemon {
  private readonly fixtureRepositories: Map<string, string>;
  constructor(config: DaemonConfig) {
    // Existing application fixtures cover legacy routing; bandit tests opt in with an explicit routing config.
    config.routing ??= { bandit: { enabled: false } };
    const repositories = new Map<string, string>();
    super(config, { isolation: fixtureIsolation(resolve(config.artifactDirectory, 'fixture-runtime'), (jobId, path) => repositories.set(jobId, path)) });
    this.fixtureRepositories = repositories;
  }
  fixturePrivateRepository(jobId: string): string | null { return this.fixtureRepositories.get(jobId) ?? null; }
}
