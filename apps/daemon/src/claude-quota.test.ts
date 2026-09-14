import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { parseClaudeRateLimitLine, readClaudeQuota } from "./claude-quota.js";
import { quotaCurrent } from "./quota-state.js";
import { DovskyDatabase } from "./database.js";

// Permission-free SDK fixture from the approved claude-rate-event-source memo.
const receivedAt = "2025-02-01T12:00:00.000Z";
const info = { status: "allowed_warning", resetsAt: 1738425600, rateLimitType: "five_hour", utilization: 0.85 };
const event = (changes: Record<string, unknown> = {}) => JSON.stringify({
  type: "rate_limit_event", rate_limit_info: { ...info, ...changes },
  uuid: "00000000-0000-4000-8000-000000000001", session_id: "fixture-session",
});

test("SDK fractions become measured percentages with fixed window duration and receipt time", () => {
  assert.deepEqual(parseClaudeRateLimitLine(event(), receivedAt), {
    windowId: "five_hour", usedPercent: 85, windowMinutes: 300,
    resetsAt: "2025-02-01T16:00:00.000Z", recordedAt: receivedAt, source: "claude:rate_limit_event",
  });
  for (const status of ["allowed", "allowed_warning", "rejected"]) {
    for (const utilization of [0, 0.01, 1]) {
      assert.equal(parseClaudeRateLimitLine(event({ status, utilization }), receivedAt)?.usedPercent, utilization * 100);
    }
    assert.equal(parseClaudeRateLimitLine(event({ status, utilization: undefined }), receivedAt), null);
  }
  for (const rateLimitType of ["seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"]) {
    const reading = parseClaudeRateLimitLine(event({ rateLimitType }), receivedAt)!;
    assert.equal(reading.windowId, rateLimitType);
    assert.equal(reading.windowMinutes, 10080);
  }
});

test("expired resets and invalid receipt/reset values are unavailable without a wall clock", () => {
  for (const resetsAt of [undefined, null, 0, -1, 1.5, "1738425600", NaN, Infinity, 8640000000001,
    Date.parse(receivedAt) / 1000, Date.parse(receivedAt) / 1000 - 1]) {
    assert.equal(parseClaudeRateLimitLine(event({ resetsAt }), receivedAt), null, String(resetsAt));
  }
  for (const receipt of ["", "not a time", "x".repeat(1000)]) assert.equal(parseClaudeRateLimitLine(event(), receipt), null);
  const reading = parseClaudeRateLimitLine(event(), receivedAt)!;
  assert.equal(quotaCurrent(reading, "2025-02-01T11:59:59.999Z"), false, "a future receipt is not current");
  assert.equal(quotaCurrent(reading, "2025-02-01T15:59:59.999Z"), true);
  assert.equal(quotaCurrent(reading, "2025-02-01T16:00:00.000Z"), false);
  const distantReset = parseClaudeRateLimitLine(event({ resetsAt: Date.parse("2025-02-10T00:00:00Z") / 1000 }), receivedAt)!;
  assert.equal(quotaCurrent(distantReset, "2025-02-01T17:00:00.000Z"), false, "duration is not inferred from reset");
});

test("incomplete, percentage-valued, unknown and malformed event payloads are unavailable", () => {
  for (const changes of [
    ...[undefined, null, "0.85", -0.1, 1.01, 85, 100, NaN, Infinity].map(utilization => ({ utilization })),
    ...[undefined, null, "unknown", "ALLOWED", 0].map(status => ({ status })),
    ...[undefined, null, "overage", "seven_day_future", "toString", "__proto__"].map(rateLimitType => ({ rateLimitType })),
  ]) assert.equal(parseClaudeRateLimitLine(event(changes), receivedAt), null, JSON.stringify(changes));
  for (const line of ["", "{", "null", "[]", "true", event() + "\n" + event(),
    JSON.stringify({ type: "other", rate_limit_info: info }), JSON.stringify({ type: "rate_limit_event", rate_limit_info: [] }),
    JSON.stringify({ type: "rate_limit_event", rate_limit_info: null }), JSON.stringify({ type: "rate_limit_event", ...info }),
    JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resets_at: info.resetsAt, rate_limit_type: "five_hour", utilization: 0.5 } }),
    JSON.stringify({ nested: JSON.parse(event()) }), event({ utilization: undefined, overageStatus: "allowed", surpassedThreshold: 0.8 }),
  ]) assert.equal(parseClaudeRateLimitLine(line, receivedAt), null);
  assert.equal(parseClaudeRateLimitLine(event().padEnd(32768), receivedAt)?.usedPercent, 85);
  assert.equal(parseClaudeRateLimitLine(event().padEnd(32769), receivedAt), null);
  assert.equal(parseClaudeRateLimitLine(event({ ignored: "é".repeat(17000) }), receivedAt), null, "bound is bytes");
});

test("parsed windows persist, preserve chronology/zero, and expire without a running stream", t => {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-s2-quota-"));
  const db = new DovskyDatabase(resolve(root, "quota.db"));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(db.recordQuota("claude", parseClaudeRateLimitLine(event(), receivedAt), receivedAt), true);
  assert.equal(db.recordQuota("claude", parseClaudeRateLimitLine(event({ utilization: 0.1 }), "2025-02-01T11:59:00Z"), receivedAt), false);
  const later = "2025-02-01T12:01:00.000Z";
  assert.equal(db.recordQuota("claude", parseClaudeRateLimitLine(event({ utilization: 0 }), later), later), true);
  assert.equal(db.getQuota("claude", receivedAt), null);
  const reopened = new DovskyDatabase(db.path);
  try {
    assert.equal(reopened.getQuota("claude", later)?.usedPercent, 0);
    assert.equal(reopened.getQuota("claude", "2025-02-01T16:00:00.000Z"), null);
  } finally { reopened.close(); }
});

test("readClaudeQuota returns null for an empty claude home", () => {
  const home = mkdtempSync(resolve(tmpdir(), "dovsky-claude-home-"));
  try {
    assert.equal(readClaudeQuota(home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readClaudeQuota returns null when no claude home exists at all", () => {
  assert.equal(readClaudeQuota(resolve(tmpdir(), "dovsky-claude-home-missing")), null);
});
