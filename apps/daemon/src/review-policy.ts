import type { ReviewOutcome, StructuredVerdict } from "@dovsky/protocol";
import { renderReasons } from "./review.js";
export type ReviewGrade = "good" | "bad" | null;
export interface ReviewFinalizationInput { verdict: StructuredVerdict | null; proseFallback: boolean; evidenceComplete: boolean; }
export interface ReviewFinalizationDecision { outcome: ReviewOutcome; verdict: StructuredVerdict | null; renderedReasons: string; proseFallback: boolean; grade: ReviewGrade; }
/** Pure terminal mapping: malformed/no verdict never becomes a retryable disagreement. */
export function finalizeReviewDecision(input: ReviewFinalizationInput): ReviewFinalizationDecision {
  if (!input.verdict) return { outcome: "protocol_failed", verdict: null, renderedReasons: "", proseFallback: input.proseFallback, grade: null };
  const outcome: ReviewOutcome = input.verdict.verdict === "approved" && !input.evidenceComplete ? "inconclusive" : input.verdict.verdict;
  return { outcome, verdict: input.verdict, renderedReasons: renderReasons(input.verdict.reasons), proseFallback: input.proseFallback, grade: outcome === "approved" ? "good" : outcome === "refuted" ? "bad" : null };
}
export type ReviewTransientCode = "provider_auth" | "provider_rate_limit" | "provider_unavailable" | "command_timeout" | "daemon_restart" | "unknown";
export interface ReviewRetryInput { executionKind: "review" | "rollout_review"; failureCode: string | null; reviewerJobId: string; reviewRound: number; reviewRetryOf: string | null; capacityAvailable: boolean; providerAvailable: boolean; }
export type ReviewRetryDecision = { retry: true; retryOf: string; reviewRound: number; sameTier: true } | { retry: false; outcome: "reviewer_failed" | "protocol_failed"; reason: string };
const TRANSIENT_CODES = new Set<ReviewTransientCode>(["provider_auth", "provider_rate_limit", "provider_unavailable", "command_timeout", "daemon_restart", "unknown"]);
/** At most one ordinary-review retry; rollout reviewers never branch into correction/retry work. */
export function reviewRetryDecision(input: ReviewRetryInput): ReviewRetryDecision {
  if (input.failureCode === "review_protocol") return { retry: false, outcome: "protocol_failed", reason: "review protocol failures are terminal" };
  if (input.executionKind === "rollout_review") return { retry: false, outcome: "reviewer_failed", reason: "rollout reviews do not retry individually" };
  if (!input.capacityAvailable || !input.providerAvailable) return { retry: false, outcome: "reviewer_failed", reason: "review retry capacity or provider is unavailable" };
  if (input.reviewRetryOf !== null) return { retry: false, outcome: "reviewer_failed", reason: "review already consumed its retry" };
  if (!input.failureCode || !TRANSIENT_CODES.has(input.failureCode as ReviewTransientCode)) return { retry: false, outcome: "reviewer_failed", reason: "review failure is not transient" };
  return { retry: true, retryOf: input.reviewerJobId, reviewRound: input.reviewRound + 1, sameTier: true };
}
