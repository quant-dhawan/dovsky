import assert from "node:assert/strict";
import test from "node:test";
import type { StructuredVerdict } from "@dovsky/protocol";
import { finalizeReviewDecision, reviewRetryDecision } from "./review-policy.js";

const approved: StructuredVerdict = { verdict: "approved", reasons: [], confidence: 1, incomplete_evidence_ack: false };
test("approval without complete evidence is inconclusive and never grades", () => {
  const decision = finalizeReviewDecision({ verdict: approved, proseFallback: false, evidenceComplete: false });
  assert.equal(decision.outcome, "inconclusive"); assert.equal(decision.grade, null);
  assert.deepEqual(finalizeReviewDecision({ verdict: null, proseFallback: false, evidenceComplete: true }), { outcome: "protocol_failed", verdict: null, renderedReasons: "", proseFallback: false, grade: null });
});
test("only one ordinary transient retry retains tier and increments review round", () => {
  const retry = reviewRetryDecision({ executionKind: "review", failureCode: "provider_unavailable", reviewerJobId: "review-1", reviewRound: 0, reviewRetryOf: null, capacityAvailable: true, providerAvailable: true });
  assert.deepEqual(retry, { retry: true, retryOf: "review-1", reviewRound: 1, sameTier: true });
  assert.equal(reviewRetryDecision({ executionKind: "review", failureCode: "command_timeout", reviewerJobId: "review-2", reviewRound: 1, reviewRetryOf: "review-1", capacityAvailable: true, providerAvailable: true }).retry, false);
  assert.equal(reviewRetryDecision({ executionKind: "rollout_review", failureCode: "provider_unavailable", reviewerJobId: "rollout", reviewRound: 0, reviewRetryOf: null, capacityAvailable: true, providerAvailable: true }).retry, false);
});
test("protocol and ordinary permanent failures never retry", () => {
  assert.deepEqual(reviewRetryDecision({ executionKind: "review", failureCode: "review_protocol", reviewerJobId: "review", reviewRound: 0, reviewRetryOf: null, capacityAvailable: true, providerAvailable: true }), { retry: false, outcome: "protocol_failed", reason: "review protocol failures are terminal" });
  assert.equal(reviewRetryDecision({ executionKind: "review", failureCode: "quality_gate", reviewerJobId: "review", reviewRound: 0, reviewRetryOf: null, capacityAvailable: true, providerAvailable: true }).retry, false);
});
