import assert from "node:assert/strict";
import test from "node:test";
import { armSet, nextAllowedEscalation, parseRoutingKey } from "./routing.js";
import { parseCharterLadder, type CharterLadder, type Rung } from "./charter.js";
import { PROVIDERS, TIERS, type Provider, type Tier } from "@dovsky/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DovskyDatabase } from "./database.js";

test("parseRoutingKey returns null for a two-part key", () => {
  assert.equal(parseRoutingKey("codex/change"), null);
});

test("promotion requires distinct failures and successful same-provider retries", () => {
  const root = mkdtempSync(join(tmpdir(), "routing-distinct-test-"));
  const db = new DovskyDatabase(join(root, "state.db"));
  try {
    db.createRoom("room", "Synthetic routing", "test", "change");
    db.seedRoutingPolicy([{ provider: "codex", workflowId: "change", charter: null, tier: "routine" }], "fixture");
    const failed = (id: string) => {
      db.createJob({ id, roomId: "room", provider: "codex", projectId: "test", workflowId: "change", prompt: "fixture", tier: "routine" }, `${id}-turn`);
      db.setReportedModel(id, "gpt-5.6-terra");
      db.db.prepare("UPDATE jobs SET state='failed',cause='capability' WHERE id=?").run(id);
    };
    const retry = (id: string, source: string, state = "succeeded", provider: "codex" | "claude" = "codex") => {
      db.createJob({ id, roomId: "room", provider, projectId: "test", workflowId: "change", prompt: "fixture", tier: "hard", escalatedFrom: source }, `${id}-turn`);
      db.setReportedModel(id, provider === "codex" ? "gpt-5.6-terra" : "opus");
      db.db.prepare("UPDATE jobs SET state=? WHERE id=?").run(state, id);
      db.gradeJob(id, "good", "Synthetic test grade");
    };
    failed("first");
    retry("retry-one", "first");
    retry("retry-two", "first");
    assert.equal(db.routingTier("codex", "change", null), "routine", "one failure cannot count twice");
    failed("second");
    retry("failed-retry", "second", "failed");
    retry("other-provider", "second", "succeeded", "claude");
    assert.equal(db.routingTier("codex", "change", null), "routine");
    retry("real-fix", "second");
    assert.equal(db.routingTier("codex", "change", null), "hard");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

function ladder(written: string, fixed?: boolean, start?: string): CharterLadder {
  const text = `---\nbus:\n  allowed: [${written}]\n${fixed === undefined ? "" : `  fixed: ${fixed}\n`}${start ? `  start: ${start}\n` : ""}---\nbody\n`;
  const parsed = parseCharterLadder(text, "R2-fixture.md");
  assert.ok(parsed);
  return parsed;
}

test("Cassandra, Hestia and explicitly multi-rung charters keep their approved arm sets", () => {
  const cases: Array<[string, string, Provider, Tier[]]> = [
    ["Cassandra", "claude/hard", "claude", ["hard", "frontier"]],
    ["Cassandra", "claude/hard", "codex", []],
    ["Hestia", "codex/quick, claude/routine", "codex", ["quick", "routine", "hard"]],
    ["Hestia", "codex/quick, claude/routine", "claude", ["routine", "hard", "frontier"]],
    ["Argus", "codex/routine, codex/hard, claude/hard", "codex", ["routine", "hard"]],
    ["Argus", "codex/routine, codex/hard, claude/hard", "claude", ["hard", "frontier"]],
    ["Daedalus", "codex/quick, codex/hard, claude/routine, claude/frontier", "codex", ["quick", "hard"]],
    ["Daedalus", "codex/quick, codex/hard, claude/routine, claude/frontier", "claude", ["routine", "frontier"]],
  ];
  for (const [name, written, provider, expected] of cases) {
    assert.deepEqual(armSet(ladder(written), provider, { widenSingleRungLadders: true }), expected, `${name}/${provider}`);
  }
});

test("single rungs widen at most two tiers, bounded by frontier, unless fixed or widening disabled", () => {
  const widened: Tier[][] = [["quick", "routine", "hard"], ["routine", "hard", "frontier"], ["hard", "frontier"], ["frontier"]];
  for (const provider of PROVIDERS) for (const [index, tier] of TIERS.entries()) {
    for (const fixed of [undefined, false, true]) for (const widenSingleRungLadders of [false, true]) {
      const parsed = ladder(`${provider}/${tier}`, fixed);
      assert.deepEqual(armSet(parsed, provider, { widenSingleRungLadders }),
        !fixed && widenSingleRungLadders ? widened[index] : [tier]);
    }
  }
});

test("no ladder allows all tiers; startIndex does not replace the first provider floor", () => {
  for (const provider of PROVIDERS) for (const widenSingleRungLadders of [true, false]) {
    assert.deepEqual(armSet(null, provider, { widenSingleRungLadders }), [...TIERS]);
  }
  const parsed = ladder("codex/quick, claude/routine, codex/hard", false, "codex/hard");
  assert.equal(parsed.startIndex, 2);
  assert.deepEqual(armSet(parsed, "codex", { widenSingleRungLadders: true }), ["quick", "hard"]);
  assert.deepEqual(armSet(parsed, "claude", { widenSingleRungLadders: true }), ["routine", "hard", "frontier"]);
});

test("all multi-rung subsets stay exact even with gaps or interleaved providers", () => {
  for (let mask = 1; mask < 16; mask += 1) {
    const tiers = TIERS.filter((_, index) => mask & (1 << index));
    if (tiers.length < 2) continue;
    for (const provider of PROVIDERS) {
      const other = PROVIDERS.find((entry) => entry !== provider)!;
      const written = tiers.map((tier) => `${provider}/${tier}`).join(`, ${other}/routine, `);
      // Avoid duplicate other-provider rungs while retaining interleaving.
      const parsed = ladder([...new Set(written.split(", "))].join(", "));
      assert.deepEqual(armSet(parsed, provider, { widenSingleRungLadders: true }), tiers);
    }
  }
});

test("escalation first finds a strictly higher allowed tier, then the next provider, without wrapping", () => {
  const allowed: Rung[] = [
    { provider: "codex", tier: "quick" }, { provider: "claude", tier: "routine" },
    { provider: "codex", tier: "frontier" }, { provider: "codex", tier: "hard" }, { provider: "claude", tier: "hard" },
  ];
  const cases: Array<[Provider, Tier, Rung | null]> = [
    ["codex", "quick", { provider: "codex", tier: "hard" }],
    ["codex", "routine", { provider: "codex", tier: "hard" }],
    ["codex", "hard", { provider: "codex", tier: "frontier" }],
    ["codex", "frontier", { provider: "claude", tier: "routine" }],
    ["claude", "quick", { provider: "claude", tier: "routine" }],
    ["claude", "routine", { provider: "claude", tier: "hard" }],
    ["claude", "hard", null], ["claude", "frontier", null],
  ];
  const before = structuredClone(allowed);
  allowed.forEach(Object.freeze);
  Object.freeze(allowed);
  for (const [provider, tier, expected] of cases) assert.deepEqual(nextAllowedEscalation({ provider, tier }, allowed), expected);
  assert.deepEqual(allowed, before);
  assert.equal(nextAllowedEscalation({ provider: "codex", tier: "quick" }, []), null);
  assert.equal(nextAllowedEscalation({ provider: "codex", tier: "quick" }, [{ provider: "claude", tier: "hard" }]), null);
});

test("arm-set and escalation outputs are detached and no helper mutates a charter", () => {
  const parsed = ladder("claude/quick, codex/routine", false, "codex/routine");
  const before = structuredClone(parsed);
  parsed.rungs.forEach(Object.freeze);
  Object.freeze(parsed.rungs);
  Object.freeze(parsed);
  const tiers = armSet(parsed, "claude", { widenSingleRungLadders: true });
  tiers.reverse();
  const next = nextAllowedEscalation({ provider: "claude", tier: "frontier" }, parsed.rungs);
  assert.deepEqual(next, { provider: "codex", tier: "routine" });
  assert.notEqual(next, parsed.rungs[1]);
  assert.deepEqual(parsed, before);
});
