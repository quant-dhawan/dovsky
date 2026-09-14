import { gitSpawn } from './git.js';
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  GrantReleaseAuthorization, PrepareReleaseOperation, RegisterReleaseCandidate, ReleaseAction,
  ReleaseAuthorization, ReleaseCandidate, ReleaseCommandResult, ReleaseFile, ReleaseOperation,
  ReleaseReadback, TaskReleases,
  ReleaseOperationState, SandboxConfig,
} from "@dovsky/protocol";
import { DaemonError } from "./config.js";
import type { DovskyDatabase } from "./database.js";
import { confirmScopeGone, observeScope, ScopeStartError, signalScope, SystemdScopeExecutor } from "./execution-scope.js";
import type { ExecutionEnrollment } from "./isolation.js";

const releaseLimits: SandboxConfig = { enabled: true, backend: "bwrap", network: true,
  memoryMax: "8G", cpuQuota: "400%", tasksMax: 512, homePaths: [], runtimePaths: [], dependencyRoots: [] };

// Mutation stdio must outlive the executor's pipes. Keep this waiter and its
// detached child inside the enrolled scope, with the baseline's ignored I/O.
const releaseWaiter = `
  const child = require('node:child_process').spawn(process.argv[1], process.argv.slice(2), {stdio:'ignore', detached:true});
  child.once('error', () => { process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
`;

async function terminateScope(enrollment: ExecutionEnrollment): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try { await signalScope(enrollment, signal); } catch { /* Absence, not signal delivery, is authoritative. */ }
    if (await confirmScopeGone(enrollment, signal === "SIGTERM" ? 1000 : 5000)) return;
  }
  throw new Error("Release command scope absence could not be confirmed");
}

