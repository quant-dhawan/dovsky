import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { EVALUATION_LEVELS, type EvaluationReport, type EvaluationView, type ReviewView, type ScenarioResult } from "@dovsky/protocol";
import { DaemonError, type RuntimeWorkflowConfig } from "./config.js";
import type { EvaluationSpec, StoredJob } from "./model.js";

export const evidenceHash = (text: string): string => createHash("sha256").update(text).digest("hex");

export function resolveEvaluation(params: Record<string, unknown>, workflow: RuntimeWorkflowConfig, workdir: string, inherited: EvaluationSpec | null): EvaluationSpec | null {
  if (workflow.readOnly) {
    if (inherited) throw new DaemonError("INVALID_REQUEST", "Read-only work cannot replace an evaluated room contract; use a change follow-up or a new room");
    if (params.evalLevel !== undefined || params.acceptance !== undefined) throw new DaemonError("INVALID_REQUEST", "Read-only work has no change acceptance policy");
    return null;
  }
  if (!inherited && !workflow.evaluation?.enabled) {
    if (params.evalLevel !== undefined || params.acceptance !== undefined) throw new DaemonError("INVALID_REQUEST", "Evaluation is not enabled for this workflow");
    return null;
  }
  const level = params.evalLevel ?? inherited?.level ?? workflow.evaluation!.defaultLevel;
  if (!EVALUATION_LEVELS.includes(level as never)) throw new DaemonError("INVALID_REQUEST", "evalLevel must be low, medium or high");
  const reason = params.evalReason ?? inherited?.reason ?? null;
  if (reason !== null && (typeof reason !== "string" || !reason.trim() || reason.length > 4000)) throw new DaemonError("INVALID_REQUEST", "evalReason must be non-empty text (up to 4000 characters)");
  if (level === "low" && !reason) throw new DaemonError("INVALID_REQUEST", "Low-risk changes require --eval-reason");
  const acceptance = params.acceptance ?? inherited ?? { criteria: [] };
  if (!acceptance || typeof acceptance !== "object" || Array.isArray(acceptance)) throw new DaemonError("INVALID_REQUEST", "acceptance must contain criteria");
  const input = acceptance as Record<string, unknown>;
  const criteria = input.criteria;
  if (!Array.isArray(criteria) || criteria.length > 30 || criteria.some((c) => typeof c !== "string" || !c.trim() || c.length > 2000)) throw new DaemonError("INVALID_REQUEST", "acceptance.criteria must be an array of up to 30 non-empty strings");
  if (level !== "low" && criteria.length === 0) throw new DaemonError("INVALID_REQUEST", "Medium/high changes require acceptance criteria; supply --acceptance-file with {\"criteria\":[\"observable outcome\"]}");
  const expected = input.expectedBaselineFailures ?? [];
  if (!Array.isArray(expected) || expected.length > 30 || expected.some((id) => typeof id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(id))) throw new DaemonError("INVALID_REQUEST", "expectedBaselineFailures must contain scenario IDs");
  if (level !== "high" && expected.length) throw new DaemonError("INVALID_REQUEST", "Expected baseline failures require high evaluation");
  if (inherited) {
    if (EVALUATION_LEVELS.indexOf(level as never) < EVALUATION_LEVELS.indexOf(inherited.level) || inherited.criteria.some((c) => !criteria.includes(c)) || JSON.stringify(expected) !== JSON.stringify(inherited.expectedBaselineFailures ?? [])) {
      throw new DaemonError("INVALID_REQUEST", "Follow-ups and retries cannot weaken frozen evaluation requirements; start a new room for a different acceptance contract");
    }
    return { ...inherited, level: level as EvaluationSpec["level"], reason: reason as string | null, criteria: [...criteria], reviewRequired: inherited.reviewRequired || level !== "low" };
  }
  const runnerPath = workflow.evaluation!.runner;
  if (isAbsolute(runnerPath) || runnerPath.split("/").includes("..")) throw new DaemonError("INVALID_REQUEST", "Evaluation runner must be relative to the project");
  const runnerSource = readFileSync(resolve(workdir, runnerPath), "utf8");
  if (Buffer.byteLength(runnerSource) > 256 * 1024) throw new DaemonError("INVALID_REQUEST", "Evaluation runner exceeds 256 KiB");
  return {
    baselineJobId: null,
    level: level as EvaluationSpec["level"], reason: reason as string | null, criteria: [...criteria], expectedBaselineFailures: [...expected],
    runnerSource, runnerPath, runnerHash: evidenceHash(runnerSource),
    dependencyRoots: [...(workflow.evaluation!.dependencyRoots ?? ["node_modules"])],
    qualityCommands: workflow.qualityCommands.map((command) => [...command]),
    reviewRequired: level !== "low" || (params.review ?? (workflow.review?.enabled ? workflow.review.provider : "none")) !== "none",
  };
}

