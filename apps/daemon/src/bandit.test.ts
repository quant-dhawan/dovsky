import assert from "node:assert/strict";
import test from "node:test";
import {
  ARM_SOURCES, EXECUTION_KINDS, FAILURE_CODES, JOB_STATES, TIERS,
  type BanditConfig, type FailureInfo, type Grade, type GradeSource, type RoutingArm,
} from "@dovsky/protocol";
import { chooseArm, reward, sampleBeta, updateArm, type Arm, type Reward, type RewardJob } from "./bandit.js";

function seeded(seed: number): () => number {
  return () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 2 ** 32;
  };
}

const config: BanditConfig = {
  enabled: true, costPenalty: 0.15, costWeights: { quick: 1, routine: 2, hard: 5, frontier: 12 },
  explorationCap: 0.15, recentWindow: 100, decay: 0.995, widenSingleRungLadders: true,
};
const arm = (tier: Arm["tier"], extra: Partial<Arm> = {}): Arm => ({
  tier, alpha: 1, beta: 1, successes: 0, failures: 0, pinned: false, ...extra,
});

test("Beta sampling is deterministic and uses fresh injected randomness", () => {
  const draws = (seed: number) => {
    const rng = seeded(seed);
    return Array.from({ length: 100 }, () => sampleBeta(2, 5, rng));
  };
  assert.deepEqual(draws(42), draws(42));
  assert.notDeepEqual(draws(42), draws(43));
  assert.ok(new Set(draws(42)).size > 90);
});

test("fixed-seed Beta means and uniform second moment match the analytical distribution", () => {
  for (const [alpha, beta, expectedMean] of [[1, 1, 0.5], [2, 5, 2 / 7], [0.2, 0.8, 0.2], [50, 1, 50 / 51]]) {
    const rng = seeded(12345);
    let sum = 0;
    let squares = 0;
    for (let index = 0; index < 20_000; index += 1) {
      const sample = sampleBeta(alpha!, beta!, rng);
      assert.ok(sample >= 0 && sample <= 1);
      sum += sample;
      squares += sample * sample;
    }
    assert.ok(Math.abs(sum / 20_000 - expectedMean!) < 0.01, `${alpha},${beta}: computed mean ${sum / 20_000}`);
    if (alpha === 1 && beta === 1) assert.ok(Math.abs(squares / 20_000 - 1 / 3) < 0.01);
  }
});

test("Beta accepts extreme positive finite shapes without NaN or overflow", () => {
  const extremes = [Number.MIN_VALUE, 1e-300, 0.01, 1, 1e10, 1e300, Number.MAX_VALUE];
  const rng = seeded(73);
  for (const alpha of extremes) for (const beta of extremes) {
    for (let n = 0; n < 20; n += 1) {
      const result = sampleBeta(alpha, beta, rng);
      assert.ok(Number.isFinite(result) && result >= 0 && result <= 1, `${alpha},${beta}: ${result}`);
    }
  }
  assert.equal(sampleBeta(Number.MAX_VALUE, Number.MAX_VALUE, rng), 0.5);
  assert.ok(sampleBeta(Number.MIN_VALUE, Number.MAX_VALUE, rng) < 1e-10);
  assert.ok(sampleBeta(Number.MAX_VALUE, Number.MIN_VALUE, rng) > 1 - 1e-10);
});

test("Beta rejects invalid parameters and invalid or nonprogressing RNGs", () => {
  const unused = () => { throw new Error("rng must not be called"); };
  for (const value of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => sampleBeta(value, 1, unused), /alpha must be positive and finite/);
    assert.throws(() => sampleBeta(1, value, unused), /beta must be positive and finite/);
  }
  for (const value of [-0.1, 1, NaN, Infinity, -Infinity]) {
    assert.throws(() => sampleBeta(1, 1, () => value), /rng must return/);
  }
  let draws = 0;
  const zeroThenValid = () => draws++ === 0 ? 0 : 0.5;
  assert.ok(Number.isFinite(sampleBeta(1, 1, zeroThenValid)), "zero endpoint is safe");
  const rejecting = () => ++draws % 2 === 0 ? 0.5 : Number.MIN_VALUE;
  draws = 0;
  assert.throws(() => sampleBeta(1, 1, rejecting), /10000 attempts/);
});