/** Additive migration only. Constructing a service never migrates or recovers live state. */
export const RELEASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS release_candidates (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, room_id TEXT NOT NULL,
    identity_hash TEXT NOT NULL, data_json TEXT NOT NULL,
    UNIQUE(task_id, identity_hash)
  );
  CREATE TABLE IF NOT EXISTS release_authorizations (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, room_id TEXT NOT NULL,
    decision_key TEXT NOT NULL UNIQUE, data_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS release_operations (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, room_id TEXT NOT NULL,
    semantic_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN
      ('prepared','executing','verified','not_applied','reconcile_required','cancelled')),
    data_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS release_targets (
    target TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES release_operations(id),
    owner_token TEXT NOT NULL
  );
`;

export interface ReleaseCommand {
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ReleaseContext {
  candidate: ReleaseCandidate;
  operation: ReleaseOperation;
}

/** Trusted local adapters, never deserialized from RPC input. No shell execution is provided. */
export interface ReleaseAdapter {
  id: string;
  action: ReleaseAction;
  target: string;
  command(context: ReleaseContext): ReleaseCommand;
  /** Must check expectedBefore against the actual remote ref/schema/version. */
  preflight(context: ReleaseContext): Promise<void>;
  /** Read-only: establish the remote postcondition, absence of effect, or uncertainty. */
  readback(context: ReleaseContext): Promise<ReleaseReadback>;
}

export interface CommandReleaseAdapterConfig {
  id: string;
  action: ReleaseAction;
  target: string;
  cwd: "source" | "artifact";
  argv: string[];
  preflightArgv: string[];
  readbackArgv: string[];
  timeoutMs?: number;
}

/**
 * Local configuration only. Preflight stdout is the exact expected predecessor; readback stdout is
 * ReleaseReadback JSON. The mutation itself must enforce the predecessor with target CAS/fencing:
 * this preliminary read alone cannot exclude an independent writer. Readback commands must be read-only.
 * An action=verify adapter must verify source/build provenance and the frozen artifact, then report its
 * observed result. Every mutating action requires a verified operation for that exact candidate first.
 * Pass placeholders as data arguments, never embed them in interpreted shell/JavaScript program text.
 */
export function createCommandReleaseAdapter(config: CommandReleaseAdapterConfig): ReleaseAdapter {
  for (const key of ["id", "target"] as const) requireText(config[key], key);
  if (!["commit", "push", "migrate", "deploy", "verify"].includes(config.action) || !["source", "artifact"].includes(config.cwd)) throw new DaemonError("INVALID_REQUEST", "Invalid local release adapter action or cwd");
  for (const argv of [config.argv, config.preflightArgv, config.readbackArgv]) {
    if (!Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !argv[0]) throw new DaemonError("INVALID_REQUEST", "Local release adapter needs three fixed argv arrays");
  }
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 3_600_000)) throw new DaemonError("INVALID_REQUEST", "Release timeout must be 1–3600000 milliseconds");
  const expand = (argv: string[], context: ReleaseContext): ReleaseCommand => {
    const values: Record<string, string> = { artifactDir: context.candidate.artifactDir, sourceDir: context.candidate.cwd, headCommit: context.candidate.headCommit,
      baseCommit: context.candidate.baseCommit, treeHash: context.candidate.treeHash, artifactHash: context.candidate.artifactHash,
      configurationHash: context.candidate.configurationHash, migrationHash: context.candidate.migrationHash,
      operationId: context.operation.id, expectedBefore: context.operation.expectedBefore, target: context.operation.target };
    return { argv: argv.map((arg) => arg.replace(/\{(artifactDir|sourceDir|headCommit|baseCommit|treeHash|artifactHash|configurationHash|migrationHash|operationId|expectedBefore|target)\}/g, (_match, name: string) => values[name]!)),
      cwd: config.cwd === "artifact" ? context.candidate.artifactDir : context.candidate.cwd, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) };
  };
  const read = async (command: ReleaseCommand): Promise<string> => {
    let bytes = 0;
    const handle = await new SystemdScopeExecutor({ captureBytes: 64 * 1024 }).start({
      ...command, env: command.env ?? process.env, stdin: "", kind: "readback", number: 0,
      timeoutMs: Math.min(command.timeoutMs ?? 30_000, 30_000), killOnTimeout: false,
      onEnrolled: () => {}, onStdout: chunk => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) throw new Error("Release readback exceeded output limit");
      },
    }, releaseLimits);
    const result = await handle.result;
    if (result.timedOut || result.outputError) {
      await terminateScope(handle);
      throw new Error(result.outputError ?? "Release read-only check timed out");
    }
    if (result.exitCode !== 0) throw new Error("Release read-only check failed");
    return result.stdout.trim();
  };
  return {
    id: config.id, action: config.action, target: config.target,
    command: (context) => expand(config.argv, context),
    preflight: async (context) => {
      if (await read(expand(config.preflightArgv, context)) !== context.operation.expectedBefore) throw new DaemonError("STATE_CONFLICT", "Release target predecessor changed");
    },
    readback: async (context) => JSON.parse(await read(expand(config.readbackArgv, context))) as ReleaseReadback,
  };
}

export interface ReleaseServiceOptions {
  artifactDirectory: string;
  currentFingerprint(cwd: string): string | null;
  assertCandidateAccepted(candidate: ReleaseCandidate): void;
  adapters?: readonly ReleaseAdapter[];
  runCommand?: (command: ReleaseCommand) => Promise<ReleaseCommandResult>;
}

type ReleaseDatabase = Pick<DovskyDatabase, "db" | "transaction" | "insertEvent">;
type Stored = ReleaseCandidate | ReleaseAuthorization | ReleaseOperation;

function digest(value: unknown): string {
  const stable = (input: unknown): unknown => Array.isArray(input) ? input.map(stable)
    : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : input;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function requireText(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 16_000) throw new DaemonError("INVALID_REQUEST", `${name} is required`);
}

function git(cwd: string, ...args: string[]): string {
  const result = gitSpawn(["-C", cwd, ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new DaemonError("STATE_CONFLICT", "Cannot resolve release repository identity");
  return result.stdout.trim();
}

function safeFile(root: string, path: string): string {
  const file = resolve(root, path);
  const rel = relative(root, file);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new DaemonError("INVALID_REQUEST", "Release input must be a file inside its directory");
  let cursor = root;
  for (const component of rel.split(sep)) {
    cursor = resolve(cursor, component);
    if (lstatSync(cursor).isSymbolicLink()) throw new DaemonError("INVALID_REQUEST", "Release snapshots do not follow symbolic links");
  }
  if (!lstatSync(file).isFile()) throw new DaemonError("INVALID_REQUEST", "Release input must be a regular file");
  return file;
}

function fileIdentity(root: string, path: string): ReleaseFile {
  const file = safeFile(root, path);
  return { path: relative(root, file).split(sep).join("/"), sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), executable: Boolean(lstatSync(file).mode & 0o111) };
}

function manifest(root: string): ReleaseFile[] {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new DaemonError("STATE_CONFLICT", "Candidate artifact directory was replaced");
  const files: ReleaseFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(fileIdentity(root, relative(root, path)));
    }
  };
  visit(root);
  return files;
}

/** Cooperative single-user coordination: this is not a credential or human-authentication boundary. */
export class ReleaseService {
  private readonly adapters = new Map<string, ReleaseAdapter>();
  private readonly active = new Set<string>();

  constructor(private readonly database: ReleaseDatabase, private readonly options: ReleaseServiceOptions) {
    for (const adapter of options.adapters ?? []) {
      if (this.adapters.has(adapter.id)) throw new Error(`Duplicate release adapter: ${adapter.id}`);
      this.adapters.set(adapter.id, adapter);
    }
  }

  private load<T extends Stored>(table: string, id: string): T {
    const row = this.database.db.prepare(`SELECT data_json FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new DaemonError("NOT_FOUND", "Release record not found");
    return JSON.parse(String(row.data_json)) as T;
  }

  getCandidate(id: string): ReleaseCandidate { return this.load("release_candidates", id); }
  getAuthorization(id: string): ReleaseAuthorization { return this.load("release_authorizations", id); }
  getOperation(id: string): ReleaseOperation {
    const operation = this.load<ReleaseOperation>("release_operations", id);
    const row = this.database.db.prepare("SELECT scope_unit,cgroup_path,pid,process_group,process_start_ticks,boot_id FROM release_operations WHERE id=?").get(id)!;
    if (row.scope_unit) operation.execution = { scopeUnit: String(row.scope_unit), bootId: String(row.boot_id ?? ""),
      cgroupPath: row.cgroup_path === null ? null : String(row.cgroup_path), pid: row.pid === null ? null : Number(row.pid),
      processGroup: row.process_group === null ? null : Number(row.process_group), startTicks: row.process_start_ticks === null ? null : String(row.process_start_ticks) };
    else delete operation.execution;
    return operation;
  }

  private enrollment(operation: ReleaseOperation): ExecutionEnrollment | null {
    const scope = operation.execution;
    if (!scope?.pid || !scope.processGroup || !scope.startTicks || !scope.cgroupPath || !scope.bootId) return null;
    return { scopeUnit: scope.scopeUnit, cgroupPath: scope.cgroupPath,
      identity: { pid: scope.pid, processGroup: scope.processGroup, startTicks: scope.startTicks, bootId: scope.bootId } };
  }

  private async runCommand(command: ReleaseCommand, operation: ReleaseOperation): Promise<ReleaseCommandResult> {
    const owned = (): ReleaseOperation => {
      const current = this.getOperation(operation.id);
      if (current.ownerToken !== operation.ownerToken || current.state !== "executing" || current.cancellationRequestedAt) throw new DaemonError("STATE_CONFLICT", "Release changed before scope dispatch");
      this.assertAuthorized(current, this.getCandidate(current.candidateId));
      return current;
    };
    try {
      const handle = await new SystemdScopeExecutor().start({ ...command, argv: [process.execPath, "-e", releaseWaiter, "--", ...command.argv], env: command.env ?? process.env, stdin: "",
        kind: "release", number: operation.attempts, timeoutMs: command.timeoutMs ?? 120_000, killOnTimeout: false,
        onScopeStarting: intent => this.database.transaction(() => {
          const current = owned();
          this.database.db.prepare("UPDATE release_operations SET scope_unit=?,boot_id=?,pid=NULL,process_group=NULL,process_start_ticks=NULL,cgroup_path=NULL WHERE id=?")
            .run(intent.scopeUnit, intent.bootId, current.id);
          this.save(this.getOperation(current.id), "release.operation.scope_starting");
        }),
        onEnrolled: enrollment => this.database.transaction(() => {
          const current = owned();
          if (current.execution?.scopeUnit !== enrollment.scopeUnit || current.execution.bootId !== enrollment.identity.bootId) throw new Error("Release scope enrollment does not match launch intent");
          this.storeEnrollment(current, enrollment);
        }),
      }, releaseLimits);
      const { exitCode, signal, timedOut } = await handle.result;
      return { exitCode, signal, timedOut };
    } catch (error) {
      // Failed startup may discover identity after cancellation; record it for observation, never release its gate.
      if (error instanceof ScopeStartError && error.enrollment) this.database.transaction(() => {
        const current = this.getOperation(operation.id);
        if (current.ownerToken === operation.ownerToken && current.execution?.scopeUnit === error.scopeUnit
          && current.execution.bootId === error.enrollment!.identity.bootId) this.storeEnrollment(current, error.enrollment!);
      });
      throw error;
    }
  }

  private storeEnrollment(operation: ReleaseOperation, enrollment: ExecutionEnrollment): void {
    const { identity, cgroupPath } = enrollment;
    this.database.db.prepare("UPDATE release_operations SET pid=?,process_group=?,process_start_ticks=?,cgroup_path=? WHERE id=?")
      .run(identity.pid, identity.processGroup, identity.startTicks, cgroupPath, operation.id);
    this.save(this.getOperation(operation.id), "release.operation.scope_enrolled");
  }

  summary(): {
    adapters: Array<{ id: string; action: ReleaseAction; target: string }>;
    candidates: number;
    operations: Record<ReleaseOperationState, number>;
  } {
    const states: ReleaseOperationState[] = ["prepared", "executing", "verified", "not_applied", "reconcile_required", "cancelled"];
    const operations = Object.fromEntries(states.map((state) => [state, 0])) as Record<ReleaseOperationState, number>;
    for (const row of this.database.db.prepare("SELECT state,count(*) AS count FROM release_operations GROUP BY state").all()) {
      const state = String(row.state) as ReleaseOperationState;
      if (!states.includes(state)) throw new Error(`Unknown release operation state: ${state}`);
      operations[state] = Number(row.count);
    }
    const candidateRow = this.database.db.prepare("SELECT count(*) AS count FROM release_candidates").get();
    return {
      adapters: [...this.adapters.values()].map(({ id, action, target }) => ({ id, action, target })).sort((a, b) => a.id.localeCompare(b.id)),
      candidates: Number(candidateRow?.count ?? 0),
      operations,
    };
  }

  registerCandidate(input: RegisterReleaseCandidate): ReleaseCandidate {
    for (const field of ["taskId", "roomId", "sourceJobId", "cwd", "baseCommit", "artifactDir", "evidenceHash"] as const) requireText(input[field], field);
    const cwd = realpathSync(input.cwd);
    const source = realpathSync(input.artifactDir);
    const sourceFingerprint = this.options.currentFingerprint(cwd);
    if (!sourceFingerprint) throw new DaemonError("STATE_CONFLICT", "Cannot fingerprint candidate source");
    const headCommit = git(cwd, "rev-parse", "HEAD");
    const treeHash = git(cwd, "rev-parse", "HEAD^{tree}");
    const baseCommit = git(cwd, "rev-parse", "--verify", "--end-of-options", `${input.baseCommit}^{commit}`);
    const repository = realpathSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    const files = manifest(source);
    if (!files.length) throw new DaemonError("INVALID_REQUEST", "Candidate artifact directory is empty");
    const configurationFiles = [...new Set(input.configurationFiles ?? [])].sort().map((path) => fileIdentity(cwd, path));
    const migrationFiles = [...new Set(input.migrationFiles ?? [])].sort().map((path) => fileIdentity(cwd, path));
    const configuration = input.configuration ?? {};
    if (Object.values(configuration).some((value) => typeof value !== "string")) throw new DaemonError("INVALID_REQUEST", "Configuration identity values must be strings");
    const identities = {
      repository, baseCommit, headCommit, treeHash, sourceFingerprint, artifactHash: digest(files),
      configurationHash: digest({ configuration, files: configurationFiles }), migrationHash: digest(migrationFiles), evidenceHash: input.evidenceHash,
    };
    const identityHash = digest(identities);
    const existing = this.database.db.prepare("SELECT id FROM release_candidates WHERE task_id=? AND identity_hash=?").get(input.taskId, identityHash);
    if (existing) return this.verifyCandidate(String(existing.id));
    const id = randomUUID();
    const directory = resolve(this.options.artifactDirectory, "release-candidates");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(resolve(directory, ".candidate-"));
    const artifactDir = resolve(directory, id);
    try {
      for (const file of files) {
        const destination = resolve(staging, file.path);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        copyFileSync(safeFile(source, file.path), destination);
        chmodSync(destination, file.executable ? 0o700 : 0o600);
      }
      if (digest(manifest(staging)) !== identities.artifactHash || this.options.currentFingerprint(cwd) !== sourceFingerprint
        || git(cwd, "rev-parse", "HEAD") !== headCommit) throw new DaemonError("STATE_CONFLICT", "Candidate changed during snapshot registration");
      const candidate: ReleaseCandidate = { id, taskId: input.taskId, roomId: input.roomId, sourceJobId: input.sourceJobId, cwd,
        ...identities, artifactDir, files, configuration, configurationFiles, migrationFiles, identityHash, createdAt: new Date().toISOString() };
      this.options.assertCandidateAccepted(candidate);
      renameSync(staging, artifactDir);
      this.database.transaction(() => {
        this.database.db.prepare("INSERT INTO release_candidates(id,task_id,room_id,identity_hash,data_json) VALUES(?,?,?,?,?)")
          .run(id, candidate.taskId, candidate.roomId, identityHash, JSON.stringify(candidate));
        this.database.insertEvent(candidate.roomId, candidate.sourceJobId, "release.candidate.registered", { candidateId: id, identityHash });
      });
      return candidate;
    } finally {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
  }

  verifyCandidate(id: string): ReleaseCandidate {
    const candidate = this.getCandidate(id);
    if (digest(manifest(candidate.artifactDir)) !== candidate.artifactHash) throw new DaemonError("STATE_CONFLICT", "Candidate artifact is missing or changed");
    if (this.options.currentFingerprint(candidate.cwd) !== candidate.sourceFingerprint || git(candidate.cwd, "rev-parse", "HEAD") !== candidate.headCommit) {
      throw new DaemonError("STATE_CONFLICT", "Candidate source changed; register and evaluate a new candidate");
    }
    for (const file of [...candidate.configurationFiles, ...candidate.migrationFiles]) {
      if (digest(fileIdentity(candidate.cwd, file.path)) !== digest(file)) throw new DaemonError("STATE_CONFLICT", "Candidate configuration or migration changed");
    }
    this.options.assertCandidateAccepted(candidate);
    return candidate;
  }

  grantAuthorization(input: GrantReleaseAuthorization): ReleaseAuthorization {
    for (const field of ["taskId", "roomId", "repository", "instruction"] as const) requireText(input[field], field);
    requireText(input.source?.reference, "source.reference");
    requireText(input.source?.actor, "source.actor");
    if (!Array.isArray(input.actions) || !input.actions.length || input.actions.some((action) => !["commit", "push", "migrate", "deploy", "verify"].includes(action))
      || !Array.isArray(input.targets) || !input.targets.length) throw new DaemonError("INVALID_REQUEST", "Authorization needs explicit actions and targets");
    input.targets.forEach((target) => requireText(target, "target"));
    if (input.expiresAt !== undefined && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())) throw new DaemonError("INVALID_REQUEST", "Authorization expiry must be in the future");
    if (input.candidateId) {
      const candidate = this.getCandidate(input.candidateId);
      if (candidate.taskId !== input.taskId || candidate.repository !== input.repository) throw new DaemonError("INVALID_REQUEST", "Authorization candidate is outside its task or repository");
    }
    const grant: ReleaseAuthorization = { id: randomUUID(), taskId: input.taskId, roomId: input.roomId, repository: input.repository,
      candidateId: input.candidateId ?? null, actions: [...new Set(input.actions)].sort(), targets: [...new Set(input.targets)].sort(), instruction: input.instruction,
      source: { reference: input.source.reference, actor: input.source.actor, authenticated: false }, createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt ?? null, revokedAt: null, revocationReason: null };
    const decisionKey = digest({ ...grant, id: null, createdAt: null });
    return this.database.transaction(() => {
      const existing = this.database.db.prepare("SELECT id FROM release_authorizations WHERE decision_key=?").get(decisionKey);
      if (existing) return this.getAuthorization(String(existing.id));
      this.database.db.prepare("INSERT INTO release_authorizations(id,task_id,room_id,decision_key,data_json) VALUES(?,?,?,?,?)")
        .run(grant.id, grant.taskId, grant.roomId, decisionKey, JSON.stringify(grant));
      this.database.insertEvent(grant.roomId, null, "release.authorization.recorded", { authorizationId: grant.id, authenticated: false });
      return grant;
    });
  }

  revokeAuthorization(id: string, reason: string): ReleaseAuthorization {
    requireText(reason, "reason");
    return this.database.transaction(() => {
      const grant = this.getAuthorization(id);
      if (grant.revokedAt) return grant;
      grant.revokedAt = new Date().toISOString();
      grant.revocationReason = reason;
      this.database.db.prepare("UPDATE release_authorizations SET data_json=? WHERE id=?").run(JSON.stringify(grant), id);
      this.database.insertEvent(grant.roomId, null, "release.authorization.revoked", { authorizationId: id, reason });
      return grant;
    });
  }

  private adapter(id: string): ReleaseAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new DaemonError("INVALID_REQUEST", "Release adapter is not configured locally");
    return adapter;
  }

  private assertAuthorized(operation: ReleaseOperation, candidate: ReleaseCandidate): void {
    const grant = this.getAuthorization(operation.authorizationId);
    if (grant.revokedAt || (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) || grant.taskId !== candidate.taskId || grant.roomId !== candidate.roomId
      || grant.repository !== candidate.repository || (grant.candidateId && grant.candidateId !== candidate.id)
      || !grant.actions.includes(operation.action) || !grant.targets.includes(operation.target)) throw new DaemonError("FORBIDDEN", "Release authorization is revoked, expired, or outside scope");
  }

  private assertArtifactVerified(operation: ReleaseOperation): void {
    if (operation.action === "verify") return;
    const verified = this.database.db.prepare("SELECT 1 FROM release_operations WHERE task_id=? AND state='verified' AND json_extract(data_json,'$.candidateId')=? AND json_extract(data_json,'$.action')='verify' LIMIT 1")
      .get(operation.taskId, operation.candidateId);
    if (!verified) throw new DaemonError("STATE_CONFLICT", "A trusted local verification operation must verify this exact candidate artifact before release");
  }

  private command(adapter: ReleaseAdapter, context: ReleaseContext): ReleaseCommand {
    const command = adapter.command(context);
    if (!Array.isArray(command.argv) || !command.argv.length || command.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !command.argv[0]) {
      throw new DaemonError("INVALID_REQUEST", "Local release adapter produced an invalid argv");
    }
    return { ...command, cwd: realpathSync(command.cwd) };
  }

  private acquire(operation: ReleaseOperation): void {
    const owner = this.database.db.prepare("SELECT operation_id,owner_token FROM release_targets WHERE target=?").get(operation.target);
    if (owner && (owner.operation_id !== operation.id || owner.owner_token !== operation.ownerToken)) throw new DaemonError("STATE_CONFLICT", "Release target is owned by another unresolved operation");
    this.database.db.prepare("INSERT OR IGNORE INTO release_targets(target,operation_id,owner_token) VALUES(?,?,?)").run(operation.target, operation.id, operation.ownerToken);
  }

  private save(operation: ReleaseOperation, event: string): ReleaseOperation {
    operation.updatedAt = new Date().toISOString();
    this.database.db.prepare("UPDATE release_operations SET state=?,data_json=? WHERE id=?").run(operation.state, JSON.stringify(operation), operation.id);
    this.database.insertEvent(operation.roomId, null, event, { operationId: operation.id, candidateId: operation.candidateId, state: operation.state, readback: operation.readback });
    return operation;
  }

  prepareOperation(input: PrepareReleaseOperation): ReleaseOperation {
    requireText(input.step, "step");
    requireText(input.expectedBefore, "expectedBefore");
    const candidate = this.verifyCandidate(input.candidateId);
    const adapter = this.adapter(input.adapterId);
    if (adapter.action === "push" && git(candidate.cwd, "status", "--porcelain")) throw new DaemonError("STATE_CONFLICT", "Commit and register the candidate before pushing; approved uncommitted edits must not be omitted");
    const semanticKey = digest({ taskId: candidate.taskId, candidateId: candidate.id, action: adapter.action, target: adapter.target, step: input.step });
    const stamp = new Date().toISOString();
    const operation: ReleaseOperation = { id: randomUUID(), taskId: candidate.taskId, roomId: candidate.roomId, candidateId: candidate.id,
      authorizationId: input.authorizationId, adapterId: adapter.id, action: adapter.action, target: adapter.target, step: input.step, semanticKey,
      expectedBefore: input.expectedBefore, command: { argv: [], cwd: candidate.cwd }, state: "prepared", ownerToken: randomUUID(), attempts: 0,
      cancellationRequestedAt: null, commandResult: null, readback: null, createdAt: stamp, updatedAt: stamp };
    this.assertAuthorized(operation, candidate);
    this.assertArtifactVerified(operation);
    const command = this.command(adapter, { candidate, operation });
    operation.command = { argv: command.argv, cwd: command.cwd };
    return this.database.transaction(() => {
      const row = this.database.db.prepare("SELECT id FROM release_operations WHERE semantic_key=?").get(semanticKey);
      if (row) {
        const existing = this.getOperation(String(row.id));
        const repeatedCommand = this.command(adapter, { candidate, operation: existing });
        if (existing.expectedBefore !== input.expectedBefore || existing.adapterId !== adapter.id || digest(existing.command) !== digest({ argv: repeatedCommand.argv, cwd: repeatedCommand.cwd })) throw new DaemonError("IDEMPOTENCY_CONFLICT", "Logical release step was reused with different intent");
        return existing;
      }
      this.database.db.prepare("INSERT INTO release_operations(id,task_id,room_id,semantic_key,state,data_json) VALUES(?,?,?,?,?,?)")
        .run(operation.id, operation.taskId, operation.roomId, semanticKey, operation.state, JSON.stringify(operation));
      this.acquire(operation);
      this.database.insertEvent(operation.roomId, null, "release.operation.prepared", { operationId: operation.id, candidateId: candidate.id, action: operation.action, target: operation.target });
      return operation;
    });
  }

  async executeOperation(id: string): Promise<ReleaseOperation> {
    const initial = this.getOperation(id);
    if (initial.state === "verified" || initial.state === "cancelled") return initial;
    if (initial.state !== "prepared") throw new DaemonError("STATE_CONFLICT", "Release operation requires reconciliation or explicit retry");
    if (this.active.has(id)) throw new DaemonError("STATE_CONFLICT", "Release operation is already being checked or executed");
    this.active.add(id);
    try {
      const candidate = this.verifyCandidate(initial.candidateId);
      const adapter = this.adapter(initial.adapterId);
      this.assertAuthorized(initial, candidate);
      this.assertArtifactVerified(initial);
      await adapter.preflight({ candidate, operation: initial });
      // Recheck after the awaited preflight: revocation, cancellation and tampering can arrive meanwhile.
      const currentCandidate = this.verifyCandidate(initial.candidateId);
      const operation = this.database.transaction(() => {
        const current = this.getOperation(id);
        if (current.state !== "prepared" || current.cancellationRequestedAt) throw new DaemonError("STATE_CONFLICT", "Release was cancelled or its state changed before dispatch");
        this.assertAuthorized(current, currentCandidate);
        this.assertArtifactVerified(current);
        this.acquire(current);
        current.state = "executing";
        current.attempts += 1;
        return this.save(current, "release.operation.executing");
      });
      const context = { candidate: currentCandidate, operation };
      try {
        const command = this.command(adapter, context);
        if (digest({ argv: command.argv, cwd: command.cwd }) !== digest(operation.command)) throw new Error("Local adapter changed the prepared command");
        const result = await (this.options.runCommand ? this.options.runCommand(command) : this.runCommand(command, operation));
        this.database.transaction(() => {
          const current = this.getOperation(id);
          if (current.ownerToken !== operation.ownerToken || current.state !== "executing") throw new DaemonError("STATE_CONFLICT", "Release executor was superseded during recovery");
          current.commandResult = result;
          this.save(current, "release.operation.command_returned");
        });
      } catch {
        // A thrown runner may have already caused a remote effect. Never infer that it did nothing.
      }
      return await this.observe(id, operation.ownerToken);
    } finally {
      this.active.delete(id);
    }
  }

  private async observe(id: string, ownerToken: string): Promise<ReleaseOperation> {
    const operation = this.getOperation(id);
    if (operation.ownerToken !== ownerToken) throw new DaemonError("STATE_CONFLICT", "Release executor ownership was superseded");
    let readback: ReleaseReadback;
    try {
      readback = await this.adapter(operation.adapterId).readback({ candidate: this.getCandidate(operation.candidateId), operation });
      if (!["verified", "not_applied", "reconcile_required"].includes(readback.state) || typeof readback.detail !== "string") throw new Error("Invalid readback");
      // A still-running local/remote command can apply later despite an absent current postcondition.
      if (readback.state !== "reconcile_required" && (readback.settled === false || ((!operation.commandResult || operation.commandResult.timedOut) && readback.settled !== true))) {
        readback = { state: "reconcile_required", detail: "Readback has not established that the dispatched operation is settled" };
      }
      if (operation.execution) {
        const enrollment = this.enrollment(operation);
        const state = enrollment ? observeScope(enrollment).state : "unverifiable";
        if (state !== "absent") readback = { state: "reconcile_required", detail: `Persisted release scope is ${state}; target ownership is retained` };
      }
    } catch {
      readback = { state: "reconcile_required", detail: "Target readback could not establish the operation outcome" };
    }
    return this.database.transaction(() => {
      const current = this.getOperation(id);
      if (current.state !== "executing" && current.state !== "reconcile_required") return current;
      if (current.ownerToken !== ownerToken) throw new DaemonError("STATE_CONFLICT", "Release executor ownership changed during readback");
      const owner = this.database.db.prepare("SELECT operation_id,owner_token FROM release_targets WHERE target=?").get(current.target);
      if (owner?.operation_id !== current.id || owner.owner_token !== current.ownerToken) throw new DaemonError("STATE_CONFLICT", "Release target ownership changed during observation");
      current.state = readback.state;
      current.readback = readback;
      this.save(current, "release.operation.observed");
      if (readback.state !== "reconcile_required") this.database.db.prepare("DELETE FROM release_targets WHERE target=? AND operation_id=? AND owner_token=?").run(current.target, id, current.ownerToken);
      return current;
    });
  }

  async reconcileOperation(id: string, action: "inspect" | "terminate" = "inspect"): Promise<ReleaseOperation> {
    if (action !== "inspect" && action !== "terminate") throw new DaemonError("INVALID_REQUEST", "Release reconciliation action must be inspect or terminate");
    const operation = this.getOperation(id);
    if (operation.state !== "reconcile_required") throw new DaemonError("STATE_CONFLICT", "Only an uncertain operation needs reconciliation");
    if (this.active.has(id)) throw new DaemonError("STATE_CONFLICT", "Release operation is still executing or being observed");
    this.active.add(id);
    try {
      if (action === "terminate") {
        this.assertAuthorized(operation, this.getCandidate(operation.candidateId));
        const enrollment = this.enrollment(operation);
        if (!enrollment) throw new DaemonError("STATE_CONFLICT", "Release scope identity is not fully enrolled; termination is unsafe");
        if (observeScope(enrollment).state === "unverifiable") throw new DaemonError("STATE_CONFLICT", "Release scope cannot be authoritatively observed; retain its fence");
        this.database.insertEvent(operation.roomId, null, "release.operation.termination_requested", { operationId: id, scopeUnit: enrollment.scopeUnit });
        await terminateScope(enrollment);
      }
      return await this.observe(id, operation.ownerToken);
    } finally { this.active.delete(id); }
  }

  retryOperation(id: string): ReleaseOperation {
    return this.database.transaction(() => {
      const operation = this.getOperation(id);
      if (operation.state !== "not_applied" || operation.cancellationRequestedAt) throw new DaemonError("STATE_CONFLICT", "Retry requires proven absence of effect and no cancellation");
      const candidate = this.verifyCandidate(operation.candidateId);
      this.assertAuthorized(operation, candidate);
      this.assertArtifactVerified(operation);
      operation.ownerToken = randomUUID();
      this.acquire(operation);
      operation.state = "prepared";
      operation.commandResult = null;
      operation.readback = null;
      this.database.db.prepare("UPDATE release_operations SET scope_unit=NULL,cgroup_path=NULL,pid=NULL,process_group=NULL,process_start_ticks=NULL,boot_id=NULL WHERE id=?").run(id);
      delete operation.execution;
      return this.save(operation, "release.operation.retry_prepared");
    });
  }

  cancelOperation(id: string): ReleaseOperation {
    return this.database.transaction(() => {
      const operation = this.getOperation(id);
      if (operation.state === "cancelled" || operation.state === "verified" || operation.cancellationRequestedAt) return operation;
      operation.cancellationRequestedAt = new Date().toISOString();
      // The same grant cannot dispatch the later deployment after a cancelled migration.
      this.revokeAuthorization(operation.authorizationId, `Release operation ${id} was cancelled`);
      if (operation.state === "prepared" || operation.state === "not_applied") {
        operation.state = "cancelled";
        this.database.db.prepare("DELETE FROM release_targets WHERE target=? AND operation_id=? AND owner_token=?").run(operation.target, id, operation.ownerToken);
      }
      return this.save(operation, "release.operation.cancel_requested");
    });
  }

  recoverInterruptedOperations(): number {
    return this.database.transaction(() => {
      const rows = this.database.db.prepare("SELECT id FROM release_operations WHERE state='executing'").all();
      for (const row of rows) {
        const operation = this.getOperation(String(row.id));
        operation.state = "reconcile_required";
        const previousOwner = operation.ownerToken;
        operation.ownerToken = randomUUID();
        this.database.db.prepare("UPDATE release_targets SET owner_token=? WHERE target=? AND operation_id=? AND owner_token=?")
          .run(operation.ownerToken, operation.target, operation.id, previousOwner);
        operation.readback = { state: "reconcile_required", detail: "Executor restarted; remote effect and surviving command require observation" };
        this.save(operation, "release.operation.recovery_required");
      }
      return rows.length;
    });
  }

  listForTask(taskId: string): TaskReleases {
    const list = <T extends Stored>(table: string): T[] => this.database.db.prepare(`SELECT data_json FROM ${table} WHERE task_id=? ORDER BY rowid`).all(taskId).map((row) => JSON.parse(String(row.data_json)) as T);
    return { candidates: list<ReleaseCandidate>("release_candidates"), authorizations: list<ReleaseAuthorization>("release_authorizations"), operations: list<ReleaseOperation>("release_operations").map(operation => this.getOperation(operation.id)) };
  }
}
