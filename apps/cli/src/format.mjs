import { sanitizeForPrint, stripTerminalControl } from "./sanitize.mjs";
export function print(value, compact = false) { process.stdout.write(`${JSON.stringify(sanitizeForPrint(value), null, compact ? 0 : 2)}\n`); }
export function printText(value) { process.stdout.write(`${stripTerminalControl(String(value))}\n`); }
const text = (value) => stripTerminalControl(String(value));
function queueWait(value) { return typeof value === "number" ? `${value}ms` : "unknown"; }
export function formatStatus(detail) {
  const lines = [`${text(detail.room.title)} (${text(detail.room.id)})`];
  for (const job of detail.jobs ?? []) {
    lines.push(`- ${text(job.id).slice(0, 8)} ${text(job.provider)} ${text(job.state)} role=${text(job.role ?? "work")}`);
    if (job.role === "review") {
      lines.push(`  review: ${text(job.reviewOutcome ?? job.verdict ?? "pending")} target=${text(job.provider)} round=${job.reviewRound ?? job.round ?? 0}`);
      if (job.reasons?.length) lines.push(`  reasons: ${job.reasons.map((reason) => text(typeof reason === "string" ? reason : reason.defect ?? "")).filter(Boolean).join("; ")}`);
      lines.push(`  queue wait: ${queueWait(job.usage?.queueWaitMs)}`);
      continue;
    }
    lines.push(`  acceptance: ${job.evaluation ? `${text(job.evaluation.state)} (${text(job.evaluation.level)})` : "unevaluated"}`);
    if (job.evaluation?.outstanding?.length) lines.push(`  requires: ${job.evaluation.outstanding.map(text).join("; ")}`);
    const review = job.review;
    if (review || job.reviewOutcome) {
      const outcome = review?.outcome ?? job.reviewOutcome ?? review?.verdict ?? "pending";
      lines.push(`  review: ${text(outcome)}${review ? ` target=${text(review.provider ?? "unknown")} round=${review.round ?? 0}` : ""}`);
      const reasons = review?.reasons ?? job.reasons ?? (review?.verdict === "refuted" ? [job.gradeNote] : []);
      if (reasons?.length) lines.push(`  reasons: ${reasons.map((reason) => text(typeof reason === "string" ? reason : reason.defect ?? "")).filter(Boolean).join("; ")}`);
    }
    lines.push(`  queue wait: ${queueWait(job.usage?.queueWaitMs)}`);
    if (job.rollout?.state ?? job.rolloutState) lines.push(`  rollout: ${text(job.rollout?.state ?? job.rolloutState)}`);
  }
  if (detail.usage?.queueWait) lines.push(`queue wait (24h): p50 ${queueWait(detail.usage.queueWait.p50)}, p95 ${queueWait(detail.usage.queueWait.p95)}, max ${queueWait(detail.usage.queueWait.max)}, samples ${detail.usage.queueWait.samples ?? 0}`);
  return `${lines.join("\n")}\n`;
}