test("selection exhausts allowed-set and floor combinations without creating an arm", () => {
  for (let mask = 0; mask < 16; mask += 1) for (const floor of TIERS) {
    const arms = TIERS.filter((_, index) => mask & (1 << index)).map((tier) => arm(tier));
    const eligible = arms.filter((entry) => TIERS.indexOf(entry.tier) >= TIERS.indexOf(floor));
    if (eligible.length === 0) {
      assert.throws(() => chooseArm(arms, floor, [], config, seeded(4)), /No eligible routing arms/);
    } else {
      const chosen = chooseArm(arms, floor, [], config, seeded(4));
      assert.ok(eligible.includes(chosen.arm));
      assert.ok(ARM_SOURCES.includes(chosen.source));
    }
  }
});

test("eligible pins win over cost and exploration; a below-floor pin never wins", () => {
  const pinned = arm("frontier", { pinned: true });
  assert.deepEqual(chooseArm([arm("quick"), pinned], "quick", [], config, () => { throw new Error("sampled a pin"); }),
    { arm: pinned, source: "operator-pinned" });
  const hard = arm("hard");
  assert.deepEqual(chooseArm([arm("quick", { pinned: true }), hard], "hard", [], config, seeded(4)),
    { arm: hard, source: "ladder-floor" });
  assert.notEqual(chooseArm([arm("routine", { alpha: 3 })], "quick", [], config, seeded(4)).source, "operator-pinned",
    "a seeded prior is not an operator pin");
});

test("cost uses the maximum configured weight, including unavailable tiers, and is scale invariant", () => {
  const arms = [arm("quick"), arm("hard")];
  assert.equal(chooseArm([...arms].reverse(), "quick", [], config, () => 0.5).arm.tier, "quick");
  const weightScales = [1e-200, 0.01, 1, 10, 1e200];
  for (let seed = 1; seed <= 50; seed += 1) {
    const expected = chooseArm(arms, "quick", [], config, seeded(seed)).arm.tier;
    for (const scale of weightScales) {
      const scaled = { ...config, costWeights: { quick: scale, routine: 2 * scale, hard: 5 * scale, frontier: 12 * scale } };
      assert.equal(chooseArm(arms, "quick", [], scaled, seeded(seed)).arm.tier, expected);
    }
  }
  // These fixed draws put hard just above quick only with normalization by all four configured tiers.
  let distinguishes = false;
  for (let seed = 1; seed <= 100; seed += 1) {
    const full = chooseArm(arms, "quick", [], config, seeded(seed)).arm.tier;
    const limited = chooseArm(arms, "quick", [], { ...config, costWeights: { ...config.costWeights, frontier: 5 } }, seeded(seed)).arm.tier;
    if (full !== limited) distinguishes = true;
  }
  assert.ok(distinguishes);
});

test("frontier exploration cap counts projected actual dispatches, including those with no reward", () => {
  const quick = arm("quick", { beta: 1e12 });
  const frontier = arm("frontier", { alpha: 1e12 });
  const choose = (tiers: Array<Arm["tier"] | null>, overrides: Partial<BanditConfig> = {}) =>
    chooseArm([quick, frontier], "quick", tiers.map((tier) => ({ tier })), { ...config, ...overrides }, seeded(19)).arm.tier;
  assert.equal(choose([]), "quick", "empty history grants no free probe");
  assert.equal(chooseArm([quick, frontier], "quick", [], config, seeded(19)).source, "bandit",
    "the exploration cap does not invent a ladder-floor attribution");
  assert.equal(choose(Array(5).fill("quick")), "quick", "1/6 exceeds 0.15");
  assert.equal(choose(Array(6).fill("quick")), "frontier", "1/7 fits 0.15");
  assert.equal(choose(["frontier", ...Array(8).fill("quick")]), "quick", "2/10 exceeds 0.15");
  assert.equal(choose(["frontier", ...Array(12).fill("quick")]), "frontier", "2/14 fits 0.15");
  assert.equal(choose(Array(6).fill("quick"), { explorationCap: 0 }), "quick");
  assert.equal(choose([], { explorationCap: 1 }), "frontier");
  assert.equal(choose(Array(100).fill("quick"), { recentWindow: 1 }), "quick");
  assert.equal(choose(["frontier", ...Array(9).fill("quick")], { recentWindow: 10, explorationCap: 0.1 }), "frontier",
    "oldest dispatch leaves the projected window; equality is allowed");
  assert.equal(choose([...Array(9).fill("quick"), "frontier"], { recentWindow: 10, explorationCap: 0.1 }), "quick");
  const only = chooseArm([frontier], "frontier", [], config, seeded(19));
  assert.equal(only.arm, frontier, "a required frontier floor cannot be blocked");
  assert.equal(only.source, "ladder-floor");
  for (const counts of [{ successes: 1 }, { failures: 1 }]) {
    assert.equal(chooseArm([quick, { ...frontier, ...counts }], "quick", [], config, seeded(19)).arm.tier, "frontier",
      "the cap only limits an unexplored frontier");
  }
});

