import type {
  Effort,
  FailureCause,
  FailureInfo,
  Grade,
  GradeSource,
  JobRole,
  JobState,
  Provider,
  ReviewTarget,
  Tier,
  Verdict,
  AcceptanceCriteria,
  EvaluationLevel,
  EvaluationReport,
  EvaluationView,
} from "@dovsky/protocol";

/** Gates run after the provider, in this order; paths are relative to the working tree except writable, which is absolute. */
export interface JobGates {
  /** Frozen execution deadlines; absent only on jobs created by an older daemon. */
  providerTimeoutMs?: number;
  gateTimeoutMs?: number;
  /** Paths whose content must survive the run unchanged. */
  protect: string[];
  /** Regex the result must match when the tree is left unchanged. */
  requireChange: string | null;
  /** Shell command that must exit 0 on the finished tree. */
  verify: string | null;
  /** Shell command that must fail on the start commit plus the job's new test files. */
  redBefore: string | null;
  /** Extra directories the codex sandbox may write. */
  writable: string[];
}

/** Resolved per-job execution spec; null fields fall back to the workflow's configured argv and path. */
export interface JobSpec {
  evaluation: EvaluationSpec | null;
  tier: Tier | null;
  /** Tier named explicitly in the request; null when the routing policy or an inherited spec chose it. */
  requestedTier: Tier | null;
  model: string | null;
  effort: Effort | null;
  charter: string | null;
  cwd: string | null;
  gates: JobGates | null;
  /** Review requested for this job; null fields fall back to the workflow's review config. */
  review: ReviewSpec | null;
}

export interface EvaluationSpec extends AcceptanceCriteria {
  baselineJobId: string | null;
  level: EvaluationLevel;
  reason: string | null;
  runnerSource: string;
  runnerPath: string;
  runnerHash: string;
  dependencyRoots?: string[];
  qualityCommands: string[][];
  reviewRequired: boolean;
}

export interface ReviewSpec {
  rollouts?: number;
  target: ReviewTarget | null;
  tier: Tier | null;
  /** Automatic corrections still allowed after a refutation. */
  corrections: number | null;
}

export interface StoredJob extends JobSpec {
  executionKind: import('@dovsky/protocol').ExecutionKind;
  reviewOutcome: import('@dovsky/protocol').ReviewOutcome | null;
  verdictJson: import('@dovsky/protocol').StructuredVerdict | null;
  reviewRetryOf: string | null;
  armSource: import('@dovsky/protocol').ArmSource;
  resolvedModel: string | null;
  modelIdentity: import('@dovsky/protocol').ModelIdentityKind;
  rolloutGroupId: string | null;
  rolloutRank: number | null;
  rolloutOutcome: import('@dovsky/protocol').RolloutOutcome | null;
  promotionOf: string | null;
  executionBaselinePath: string | null;
  endContentHash: string | null;
  reviewInputHash: string | null;
  sandbox: Record<string, unknown> | null;
  jobDeltaPath: string | null;
  taskId: string | null;
  taskOutcome?: import("@dovsky/protocol").TaskState | null;
  predecessorJobId: string | null;
  /** True only when this continuation was queued before its predecessor became terminal. */
  predecessorPending: boolean;
  evaluationReport: EvaluationReport | null;
  acceptanceDecision: EvaluationView["decision"];
  evaluationEvidenceHash: string | null;
  id: string;
  roomId: string;
  provider: Provider;
  projectId: string;
  workflowId: string;
  state: JobState;
  prompt: string;
  result: string | null;
  attemptCount: number;
  failure: FailureInfo | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  retryOfJobId: string | null;
  sourceJobId: string | null;
  depth: number;
  /** Provider thread/session id reported by this job's run. */
  threadId: string | null;
  /** Thread this job continues (follow-up); the prompt is then the new message alone. */
  resumeThreadId: string | null;
  /** Model passed to the provider and model identity reported by its stream. */
  requestedModel: string | null;
  reportedModel: string | null;
  escalatedFrom: string | null;
  grade: Grade | null;
  gradeSource: GradeSource | null;
  gradeNote: string | null;
  cause: FailureCause | null;
  role: JobRole;
  /** Review job: the work job under review, the round, the worker's start commit, and whether the evidence was complete. */
  reviewOf: string | null;
  reviewRound: number | null;
  reviewCommit: string | null;
  evidenceComplete: boolean | null;
  verdict: Verdict | null;
  /** Work job: why no reviewer was created, when review was requested but skipped. */
  reviewSkipped: string | null;
  /** Tree fingerprint when the job finished; a continuation refuses to start if the tree moved since. */
  endFingerprint: string | null;
  /** Continuation job: the refuted work job whose thread it resumes, and the fingerprint it expects. */
  parentJobId: string | null;
  parentFingerprint: string | null;
}

/** Tokens billed to one provider run; input includes the cached share (codex convention). */
export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface RunOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  hadToolActivity: boolean;
  cancelled: boolean;
  timedOut?: boolean;
  timeoutMs?: number;
}

export interface LegacySnapshot {
  sourceJobId: string;
  room: {
    id?: string;
    title: string;
    projectId: string;
    workflowId: string;
    createdAt?: string | null;
    updatedAt?: string | null;
  };
  job: {
    id?: string;
    provider: Provider;
    state: JobState;
    prompt?: string | null;
    result?: string | null;
    createdAt?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    failure?: FailureInfo | null;
  };
  turns?: Array<{
    id?: string;
    author: "human" | Provider | "system";
    recipient: Provider | "both" | "human";
    body: string;
    createdAt?: string | null;
    status?: "pending" | "streaming" | "complete" | "failed";
  }>;
  attempts?: Array<{
    id?: string;
    number: number;
    state: JobState;
    startedAt?: string | null;
    finishedAt?: string | null;
    failure?: FailureInfo | null;
    hadToolActivity?: boolean | null;
    worktreeFingerprint?: string | null;
  }>;
  events?: Array<{
    type: string;
    occurredAt?: string | null;
    data?: unknown;
  }>;
}
