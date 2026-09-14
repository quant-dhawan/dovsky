import { TIERS, type ArmSource, type BanditConfig, type RoutingArm, type Tier } from "@dovsky/protocol";
import type { StoredJob } from "./model.js";

export type Arm = Pick<RoutingArm, "tier" | "alpha" | "beta" | "successes" | "failures" | "pinned">;
export type Reward = 0 | 1 | null;
export type ArmChoice<A extends Arm = Arm> = { arm: A; source: ArmSource };
/** Actual dispatches for this routing key, oldest first; exclude queued jobs and promotions. */
export type RecentDispatch = Pick<StoredJob, "tier">;

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
}

function uniform(rng: () => number): number {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError("rng must return a number in [0, 1)");
  return Math.max(Number.MIN_VALUE, value); // Logarithms need an open lower endpoint.
}

/** Marsaglia–Tsang gamma draw for shape >= 1, kept in log space to avoid overflow. */
function logGamma(shape: number, rng: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / (3 * Math.sqrt(d));
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const x = Math.sqrt(-2 * Math.log(uniform(rng))) * Math.cos(2 * Math.PI * uniform(rng));
    const root = 1 + c * x;
    if (root <= 0) continue;
    const v = root ** 3;
    const u = uniform(rng);
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < x * x / 2 + d * (1 - v + Math.log(v))) {
      return Math.log(d) + 3 * Math.log(root);
    }
  }
  throw new RangeError("rng did not produce an accepted gamma draw in 10000 attempts");
}

/** Independent gamma draws; the scaled log ratio also handles subnormal positive shapes. */
export function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  positive(alpha, "alpha");
  positive(beta, "beta");
  const a = logGamma(alpha < 1 ? alpha + 1 : alpha, rng);
  const boostA = alpha < 1 ? Math.log(uniform(rng)) : 0;
  const b = logGamma(beta < 1 ? beta + 1 : beta, rng);
  const boostB = beta < 1 ? Math.log(uniform(rng)) : 0;
  const scale = Math.min(1, alpha, beta);
  const logRatio = ((a - b) * scale + boostA * (scale / alpha) - boostB * (scale / beta)) / scale;
  if (logRatio >= 0) return 1 / (1 + Math.exp(-logRatio));
  const ratio = Math.exp(logRatio);
  return ratio / (1 + ratio);
}

/**
 * Arms are the actual allowed/available set for one provider/key. No missing arm is synthesized.
 * The cap includes the proposed dispatch in the last recentWindow dispatches. Empty history has
 * no free frontier probe (1/1 must fit the cap). All frontier dispatches count, even ungraded ones.
 * A valid pin or a sole eligible frontier is mandatory, so the exploration cap cannot block it.
 * Root handles enabled=false, explicit/inherited specs and charter-fixed source attribution.
 */
export function chooseArm<A extends Arm>(
  arms: readonly A[], floor: Tier, recent: readonly RecentDispatch[], config: BanditConfig, rng: () => number,
): ArmChoice<A> {
  if (!config.enabled) throw new RangeError("Bandit disabled; use the caller's legacy routing policy");
  if (!TIERS.includes(floor)) throw new RangeError("Invalid tier floor");
  let eligible = arms.filter((arm) => TIERS.indexOf(arm.tier) >= TIERS.indexOf(floor));
  if (eligible.length === 0) throw new RangeError("No eligible routing arms at or above the floor");
  const pinned = eligible.find((arm) => arm.pinned);
  if (pinned) return { arm: pinned, source: "operator-pinned" };
  const floorOnly = eligible.length === 1 && eligible[0]?.tier === floor;
  if (!Number.isInteger(config.recentWindow) || config.recentWindow < 1
    || !Number.isFinite(config.explorationCap) || config.explorationCap < 0 || config.explorationCap > 1
    || !Number.isFinite(config.costPenalty) || config.costPenalty < 0 || config.costPenalty > 1) {
    throw new RangeError("Invalid bandit selection configuration");
  }
  const weights = TIERS.map((tier) => config.costWeights[tier]);
  weights.forEach((weight) => positive(weight, "cost weight"));
  const maxWeight = Math.max(...weights);
  const history = config.recentWindow === 1 ? [] : recent.slice(-(config.recentWindow - 1));
  const frontierFraction = (history.filter((dispatch) => dispatch.tier === "frontier").length + 1) / (history.length + 1);
  if (eligible.some((arm) => arm.tier !== "frontier") && frontierFraction > config.explorationCap) {
    eligible = eligible.filter((arm) => arm.tier !== "frontier" || arm.successes + arm.failures > 0);
  }
  let best = eligible[0] as A;
  let bestScore = -Infinity;
  for (const arm of eligible) {
    const score = sampleBeta(arm.alpha, arm.beta, rng) - config.costPenalty * (config.costWeights[arm.tier] / maxWeight);
    if (score > bestScore) { best = arm; bestScore = score; }
  }
  return { arm: best, source: floorOnly ? "ladder-floor" : "bandit" };
}

/** One contribution only. Root owns replacement/undo/replay, persistence and dispatch history. */
export function updateArm<A extends Arm>(arm: A, value: Reward, config: Pick<BanditConfig, "decay">): A {
  if (value === null) return { ...arm };
  if (value !== 0 && value !== 1) throw new RangeError("Reward must be 0, 1 or null");
  positive(config.decay, "decay");
  if (config.decay > 1) throw new RangeError("decay must not exceed 1");
  positive(arm.alpha, "alpha");
  positive(arm.beta, "beta");
  return {
    ...arm,
    alpha: 1 + config.decay * Math.max(0, arm.alpha - 1) + value,
    beta: 1 + config.decay * Math.max(0, arm.beta - 1) + (1 - value),
    successes: arm.successes + value,
    failures: arm.failures + (1 - value),
  };
}

export type RewardJob = Pick<StoredJob,
  "provider" | "tier" | "modelIdentity" | "resolvedModel" | "reportedModel" | "executionKind" | "promotionOf"
  | "role" | "state" | "failure" | "cause" | "grade" | "gradeSource" | "taskOutcome">;

/**
 * Consume persisted, listener-authorized grades only, never RPC parameters or a caller's claimed source.
 * Approved reviews reach the worker as reviewer/good; a review's own verdict is not worker evidence.
 * Promotions return null: root must resolve their original candidate and replace its effective reward.
 */
export function reward(job: RewardJob): Reward {
  if (job.role !== "work" || !["foreground", "rollout_candidate"].includes(job.executionKind) || job.promotionOf !== null
    || job.gradeSource === "agent" || job.cause === "environmental" || job.tier === null) return null;
  const resolved = job.resolvedModel?.trim().toLowerCase();
  const reported = job.reportedModel?.trim().toLowerCase();
  if (!resolved || (reported && reported !== resolved)) return null;
  if (job.modelIdentity === "reported") {
    if (!reported) return null;
  } else if (job.modelIdentity !== "configured_unverified" || job.provider !== "codex") return null;
  if (job.state === "failed") return job.failure?.code === "quality_gate" ? 0 : null;
  if (job.state !== "succeeded" || job.failure !== null
    || (job.taskOutcome != null && job.taskOutcome !== "completed")) return null;
  if (job.gradeSource !== "human" && job.gradeSource !== "reviewer") return null;
  return job.grade === "good" ? 1 : job.grade === "bad" ? 0 : null;
}
