import { TIERS, type BanditConfig, type FailureCause, type FailureInfo, type Grade, type JobState, type Provider, type Tier } from "@dovsky/protocol";
import type { CharterLadder, Rung } from "./charter.js";

/** Tier a key runs at until evidence or the operator moves it. */
export const DEFAULT_TIER: Tier = "routine";
export const SEED_REASON = "seeded from the SKILL.md dispatch table (2026-09-02)";
/** Initial dispatch-by-charter table, one row per provider/charter pair. */
export const SEED_CHARTER_TIERS: ReadonlyArray<readonly [Provider, string, Tier]> = [
  ["codex", "Argus", "routine"],
  ["codex", "Daedalus", "routine"],
  ["claude", "Hestia", "quick"],
  ["claude", "Chiron", "hard"],
  ["claude", "Themis", "hard"],
  ["claude", "Cassandra", "hard"],
  ["claude", "Mentor", "frontier"],
  ["claude", "sisyphus", "frontier"],
];

/** Promote one tier after this many capability failures were each fixed by a graded-good retry one tier up. */
export const PROMOTE_PAIRS = 2;
/** No demotion before a key has this many finished jobs. */
export const DEMOTE_MIN_OBSERVATIONS = 20;
/** Demote one tier only after this many graded-good jobs at the lower tier since the last policy change, with none bad. */
export const DEMOTE_GOOD_PROBES = 3;

export { parseRoutingKey, routingKey } from "@dovsky/protocol";

/**
 * A gate failure or a bad grade means the model could not do the work at that tier; auth, rate limits, protocol
 * errors, a gate that was already broken at the start commit, daemon restarts and cancellations say nothing about
 * the model and never move a policy.
 */
export function failureCause(state: JobState, failure: FailureInfo | null, grade: Grade | null): FailureCause | null {
  if (state === "succeeded") return grade === "bad" ? "capability" : null;
  if (state === "failed" && failure?.code === "quality_gate") return "capability";
  if (state === "failed" && (failure?.code === "review_protocol" || failure?.code === "review_stale")) return null;
  return state === "failed" || state === "cancelled" ? "environmental" : null;
}

export function nextTier(tier: Tier): Tier | null {
  return TIERS[TIERS.indexOf(tier) + 1] ?? null;
}

export function previousTier(tier: Tier): Tier | null {
  const index = TIERS.indexOf(tier);
  return index > 0 ? (TIERS[index - 1] as Tier) : null;
}

/** First written tier is the provider's floor; startIndex only selects the entry provider/rung. */
export function armSet(
  ladder: CharterLadder | null, provider: Provider, config: Pick<BanditConfig, "widenSingleRungLadders">,
): Tier[] {
  if (ladder === null) return [...TIERS];
  const tiers = ladder.rungs.filter((rung) => rung.provider === provider).map((rung) => rung.tier);
  if (tiers.length !== 1 || ladder.fixed || !config.widenSingleRungLadders) return tiers;
  const floor = TIERS.indexOf(tiers[0] as Tier);
  return TIERS.slice(floor, floor + 3);
}

/**
 * Nearest strictly higher allowed tier on this provider, otherwise the next provider's first arm.
 * Provider order is first appearance in allowed. No wraparound or invented provider path.
 * Root supplies arms at their charter floors and handles availability, capacity and job creation.
 */
export function nextAllowedEscalation(current: Rung, allowed: readonly Rung[]): Rung | null {
  const providers = [...new Set(allowed.map((rung) => rung.provider))];
  const at = providers.indexOf(current.provider);
  if (at === -1) return null;
  const higher = allowed.filter((rung) => rung.provider === current.provider
    && TIERS.indexOf(rung.tier) > TIERS.indexOf(current.tier));
  higher.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  const next = higher[0] ?? allowed.find((rung) => rung.provider === providers[at + 1]);
  return next ? { ...next } : null;
}
