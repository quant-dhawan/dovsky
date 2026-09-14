export const PROTOCOL_VERSION = 2 as const;
import type { CanonicalIdentity } from "./features.js";
export * from "./coordination.js";
export * from "./releases.js";
export * from "./features.js";

export const PROVIDERS = ["claude", "codex"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** A routing policy's key. The daemon keys policies by it; the bridge joins jobs to them by it. */
export function routingKey(provider: Provider, workflowId: string, charter: string | null): string {
  return `${provider}/${workflowId}/${charter ?? "-"}`;
}

export function parseRoutingKey(key: string): { provider: Provider; workflowId: string; charter: string | null } | null {
  const parts = key.split("/");
  if (parts.length !== 3 || (parts[0] !== "claude" && parts[0] !== "codex") || !parts[1] || !parts[2]) return null;
  return { provider: parts[0], workflowId: parts[1], charter: parts[2] === "-" ? null : parts[2] };
}

export const TIERS = ["quick", "routine", "hard", "frontier"] as const;
export type Tier = (typeof TIERS)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const GRADES = ["good", "bad"] as const;
export type Grade = (typeof GRADES)[number];
/** Who graded a job; a human grade always wins over a reviewer's. */
export const GRADE_SOURCES = ["human", "reviewer", "agent"] as const;
export type GradeSource = (typeof GRADE_SOURCES)[number];
/** A reviewer job reads the worker's evidence; `review` jobs are never themselves reviewed. */
export type JobRole = "work" | "review";
/** The reviewer's last non-empty line is `VERDICT: APPROVED | REFUTED | INCONCLUSIVE`. */
export const VERDICTS = ["approved", "refuted", "inconclusive"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** Reviewer for a job: the other provider (default), a named one, or none. */
export const REVIEW_TARGETS = ["other", "claude", "codex", "none"] as const;
export type ReviewTarget = (typeof REVIEW_TARGETS)[number];
/** Why a job ended badly: the model could not do the work (a gate, or a bad grade) or the world got in the way. */
export type FailureCause = "capability" | "environmental";

export const EVALUATION_LEVELS = ["low", "medium", "high"] as const;
export type EvaluationLevel = (typeof EVALUATION_LEVELS)[number];
export interface AcceptanceCriteria {
  criteria: string[];
  /** Scenario IDs intentionally failing on the baseline, declared before work starts. */
  expectedBaselineFailures?: string[];
}
export interface EvaluationConfig {
  enabled: boolean;
  defaultLevel: EvaluationLevel;
  /** Self-contained Node script, relative to the project; frozen with each job. */
  runner: string;
  /** Installed dependency directories shared by isolated arms, relative to the project. */
  dependencyRoots?: string[];
}
export interface ScenarioResult {
  id: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}
export interface EvaluationReport {
  suiteHash: string;
  candidate: ScenarioResult[];
  baseline: ScenarioResult[] | null;
  problems: string[];
}
export interface EvaluationView {
  level: EvaluationLevel;
  reason: string | null;
  criteria: string[];
  state: "pending" | "blocked" | "accepted" | "rejected";
  outstanding: string[];
  fingerprint: string | null;
  evidenceHash: string | null;
  report: EvaluationReport | null;
  decision: { verdict: "accepted" | "rejected"; note: string; checked: number[]; at: string } | null;
}

export function evaluationNeedsAttention(evaluation: EvaluationView): boolean {
  return evaluation.state === "blocked" || evaluation.state === "rejected" ||
    (evaluation.state === "pending" && evaluation.outstanding.length === 1 && evaluation.outstanding[0] === "Human acceptance checklist required");
}

/** Default model and effort for each provider/tier routing entry. */
export const TIER_TABLE: Readonly<Record<Provider, Readonly<Record<Tier, { model: string; effort: Effort }>>>> = {
  codex: {
    quick: { model: "gpt-5.6-luna", effort: "low" },
    routine: { model: "gpt-5.6-terra", effort: "medium" },
    hard: { model: "gpt-5.6-terra", effort: "xhigh" },
    frontier: { model: "gpt-5.6-sol", effort: "xhigh" },
  },
  claude: {
    quick: { model: "sonnet", effort: "low" },
    routine: { model: "sonnet", effort: "high" },
    hard: { model: "opus", effort: "high" },
    frontier: { model: "fable", effort: "xhigh" },
  },
};

export const MODELS: Readonly<Record<Provider, readonly string[]>> = {
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
  claude: ["fable", "opus", "sonnet", "haiku"],
};

/** A charter is `<cwd>/.claude/agents/<Name>.md`; the name is a plain file stem. */
export const CHARTER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Optional per-job execution spec accepted by every job-creating mutation. */
export interface JobSpecInput {
  evalLevel?: EvaluationLevel;
  evalReason?: string;
  acceptance?: AcceptanceCriteria;
  tier?: Tier;
  model?: string;
  effort?: Effort;
  charter?: string;
  cwd?: string;
  /** Gates run on the working tree after the provider; protect/writable are comma or space separated lists. */
  verify?: string;
  protect?: string;
  requireChange?: string;
  redBefore?: string;
  writable?: string;
  /** Disjoint review of a succeeded change job: who reviews, at which tier, and how many automatic corrections. */
  review?: ReviewTarget;
  reviewTier?: Tier;
  reviewRounds?: number;
}

export const JOB_STATES = [
  "queued",
  "starting",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];
export type TerminalJobState = Extract<JobState, "succeeded" | "failed" | "cancelled">;

export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<JobState, ReadonlySet<JobState>>> = {
  queued: new Set(["starting", "cancel_requested", "cancelled", "failed"]),
  starting: new Set(["running", "cancel_requested", "cancelled", "failed"]),
  running: new Set(["cancel_requested", "succeeded", "failed"]),
  cancel_requested: new Set(["cancelled", "failed"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function canTransition(from: JobState, to: JobState): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid job transition: ${from} -> ${to}`);
  }
}

export const FAILURE_CODES = [
  "provider_auth",
  "provider_rate_limit",
  "provider_unavailable",
  "provider_protocol",
  "command_timeout",
  "quality_gate",
  /** A gate that already failed on the job's start commit: the bench was broken before the job ran. */
  "gate_broken",
  "review_protocol",
  "review_stale",
  "sandbox_unavailable",
  "sandbox_apply",
  "rollout_conflict",
  "worktree_busy",
  "invalid_request",
  "cancelled_by_user",
  "daemon_restart",
  "unknown",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export interface FailureInfo {
  code: FailureCode;
  summary: string;
  retryable: boolean;
  resumable: boolean;
  exitCode: number | null;
  signal: string | null;
  occurredAt: string;
  /** A tool call that started but never returned before the process died, per `dangling.ts`. */
  interruptedTool?: { kind: string; command: string };
}

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  defaultBranch?: string;
  workflows: WorkflowConfig[];
}

/** Per-workflow review defaults; a job's own `review*` spec overrides them. */
export interface ReviewConfig {
  maxRollouts?: number;
  rolloutRankBy?: 'fewest-lines';
  enabled: boolean;
  provider: "other" | Provider;
  tier: Tier;
  charter?: string;
  /** Read-only workflow of the same project the reviewer runs under; the first read-only one when omitted. */
  workflowId?: string;
  /** Automatic corrections after a refutation (0 = review only). */
  maxCorrections: number;
  /** Reviewer tier for a small delta (file count and changed lines at or under the bounds, no protected path touched); null reviews every change at `tier`. */
  small: { maxFiles: number; maxLines: number; tier: Tier } | null;
}

export interface WorkflowConfig {
  id: string;
  name: string;
  readOnly: boolean;
  /** Wall-clock deadline for one provider attempt; defaults to one hour. */
  providerTimeoutMs?: number;
  /** Wall-clock deadline for each verify, proof, bench or quality command; defaults to 15 minutes. */
  gateTimeoutMs?: number;
  qualityCommands: string[][];
  review?: ReviewConfig;
  evaluation?: EvaluationConfig;
}

/** The container above rooms: one workflow's rooms grouped under one heading. */
export interface SessionSummary {
  id: string;
  title: string;
  projectId: string;
  workflowId: string;
  roomCount: number;
  /** Rooms that are not archived. The sidebar counts these; `roomCount` is the total that still exists. */
  activeRoomCount: number;
  createdAt: string;
  lastActivityAt: string;
}

export interface RoomSummary {
  tasks?: import("./coordination.js").TaskView[];
  taskCounts?: Partial<Record<import("./coordination.js").TaskState, number>>;
  id: string;
  title: string;
  projectId: string;
  sessionId: string;
  archived: boolean;
  /** A flag the client groups by. It deliberately does not reorder `rooms.list`; see listRooms. */
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  jobCounts: Partial<Record<JobState, number>>;
  needsAttention: boolean;
  /** Latest review in the room: a reviewer still queued or running, or its verdict; null when nothing was reviewed. */
  review: RoomReviewState | null;
  /** Acceptance of the latest work job; absent/null for legacy and read-only work. */
  evaluation?: EvaluationView | null;
}

export type RoomReviewState = "pending" | import("./features.js").ReviewOutcome;

/** The review of a work job, as shown on the job it reviewed. */
export interface ReviewView {
  outcome?: import('./features.js').ReviewOutcome | null;
  reasons?: import('./features.js').VerdictReason[];
  /** Reviewer job id; null when the review was skipped (see `skipped`). */
  jobId: string | null;
  provider: Provider | null;
  tier: Tier | null;
  model: string | null;
  effort: Effort | null;
  state: JobState | null;
  verdict: Verdict | null;
  round: number;
  /** Why no reviewer was created, e.g. the codex quota guard. */
  skipped: string | null;
}

/** Latest liveness report from a provider attempt; kept on the job after it ends. */
export interface JobProgress {
  attempt: number;
  /** Provider steps seen so far: codex items (commands, edits, messages) or claude tool calls. */
  items: number;
  lastKind: string | null;
  /** The last step's command, path or message, cut to 120 characters. */
  lastCommand: string | null;
  /** The provider's latest assistant text (a claude text block or a codex agent message), one line cut to 200 characters. */
  lastNote: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number;
  at: string;
}

/** Raw facts about one finished job, emitted as a routing.observation.v1 event so a policy can be recomputed later. */
export interface RoutingObservation {
  /** Selection provenance; absent on historical observations. */
  armSource?: import("./features.js").ArmSource;
  /** Effective posterior mean at dispatch; absent on historical observations. */
  armMean?: number | null;
  requestedModel?: string | null;
  reportedModel?: string | null;
  jobId: string;
  roomId: string;
  provider: Provider;
  projectId: string;
  workflowId: string;
  charter: string | null;
  cwd: string | null;
  requestedTier: Tier | null;
  tier: Tier | null;
  model: string | null;
  effort: Effort | null;
  state: TerminalJobState;
  failureCode: FailureCode | null;
  cause: FailureCause | null;
  inputTokens: number | null;
  /**
   * input - cached, clamped at 0, summed only over attempts that recorded a cache figure; null when none did.
   * Absent on events recorded before this field existed.
   */
  uncachedInputTokens?: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  changedFiles: number;
  escalatedFrom: string | null;
  retryOfJobId: string | null;
  threadId: string | null;
  grade: Grade | null;
}

export interface RoutingPolicyView {
  key: string;
  provider: Provider;
  workflowId: string;
  charter: string | null;
  tier: Tier;
  reason: string;
  updatedAt: string;
  observations: number;
  capabilityFailures: number;
  goodGrades: number;
  badGrades: number;
}

export interface JobSummary {
  executionKind: import('./features.js').ExecutionKind;
  reviewOutcome: import('./features.js').ReviewOutcome | null;
  verdictJson: import('./features.js').StructuredVerdict | null;
  armSource: import('./features.js').ArmSource;
  resolvedModel: string | null;
  modelIdentity: import('./features.js').ModelIdentityKind;
  rolloutGroupId: string | null;
  promotionOf: string | null;
  taskId?: string | null;
  task?: import("./coordination.js").TaskView | null;
  requestedModel?: string | null;
  reportedModel?: string | null;
  predecessorJobId?: string | null;
  usage?: JobUsageSummary;
  id: string;
  roomId: string;
  provider: Provider;
  state: JobState;
  workflowId: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  currentAttempt: number;
  failure: FailureInfo | null;
  resultPreview: string | null;
  tier: Tier | null;
  model: string | null;
  effort: Effort | null;
  charter: string | null;
  escalatedFrom: string | null;
  progress: JobProgress | null;
  grade: Grade | null;
  gradeSource: GradeSource | null;
  /** Reviewer reasons (or the human's note) behind the grade. */
  gradeNote: string | null;
  role: JobRole;
  /** For a review job: the work job it reviews and the review round (1 = first review of that job). */
  reviewOf: string | null;
  reviewRound: number | null;
  /** For a review job: the parsed verdict; null until it finished or when it failed `review_protocol`. */
  verdict: Verdict | null;
  /** For a work job: its latest review, or null when none was requested. */
  review: ReviewView | null;
  evaluation?: EvaluationView | null;
}

export interface AcceptanceDecisionInput {
  verdict: "accepted" | "rejected";
  note: string;
  checked: number[];
  fingerprint: string;
  evidenceHash: string;
  /** Explicit human model-quality feedback; null/omitted leaves routing grades unchanged. */
  routingGrade?: Grade | null;
}

export interface TurnView {
  /** A bounded snapshot preview; use turns.read to retrieve the complete body. */
  bodyTruncated?: boolean;
  /**
   * Position within the room, ascending and stable: the row id cursor traversal
   * already orders by. A client pages a transcript on this because `createdAt` is
   * neither unique nor a total order. Renumbered only by a table rebuild, which
   * means a schema migration and therefore a restart the client refetches across.
   */
  seq?: number;
  id: string;
  /** Null for a turn recorded with `turns.record` rather than produced by a job. */
  jobId: string | null;
  roomId: string;
  author: "human" | Provider | "system";
  recipient: Provider | "both" | "human";
  body: string;
  createdAt: string;
  status: "pending" | "streaming" | "complete" | "failed";
  /** Model and effort behind a provider turn, when known; shown as a badge in the chat. */
  model: string | null;
  effort: Effort | null;
  /** `review` for the brief and reply of a reviewer job; such turns never enter later follow-up replays. */
  role: JobRole;
}

export interface AttemptView {
  id: string;
  jobId: string;
  turnId: string;
  number: number;
  state: JobState;
  startedAt: string | null;
  finishedAt: string | null;
  failure: FailureInfo | null;
  /** Null for imported attempts whose provider transcript cannot prove either case. */
  hadToolActivity: boolean | null;
  worktreeFingerprint: string | null;
  /** Effective provider command (prompt excluded); null for imported attempts. */
  argv: string[] | null;
}

export interface CheckView {
  id: string;
  jobId: string;
  command: string[];
  state: "pending" | "passed" | "failed" | "skipped";
  exitCode: number | null;
  summary: string | null;
}

export interface ChangeView {
  /** Absent only in legacy snapshots. */
  jobId?: string;
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number | null;
  deletions: number | null;
}

export interface ArtifactView {
  id: string;
  jobId: string;
  kind: "result" | "provider_log" | "gate_log" | "export" | "evidence";
  name: string;
  mediaType: string;
  size: number;
}

/** Bounded, syntax-only declaration data. It never claims type-checker or runtime resolution. */
export interface OutlineDeclarationV1 {
  kind: string;
  name: string | null;
  signature: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  documentation?: string;
}

export interface OutlineProblemV1 {
  code: "unsupported_language" | "parse_error" | "truncated" | "deadline";
  message: string;
  line?: number;
}

export interface OutlineResultV1 {
  version: 1;
  path: string;
  contentHash: string;
  language: "javascript" | "typescript" | "tsx" | "unsupported";
  parserVersion: string;
  declarations: OutlineDeclarationV1[];
  truncated: boolean;
  problems: OutlineProblemV1[];
}

/** Immutable early feedback. Its presence never changes job, evaluation, or acceptance state. */
export interface ProvisionalResultV1 {
  version: 1;
  artifactId: string;
  name: "provisional-result.v1.json";
  mediaType: "application/json";
  size: number;
  sha256: string;
  candidate: CanonicalIdentity;
  checksCompleted: readonly ["provider_protocol", "scope_absent", "application_complete"];
}

export type ExecutionSetupPhase =
  | "sandbox_availability"
  | "baseline_capture"
  | "dependency_materialization"
  | "dependency_plan"
  | "isolation_prepare";

export interface ExecutionSetupTraceV1 {
  version: 1;
  kind: "provider" | "gate" | "proof" | "bench";
  phases: Array<{ phase: ExecutionSetupPhase; elapsedMs: number }>;
  totalMs: number;
}

export interface RoomDetail {
  tasks?: import("./coordination.js").TaskView[];
  /** Highest durable event included in this snapshot. Absent on legacy clients. */
  eventCursor?: number;
  nextCursor?: string | null;
  /** Jobs whose newest current change is included in this page, marking where a replacement set begins. */
  resetChangesFor?: string[];
  /** Jobs whose complete change set (including an empty set) is included in this page. */
  completeChangesFor?: string[];
  room: RoomSummary;
  jobs: JobSummary[];
  turns: TurnView[];
  attempts: AttemptView[];
  checks: CheckView[];
  changes: ChangeView[];
  artifacts: ArtifactView[];
}

export interface QueueWaitStats {
  p50: number | null;
  p95: number | null;
  max: number | null;
  samples: number;
}

export interface JobUsageSummary {
  attempts: number;
  measuredAttempts: number;
  unmeasuredAttempts: number;
  usageComplete: boolean;
  durationMs: number | null;
  /** Enqueue-to-first-dispatch time; absent on older servers, null if never dispatched or invalid. */
  queueWaitMs?: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  /**
   * input - cached, clamped at 0, summed only over measuredAttempts; null when this job has none. Optional so an
   * older server's JobSummary (without this field) still satisfies the type.
   */
  uncachedInputTokens?: number | null;
  outputTokens: number | null;
}

export interface RoomSnapshot extends RoomDetail {
  eventCursor: number;
  nextCursor: string | null;
}

/** Byte offsets and base64 preserve UTF-8 characters split across content chunks. */
export interface ContentChunk {
  id: string;
  offset: number;
  nextOffset: number | null;
  totalBytes: number;
  encoding: "base64";
  data: string;
  mediaType: string;
  name?: string;
}

export interface EventEnvelope<T = unknown> {
  id: number;
  roomId: string | null;
  jobId: string | null;
  type: string;
  occurredAt: string;
  data: T;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
  };
}

export interface RpcRequest<T = unknown> {
  id: string;
  method: string;
  params: T;
  idempotencyKey?: string;
}

export interface RpcResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface CreateRoomInput extends JobSpecInput {
  title: string;
  projectId: string;
  workflowId: string;
  prompt: string;
  /** Omitted only when the job's charter declares a `bus:` ladder, which then picks the provider. */
  recipients?: Provider[];
}

export interface AddMessageInput extends JobSpecInput {
  body: string;
  recipient: Provider | "both";
}

export interface HandoffInput extends JobSpecInput {
  sourceJobId: string;
  targetProvider: Provider;
  instruction: string;
}

/** `jobs.review`: a manual reviewer for a succeeded work job, built from its stored evidence. */
export interface ReviewJobInput {
  jobId: string;
  provider?: Provider;
  tier?: Tier;
}

/**
 * Review events, all carrying `workerJobId` and `round`:
 * `review.requested` {reviewerJobId, provider, tier, evidenceComplete, job: JobSummary of the reviewer}
 * `review.verdict` {reviewerJobId, verdict, grade: Grade | null, note}
 * `review.inconclusive` {reviewerJobId, reason}  (malformed output = reviewer failed `review_protocol`)
 * `review.skipped` {reason}  (no reviewer job was created)
 * `review.superseded` {reviewerJobId, continuationJobId, byJobId}  (a human follow-up won the thread)
 * `review.stale` {reviewerJobId, continuationJobId}  (the tree moved before the correction ran)
 * `review.exhausted` {reviewerJobId}  (refuted with no corrections left)
 * `job.graded` {jobId, grade, note, source}
 */
export const REVIEW_EVENTS = [
  "review.requested",
  "review.verdict",
  "review.inconclusive",
  "review.skipped",
  "review.superseded",
  "review.stale",
  "review.exhausted",
] as const;

export type TransportState =
  | "connecting"
  | "live"
  | "stale"
  | "reconnecting"
  | "offline"
  | "auth_expired";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export function isSafeId(value: string): boolean {
  return SAFE_ID.test(value);
}
