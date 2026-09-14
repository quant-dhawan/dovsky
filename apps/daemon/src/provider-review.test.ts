import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readStructuredLastMessage, reviewArgv, structuredProviderEvent } from "./provider-review.js";

test("review argv sends Claude inline schema JSON and preserves Codex schema path and final stdin marker", t => {
  const root = mkdtempSync(join(tmpdir(), "dovsky-r1-schema-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "schema.json"), schema = { type: "object", properties: { verdict: { type: "string" } } };
  writeFileSync(path, JSON.stringify(schema));
  const argv = reviewArgv("claude", ["claude", "--output-format", "text", "--json-schema", "old"], path, "/run/last.json");
  assert.deepEqual(argv, ["claude", "--json-schema", JSON.stringify(schema), "--output-format", "json"]);
  assert.deepEqual(JSON.parse(argv[argv.indexOf("--json-schema") + 1]!), schema);
  assert.deepEqual(reviewArgv("codex", ["codex", "exec", "-"], "/run/schema.json", "/run/last.json"), ["codex", "exec", "--output-schema", "/run/schema.json", "-o", "/run/last.json", "-"]);
  assert.throws(() => reviewArgv("codex", ["codex", "exec"], "/run/schema.json", "/run/last.json"), /must end/);
});

test("provider event extraction uses only documented result shapes", () => {
  assert.deepEqual(structuredProviderEvent("claude", { type: "result", structured_output: { verdict: "approved" } }), { found: true, value: { verdict: "approved" } });
  assert.deepEqual(structuredProviderEvent("claude", { type: "result", result: "{not json" }), { found: true, error: "Provider structured verdict was not JSON" });
  assert.deepEqual(structuredProviderEvent("codex", { type: "item.completed", item: { type: "agent_message", text: '{"verdict":"refuted"}' } }), { found: true, value: { verdict: "refuted" } });
  assert.deepEqual(structuredProviderEvent("codex", { type: "item.completed", item: { type: "tool" } }), { found: false });
});

test("last-message fallback is bounded and refuses a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "dovsky-r1-provider-review-"));
  const valid = join(root, "last.json"); writeFileSync(valid, '{"verdict":"approved"}');
  assert.deepEqual(readStructuredLastMessage(valid), { found: true, value: { verdict: "approved" } });
  const link = join(root, "link.json"); symlinkSync(valid, link);
  const refused = readStructuredLastMessage(link);
  assert.equal(refused.found, true); if (refused.found) assert.ok("error" in refused);
});
