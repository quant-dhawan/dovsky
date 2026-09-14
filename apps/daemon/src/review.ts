import type { StructuredVerdict, Verdict, VerdictReason } from "@dovsky/protocol";

export const MAX_VERDICT_REASONS = 20;
const MAX_PATH_LENGTH = 1024;
const MAX_TEXT_LENGTH = 4096;
const MAX_LINE = 10_000_000;

const reasonSchema = {
  type: "object", additionalProperties: false, required: ["path", "line", "defect", "trigger"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH },
    line: { type: ["integer", "null"], minimum: 1, maximum: MAX_LINE },
    defect: { type: "string", minLength: 1, maxLength: MAX_TEXT_LENGTH },
    trigger: { type: "string", minLength: 1, maxLength: MAX_TEXT_LENGTH },
  },
} as const;
const verdictProperties = {
  verdict: { enum: ["approved", "refuted", "inconclusive"] },
  reasons: { type: "array", maxItems: MAX_VERDICT_REASONS, items: reasonSchema },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  incomplete_evidence_ack: { type: "boolean" },
} as const;

export const VERDICT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
  required: ["verdict", "reasons", "confidence", "incomplete_evidence_ack"], properties: verdictProperties,
  allOf: [{ if: { properties: { verdict: { const: "refuted" } }, required: ["verdict"] }, then: { properties: { reasons: { minItems: 1 } } } }],
} as const;
/** Equivalent bounded schema for providers that reject JSON Schema conditionals. */
export const VERDICT_SCHEMA_FLAT = {
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
  required: ["verdict", "reasons", "confidence", "incomplete_evidence_ack"], properties: verdictProperties,
} as const;

/** Standing instruction for a reviewer job; the evidence file follows it in the same prompt. */
export const REVIEW_INSTRUCTION = `You are the disjoint reviewer of a change another model just made. Your working directory is the repository at the START commit, read-only; it does not contain the change. Everything you know about the change is the evidence below: the brief, the worker's reply, the gate results, and a unified diff per file with 20 lines of context around every change.
Read the diff as an adversary. The gates went green, and green changes have been defective in their last tenth before: a bare branch eating an unrelated list, a comment claiming a cap is live that cannot fire, a guard deleted together with the helper that held it, a stale sentence that was itself the miscount. Hunt for the concrete defect: wrong behavior on a real input, a claim in the reply the diff does not support, an edit outside the brief, a test that cannot fail, a file the brief needed that was not touched.
Reply only with one JSON object matching the supplied verdict schema. Do not include markdown, prose, tool calls, or a legacy VERDICT sentinel. If the evidence header says INCOMPLETE you may not answer approved. You cannot run the change and must not try; do not use dovsky or spawn agents.`;

/** Standing instruction ahead of every fresh work job's brief; a resumed thread has already read it. */
export const WORK_INSTRUCTION = `You are running unattended on a message bus. Nobody is watching and nobody can answer a question, so do not ask one: finish the task, and if a part is blocked, finish every other part and say what you left out and why. Inspect the relevant files before deciding anything; do not answer from memory. Your final reply is the only text the room and the reviewer see, so make it a standalone recap: what changed, what you verified with the actual output, and what could not be run, each marked [needs-operator].`;

/** Appended to WORK_INSTRUCTION when the workflow may edit the tree. */
export const CHANGE_INSTRUCTION = `The brief is the whole scope. Make targeted edits: no formatter, and every changed line must trace to the brief. Report a nearby defect instead of fixing it. Scratch checks you wrote to convince yourself are not kept as tests. Revert build artifacts before you reply.`;

const SENTINEL = /^VERDICT: (APPROVED|REFUTED|INCONCLUSIVE)$/;
const REASON = /^\s*\d+[.)]\s+\S/;
export interface ParsedVerdict { verdict: Verdict; reasons: string; proseFallback: true; reasonsMissing?: true; }
export type StructuredVerdictParse = StructuredVerdict | { error: string };

function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function validText(value: unknown, limit: number): string | null { return typeof value === "string" && value.trim().length > 0 && value.length <= limit ? value.trim() : null; }
function parseReason(value: unknown): VerdictReason | null {
  const candidate = record(value); if (!candidate) return null;
  const path = validText(candidate.path, MAX_PATH_LENGTH), defect = validText(candidate.defect, MAX_TEXT_LENGTH), trigger = validText(candidate.trigger, MAX_TEXT_LENGTH);
  const rawLine = candidate.line;
  const line: number | null = rawLine === null ? null : typeof rawLine === "number" && Number.isInteger(rawLine) && rawLine >= 1 && rawLine <= MAX_LINE ? rawLine : null;
  if (!path || !defect || !trigger || (rawLine !== null && line === null)) return null;
  return { path, line, defect, trigger };
}

/** Preserve a known verdict conservatively when non-verdict metadata is unusable. */
export function parseStructuredVerdict(value: unknown): StructuredVerdictParse {
  const candidate = record(value);
  if (!candidate) return { error: "Structured verdict must be an object" };
  const verdict = candidate.verdict;
  if (verdict !== "approved" && verdict !== "refuted" && verdict !== "inconclusive") return { error: "Structured verdict has an unknown verdict" };
  const rawReasons = Array.isArray(candidate.reasons) ? candidate.reasons.slice(0, MAX_VERDICT_REASONS) : [];
  const reasons = rawReasons.map(parseReason).filter((reason): reason is VerdictReason => reason !== null);
  const confidence = typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1 ? candidate.confidence : 0;
  const parsed: StructuredVerdict = { verdict, reasons, confidence, incomplete_evidence_ack: candidate.incomplete_evidence_ack === true };
  if (verdict === "refuted" && reasons.length === 0) parsed.reasonsMissing = true;
  return parsed;
}
export function renderReasons(reasons: readonly VerdictReason[]): string { return reasons.map((reason, index) => `${index + 1}. ${reason.path}${reason.line === null ? "" : `:${reason.line}`} — ${reason.defect} (triggered by: ${reason.trigger})`).join("\n"); }

/** Compatibility parser for legacy prose reviewer output. */
export function parseVerdict(result: string): ParsedVerdict | { error: string } {
  const lines = result.split(/\r?\n/);
  const sentinels = lines.filter((line) => /^\s*VERDICT:/.test(line));
  if (sentinels.length !== 1) return { error: sentinels.length === 0 ? "no VERDICT line" : "more than one VERDICT line" };
  let last = lines.length - 1;
  while (last >= 0 && lines[last]!.trim() === "") last -= 1;
  const match = last >= 0 ? SENTINEL.exec(lines[last]!.trim()) : null;
  if (!match) return { error: "the final non-empty line is not a VERDICT line" };
  const verdict = match[1]!.toLowerCase() as Verdict;
  const reasons = lines.slice(0, last).join("\n").trim();
  return verdict === "refuted" && !lines.slice(0, last).some((line) => REASON.test(line)) ? { verdict, reasons, proseFallback: true, reasonsMissing: true } : { verdict, reasons, proseFallback: true };
}
