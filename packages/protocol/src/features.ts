import type { JobState, Provider, Tier, Verdict } from "./index.js";

export const REVIEW_OUTCOMES = ["approved", "refuted", "inconclusive", "reviewer_failed", "protocol_failed"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
export interface VerdictReason { path: string; line: number | null; defect: string; trigger: string }
export interface StructuredVerdict {
  verdict: Verdict;
  reasons: VerdictReason[];
  confidence: number;
  incomplete_evidence_ack: boolean;
  reasonsMissing?: boolean;
}

export const ARM_SOURCES = ["explicit", "inherited", "bandit", "ladder-floor", "operator-pinned", "charter-fixed", "legacy_unknown"] as const;
export type ArmSource = (typeof ARM_SOURCES)[number];
export const MODEL_IDENTITY_KINDS = ["reported", "configured_unverified", "mismatch", "legacy_unknown"] as const;
export type ModelIdentityKind = (typeof MODEL_IDENTITY_KINDS)[number];
export interface RoutingArm {
  key: string;
  provider: Provider;
  workflowId: string;
  charter: string | null;
  tier: Tier;
  alpha: number;
  beta: number;
  successes: number;
  failures: number;
  pinned: boolean;
  updatedAt: string;
  lastUsedAt: string | null;
}

export const EXECUTION_KINDS = ["foreground", "review", "rollout_candidate", "rollout_review", "promotion"] as const;
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];
export function isForegroundExecution(kind: ExecutionKind): boolean {
  return kind === "foreground" || kind === "promotion";
}
export const ROLLOUT_OUTCOMES = ["running", "paused", "promoting", "promoted", "exhausted", "cancelled", "stale", "failed"] as const;
export type RolloutOutcome = (typeof ROLLOUT_OUTCOMES)[number];
export interface CanonicalIdentity { fingerprint: string; contentHash: string }
export interface QuotaWindowReading {
  windowId: string;
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string | null;
  recordedAt: string;
  source: string;
}
export interface SandboxConfig {
  enabled: true;
  backend: 'bwrap';
  network: boolean;
  memoryMax: string;
  cpuQuota: string;
  tasksMax: number;
  /** Explicit readonly host mounts, never writable copies of the operator home. */
  homePaths: string[];
  runtimePaths: string[];
  dependencyRoots: string[];
}
export interface BanditConfig {
  enabled: boolean;
  costPenalty: number;
  costWeights: Record<Tier,number>;
  explorationCap: number;
  decay: number;
  widenSingleRungLadders: boolean;
  recentWindow: number;
}
export interface GitHubConfig {
  enabled: boolean;
  remote: string;
  repository: string;
  baseBranch: string;
  commitName: string;
  commitEmail: string;
  draft: boolean;
}
export interface RolloutGroupView {
  id: string;
  roomId: string;
  taskId: string | null;
  workerJobId: string;
  reviewerJobId: string;
  state: RolloutOutcome;
  canonical: CanonicalIdentity;
  candidateIds: string[];
  winnerJobId: string | null;
  promotionJobId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface RolloutCandidateView {
  jobId: string;
  state: JobState;
  reviewOutcome: ReviewOutcome | null;
  contentHash: string | null;
}

export const PULL_REQUEST_STATES = ["reserved", "committed", "pushed", "open", "merged", "closed", "reconcile_required"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];
export interface PullRequestView {
  jobId: string;
  roomId: string;
  repository: string;
  remote: string;
  baseBranch: string;
  branch: string;
  startCommit: string;
  headSha: string | null;
  number: number | null;
  url: string | null;
  state: PullRequestState;
  fingerprint: string;
  contentHash: string;
  evidenceHash: string;
  bodyHash: string | null;
  mergedAt: string | null;
  mergeCommit: string | null;
  createdAt: string;
  updatedAt: string;
}
