import assert from "node:assert/strict";
import test from "node:test";
import { MAX_VERDICT_REASONS, VERDICT_SCHEMA, VERDICT_SCHEMA_FLAT, parseStructuredVerdict, parseVerdict, renderReasons } from "./review.js";

test("structured review schema is bounded and only full schema conditions refuted reasons", () => {
  assert.equal(VERDICT_SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(VERDICT_SCHEMA.properties.reasons.maxItems, MAX_VERDICT_REASONS);
  assert.equal(VERDICT_SCHEMA.allOf[0].then.properties.reasons.minItems, 1);
  assert.equal("allOf" in VERDICT_SCHEMA_FLAT, false);
});

test("structured parser keeps known verdicts conservative and never invents acknowledgement", () => {
  const parsed = parseStructuredVerdict({ verdict: "refuted", reasons: [{ path: "src/a.ts", line: 4, defect: "breaks", trigger: "input" }, { path: "", line: 0, defect: "bad", trigger: "bad" }], confidence: 0.8, incomplete_evidence_ack: false });
  assert.ok(!("error" in parsed));
  assert.deepEqual(parsed.reasons, [{ path: "src/a.ts", line: 4, defect: "breaks", trigger: "input" }]);
  assert.equal(renderReasons(parsed.reasons), "1. src/a.ts:4 — breaks (triggered by: input)");
  const incomplete = parseStructuredVerdict({ verdict: "approved", confidence: "certain", incomplete_evidence_ack: "yes" });
  assert.ok(!("error" in incomplete));
  assert.equal(incomplete.confidence, 0);
  assert.equal(incomplete.incomplete_evidence_ack, false);
});

test("reasonless refuted verdict remains refuted with an explicit marker", () => {
  const structured = parseStructuredVerdict({ verdict: "refuted", reasons: [], confidence: 0.2, incomplete_evidence_ack: false });
  assert.ok(!("error" in structured));
  assert.equal(structured.verdict, "refuted");
  assert.equal(structured.reasonsMissing, true);
  const prose = parseVerdict("VERDICT: REFUTED");
  assert.ok(!("error" in prose));
  assert.equal(prose.verdict, "refuted");
  assert.equal(prose.reasonsMissing, true);
});

test("only a non-object or unknown verdict is a structured protocol failure", () => {
  assert.deepEqual(parseStructuredVerdict(null), { error: "Structured verdict must be an object" });
  assert.deepEqual(parseStructuredVerdict({ verdict: "maybe" }), { error: "Structured verdict has an unknown verdict" });
});
