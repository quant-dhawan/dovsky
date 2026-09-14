import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalIdentity } from "@dovsky/protocol";
import type { DeltaArtifact, TreeEntry } from "./job-delta.js";
import { buildProvisionalResult, writeProvisionalResultArtifact } from "./provisional.js";

const identity = (fingerprint = "1".repeat(64), contentHash = "2".repeat(64)): CanonicalIdentity => ({ fingerprint, contentHash });
const entry = (path: string, hash = "3".repeat(64)): TreeEntry => ({ path, type: "file", mode: 0o644, size: 4, hash });

function delta(entries: readonly { path: string; before: TreeEntry | null; after: TreeEntry | null }[], candidate = identity()): DeltaArtifact {
  return {
    baseline: { directory: "/never-read/baseline", manifest: { version: 1, commit: "a".repeat(40), identity: candidate, entries: [] } },
    final: { directory: "/never-read/final", manifest: { version: 1, commit: "b".repeat(40), identity: candidate, entries: [] } },
    entries: [...entries],
  };
}

test("builds exact deterministic provisional bytes and hash without reading snapshot directories", () => {
  const change = entry("src/main.ts");
  const input = { providerResult: "provider complete", delta: delta([{ path: change.path, before: null, after: change }]) };
  const first = buildProvisionalResult(input), second = buildProvisionalResult(input);
  const expected = `{"version":1,"candidate":{"fingerprint":"${"1".repeat(64)}","contentHash":"${"2".repeat(64)}"},"result":{"text":"provider complete","truncated":false},"changes":{"total":1,"truncated":false,"entries":[{"path":"src/main.ts","status":"added","type":"file","mode":420,"hash":"${"3".repeat(64)}","size":4}]}}`;
  assert.deepEqual(first.bytes, Buffer.from(expected));
  assert.deepEqual(second.bytes, first.bytes);
  assert.equal(first.sha256, "caf3ad651c0d7856a027833a815380bc65f8945e8974d2f280e54d26a13fab2b");
  assert.deepEqual(first.candidate, identity());
  assert.deepEqual(first.summary, { resultBytes: 17, resultTruncated: false, changedEntries: 1, changedEntriesTruncated: false, serializedBytes: Buffer.byteLength(expected) });
});

test("strips controls and truncates provider output on a UTF-8 boundary", () => {
  const built = buildProvisionalResult({ providerResult: "\x1b[31m" + "é".repeat(20_000) + "\x01", delta: delta([]) });
  const parsed = JSON.parse(built.bytes.toString()) as { result: { text: string; truncated: boolean } };
  assert.equal(parsed.result.truncated, true);
  assert.ok(Buffer.byteLength(parsed.result.text) <= 32 * 1024);
  assert.ok(!/[\x00-\x1f\x7f]/.test(parsed.result.text));
  assert.ok(!parsed.result.text.includes("�"));
});

test("bounds changed metadata by entry count and serialized response size", () => {
  const changes = Array.from({ length: 2_050 }, (_, index) => {
    const after = entry(`src/${String(index).padStart(4, "0")}.ts`, index.toString(16).padStart(64, "0"));
    return { path: after.path, before: null, after };
  });
  const built = buildProvisionalResult({ providerResult: "x".repeat(40_000), delta: delta(changes) });
  const parsed = JSON.parse(built.bytes.toString()) as { changes: { total: number; truncated: boolean; entries: unknown[] }; result: { truncated: boolean } };
  assert.equal(parsed.result.truncated, true);
  assert.equal(parsed.changes.total, 2_050);
  assert.equal(parsed.changes.truncated, true);
  assert.ok(parsed.changes.entries.length <= 2_048);
  assert.ok(built.bytes.length <= 256 * 1024);
});

test("serializes metadata only and remains immutable after source mutation", () => {
  const after = Object.assign(entry("src/safe.ts"), { body: "TOP_SECRET_BODY", blob: "TOP_SECRET_BLOB", patch: "TOP_SECRET_PATCH" });
  const source = delta([{ path: after.path, before: null, after }]);
  const built = buildProvisionalResult({ providerResult: "done", delta: source });
  after.path = "src/mutated.ts";
  after.hash = "f".repeat(64);
  source.final.manifest.identity.contentHash = "e".repeat(64);
  const text = built.bytes.toString();
  assert.match(text, /src\/safe\.ts/);
  assert.ok(!text.includes("TOP_SECRET"));
  assert.ok(!text.includes("mutated"));
  assert.equal(built.candidate.contentHash, "2".repeat(64));
});

test("refuses unsafe changed paths", () => {
  const after = entry("../outside");
  assert.throws(() => buildProvisionalResult({ providerResult: "done", delta: delta([{ path: after.path, before: null, after }]) }), /unsafe changed path/i);
});

test("refuses coercible or mutable non-string snapshot identities", () => {
  const malformed = identity() as unknown as { fingerprint: unknown; contentHash: unknown };
  malformed.fingerprint = ["1".repeat(64)];
  malformed.contentHash = { toString: () => "2".repeat(64) };
  assert.throws(() => buildProvisionalResult({ providerResult: "done", delta: delta([], malformed as never) }), /identity is invalid/i);
});

test("writes a private artifact exclusively", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dovsky-provisional-"));
  t.after(() => { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); });
  const directory = join(root, "artifacts");
  mkdirSync(directory, { mode: 0o700 });
  const built = buildProvisionalResult({ providerResult: "done", delta: delta([]) });
  const path = writeProvisionalResultArtifact(directory, built);
  assert.equal(readFileSync(path).compare(built.bytes), 0);
  assert.equal(lstatSync(path).mode & 0o777, 0o400);
  assert.throws(() => writeProvisionalResultArtifact(directory, built), /EEXIST/);
});