test("selection and updates do not mutate inputs and preserve full RoutingArm metadata", () => {
  const full: RoutingArm = Object.freeze({ ...arm("hard"), key: "codex/change/-", provider: "codex", workflowId: "change",
    charter: null, updatedAt: "fixture", lastUsedAt: null });
  const arms = Object.freeze([full]);
  const recent = Object.freeze([Object.freeze({ tier: "quick" as const })]);
  const frozenConfig = Object.freeze({ ...config, costWeights: Object.freeze({ ...config.costWeights }) });
  const before = structuredClone({ arms, recent, config: frozenConfig });
  assert.equal(chooseArm(arms, "hard", recent, frozenConfig, seeded(3)).arm, full);
  const updated: RoutingArm = updateArm(full, 1, frozenConfig);
  assert.equal(updated.key, full.key);
  assert.equal(updated.lastUsedAt, null);
  assert.notEqual(updated, full);
  assert.deepEqual({ arms, recent, config: frozenConfig }, before);
});

test("updates decay toward Beta(1,1), add exactly one count, and leave null rewards untouched", () => {
  const prior = arm("hard", { alpha: 5, beta: 3, successes: 4, failures: 2 });
  for (const [value, alpha, beta, successes, failures] of [[1, 4, 2, 5, 2], [0, 3, 3, 4, 3]] as const) {
    assert.deepEqual(updateArm(prior, value, { decay: 0.5 }), { ...prior, alpha, beta, successes, failures });
  }
  assert.deepEqual(updateArm(prior, null, { decay: 0.5 }), prior);
  assert.deepEqual(updateArm(prior, 1, { decay: 1 }), { ...prior, alpha: 6, successes: 5 });
  assert.deepEqual(updateArm(arm("quick", { alpha: 0.1, beta: 0.2 }), 0, config), arm("quick", { beta: 2, failures: 1 }));
  let repeated = prior;
  for (let n = 0; n < 10_000; n += 1) repeated = updateArm(repeated, 0, config);
  assert.ok(repeated.alpha >= 1 && repeated.beta >= 1);
  assert.equal(repeated.successes, 4);
  assert.equal(repeated.failures, 10_002);
  for (const decay of [0, -1, NaN, Infinity, 1.1]) assert.throws(() => updateArm(prior, 1, { decay }), RangeError);
});

const job: RewardJob = {
  provider: "codex", tier: "routine", modelIdentity: "configured_unverified", resolvedModel: "fixture-model",
  reportedModel: null, executionKind: "foreground", promotionOf: null, role: "work", state: "succeeded",
  failure: null, cause: null, grade: "good", gradeSource: "human",
};
const failure = (code: FailureInfo["code"]): FailureInfo => ({
  code, summary: "fixture", retryable: false, resumable: false, exitCode: 1, signal: null, occurredAt: "fixture",
});

test("reward truth table requires an applicable persisted human/reviewer grade on succeeded work", () => {
  const rows: Array<[GradeSource | null, Grade | null, Reward]> = [
    ["human", "good", 1], ["human", "bad", 0], ["human", null, null],
    ["reviewer", "good", 1], ["reviewer", "bad", 0], ["reviewer", null, null],
    ["agent", "good", null], ["agent", "bad", null], ["agent", null, null],
    [null, "good", null], [null, "bad", null], [null, null, null],
  ];
  for (const [gradeSource, grade, expected] of rows) {
    assert.equal(reward(Object.freeze({ ...job, gradeSource, grade })), expected, `${gradeSource}/${grade}`);
  }
  for (const armSource of ARM_SOURCES) {
    assert.equal(reward({ ...job, ...{ armSource } }), 1, `${armSource} execution still learns`);
  }
});