export function parseScenarios(stdout: string): ScenarioResult[] {
  const value = JSON.parse(stdout) as { scenarios?: ScenarioResult[] };
  if (!Array.isArray(value.scenarios) || !value.scenarios.length || value.scenarios.length > 100) throw new Error("Runner must report 1–100 scenarios");
  const ids = new Set<string>();
  for (const item of value.scenarios) {
    if (!item || typeof item.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(item.id) || ids.has(item.id) || typeof item.passed !== "boolean" || typeof item.detail !== "string" || item.detail.length > 8000 || !Number.isFinite(item.durationMs) || item.durationMs < 0) throw new Error("Invalid or duplicate scenario result");
    ids.add(item.id);
  }
  return value.scenarios;
}

export function compareScenarios(spec: EvaluationSpec, candidate: ScenarioResult[], baseline: ScenarioResult[] | null): EvaluationReport {
  const problems = candidate.filter((item) => !item.passed).map((item) => `Candidate failed: ${item.id}`);
  if (spec.level === "high") {
    if (!baseline) problems.push("Baseline results missing");
    else {
      if (JSON.stringify(candidate.map((s) => s.id).sort()) !== JSON.stringify(baseline.map((s) => s.id).sort())) problems.push("Baseline and candidate scenario sets differ");
      const expected = spec.expectedBaselineFailures ?? [];
      for (const scenario of baseline) {
        if (!scenario.passed && !expected.includes(scenario.id)) problems.push(`Unexpected baseline failure: ${scenario.id}`);
        if (scenario.passed && expected.includes(scenario.id)) problems.push(`Expected baseline failure did not reproduce: ${scenario.id}`);
      }
      for (const id of expected) if (!baseline.some((s) => s.id === id)) problems.push(`Declared scenario missing: ${id}`);
    }
  }
  return { suiteHash: spec.runnerHash, candidate, baseline, problems };
}

export function evaluationView(job: StoredJob, review: ReviewView | null): EvaluationView | null {
  const spec = job.evaluation;
  if (!spec) return null;
  const outstanding: string[] = [];
  let blocked = false;
  if (job.taskOutcome && job.taskOutcome !== "completed") {
    outstanding.push(`Logical task ${job.taskOutcome}`);
    blocked = job.state === "succeeded";
  }
  if (job.state !== "succeeded") {
    outstanding.push(`Execution ${job.state}`);
    blocked = job.state === "failed" || job.state === "cancelled";
  }
  if (!job.endFingerprint || !job.evaluationEvidenceHash) {
    outstanding.push("Final tree and review evidence required");
    blocked ||= job.state === "succeeded";
  }
  if (spec.level !== "low" && (!job.evaluationReport || job.evaluationReport.problems.length)) {
    outstanding.push(...(job.evaluationReport?.problems.length ? job.evaluationReport.problems : ["Scripted evaluation required"]));
    blocked ||= job.state === "succeeded" || Boolean(job.evaluationReport?.problems.length);
  }
  if (spec.reviewRequired && (review?.state !== "succeeded" || review.verdict !== "approved" || review.skipped)) {
    outstanding.push(`Model review ${review?.skipped ? "skipped" : review?.verdict ?? "required"}`);
    blocked ||= Boolean(review?.skipped || review?.verdict === "refuted" || review?.verdict === "inconclusive" || review?.state === "failed" || review?.state === "cancelled");
  }
  const decision = job.acceptanceDecision;
  if (spec.level !== "low" && decision?.verdict !== "accepted") outstanding.push("Human acceptance checklist required");
  return {
    level: spec.level, reason: spec.reason, criteria: spec.criteria,
    state: decision?.verdict === "rejected" ? "rejected" : blocked ? "blocked" : outstanding.length ? "pending" : "accepted",
    outstanding, fingerprint: job.endFingerprint, evidenceHash: job.evaluationEvidenceHash,
    report: job.evaluationReport, decision,
  };
}
