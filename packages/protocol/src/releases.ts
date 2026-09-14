export const RELEASE_ACTIONS = ["commit", "push", "migrate", "deploy", "verify"] as const;
export type ReleaseAction = (typeof RELEASE_ACTIONS)[number];
export type ReleaseOperationState = "prepared" | "executing" | "verified" | "not_applied" | "reconcile_required" | "cancelled";

export interface ReleaseFile {
  path: string;
  sha256: string;
  executable: boolean;
}

export interface ReleaseCandidate {
  id: string;
  taskId: string;
  roomId: string;
  sourceJobId: string;
  repository: string;
  cwd: string;
  baseCommit: string;
  headCommit: string;
  treeHash: string;
  sourceFingerprint: string;
  artifactDir: string;
  artifactHash: string;
  files: ReleaseFile[];
  configuration: Record<string, string>;
  configurationFiles: ReleaseFile[];
  migrationFiles: ReleaseFile[];
  configurationHash: string;
  migrationHash: string;
  evidenceHash: string;
  identityHash: string;
  createdAt: string;
}

export interface RegisterReleaseCandidate {
  taskId: string;
  roomId: string;
  sourceJobId: string;
  cwd: string;
  baseCommit: string;
  artifactDir: string;
  evidenceHash: string;
  /** Build/configuration and secret VERSION identifiers only; never secret values. */
  configuration?: Record<string, string>;
  configurationFiles?: string[];
  migrationFiles?: string[];
}

export interface ReleaseAuthorization {
  id: string;
  taskId: string;
  roomId: string;
  repository: string;
  candidateId: string | null;
  actions: ReleaseAction[];
  targets: string[];
  instruction: string;
  source: { reference: string; actor: string; authenticated: false };
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
}

export interface GrantReleaseAuthorization {
  taskId: string;
  roomId: string;
  repository: string;
  candidateId?: string;
  actions: ReleaseAction[];
  targets: string[];
  instruction: string;
  source: { reference: string; actor: string };
  expiresAt?: string;
}

export interface ReleaseReadback {
  state: "verified" | "not_applied" | "reconcile_required";
  /** Observed target identity/checkpoint, excluding secrets. */
  detail: string;
  /** True only when the adapter established that no surviving command/request can apply later. */
  settled?: boolean;
}

export interface ReleaseCommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface ReleaseOperation {
  id: string;
  taskId: string;
  roomId: string;
  candidateId: string;
  authorizationId: string;
  adapterId: string;
  action: ReleaseAction;
  target: string;
  step: string;
  semanticKey: string;
  expectedBefore: string;
  command: { argv: string[]; cwd: string };
  state: ReleaseOperationState;
  ownerToken: string;
  attempts: number;
  cancellationRequestedAt: string | null;
  commandResult: ReleaseCommandResult | null;
  /** Durable launch intent; nullable identity fields mean the gate was not authoritatively enrolled. */
  execution?: { scopeUnit: string; bootId: string; cgroupPath: string | null; pid: number | null; processGroup: number | null; startTicks: string | null };
  readback: ReleaseReadback | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrepareReleaseOperation {
  candidateId: string;
  authorizationId: string;
  adapterId: string;
  /** Stable logical release step; retries retain the operation ID. */
  step: string;
  expectedBefore: string;
}

export interface TaskReleases {
  candidates: ReleaseCandidate[];
  authorizations: ReleaseAuthorization[];
  operations: ReleaseOperation[];
}