test("every execution failure is neutral except a capability quality gate; advice cannot grade failures", () => {
  for (const code of FAILURE_CODES) for (const grade of ["good", "bad", null] as const) {
    for (const gradeSource of ["human", "reviewer", "agent", null] as const) {
      assert.equal(reward({ ...job, state: "failed", failure: failure(code), grade, gradeSource }),
        code === "quality_gate" && gradeSource !== "agent" ? 0 : null, `${code}/${gradeSource}/${grade}`);
    }
  }
  for (const state of JOB_STATES.filter((state) => state !== "succeeded" && state !== "failed")) {
    assert.equal(reward({ ...job, state }), null, state);
    assert.equal(reward({ ...job, state, failure: failure("quality_gate"), grade: "bad" }), null, state);
  }
  assert.equal(reward({ ...job, state: "failed", cause: "capability" }), null, "cause alone is not execution evidence");
  assert.equal(reward({ ...job, state: "failed", failure: failure("quality_gate"), taskOutcome: "blocked" }), 0);
  for (const code of FAILURE_CODES) {
    assert.equal(reward({ ...job, failure: failure(code), grade: "bad" }), null, "inconsistent success is not a sample");
  }
});

test("identity truth table includes configured-unverified Codex and excludes unknown/mismatched identity", () => {
  const rows: Array<[string, Partial<RewardJob>, boolean]> = [
    ["configured Codex without a report", {}, true],
    ["reported Codex", { modelIdentity: "reported", reportedModel: "fixture-model" }, true],
    ["reported Claude", { provider: "claude", modelIdentity: "reported", reportedModel: "fixture-model" }, true],
    ["normalized report", { modelIdentity: "reported", reportedModel: " Fixture-Model " }, true],
    ["Claude needs a report", { provider: "claude" }, false],
    ["legacy unknown", { modelIdentity: "legacy_unknown" }, false],
    ["flagged mismatch", { modelIdentity: "mismatch", reportedModel: "fixture-model" }, false],
    ["known report mismatch", { reportedModel: "other" }, false],
    ["reported mismatch", { modelIdentity: "reported", reportedModel: "other" }, false],
    ["missing reported identity", { modelIdentity: "reported" }, false],
    ["empty report", { modelIdentity: "reported", reportedModel: " " }, false],
    ["missing configured model", { resolvedModel: null }, false],
    ["empty configured model", { resolvedModel: " " }, false],
    ["missing resolved tier", { tier: null }, false],
  ];
  for (const [name, changes, usable] of rows) {
    assert.equal(reward({ ...job, ...changes }), usable ? 1 : null, `${name}: win`);
    assert.equal(reward({ ...job, state: "failed", failure: failure("quality_gate"), ...changes }), usable ? 0 : null, `${name}: loss`);
  }
});

test("reviews, promotions, environmental outcomes and incomplete work never supply worker rewards", () => {
  for (const executionKind of EXECUTION_KINDS) {
    assert.equal(reward({ ...job, executionKind }), ["foreground", "rollout_candidate"].includes(executionKind) ? 1 : null, executionKind);
  }
  const exclusions: Array<Partial<RewardJob>> = [
    { role: "review" }, { promotionOf: "candidate" }, { cause: "environmental" },
    { taskOutcome: "blocked" }, { taskOutcome: "checkpointed" }, { taskOutcome: "unknown" }, { taskOutcome: "cancelled" },
  ];
  for (const change of exclusions) for (const grade of ["good", "bad"] as const) {
    assert.equal(reward({ ...job, grade, ...change }), null, JSON.stringify(change));
  }
  assert.equal(reward({ ...job, taskOutcome: "completed" }), 1);
  assert.equal(reward({ ...job, role: "review", state: "failed", failure: failure("quality_gate"), grade: "bad" }), null);
});
