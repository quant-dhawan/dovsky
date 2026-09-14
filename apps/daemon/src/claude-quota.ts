import { homedir } from "node:os";
import { resolve } from "node:path";
import type { QuotaWindowReading } from "@dovsky/protocol";
import { quotaCurrent, quotaReading } from "./quota-state.js";

const windowMinutes = new Map([
  ["five_hour", 300],
  ["seven_day", 10080],
  ["seven_day_opus", 10080],
  ["seven_day_sonnet", 10080],
  ["seven_day_overage_included", 10080],
]);

/** Parse one TypeScript Agent SDK event; receipt time is the only clock input. */
export function parseClaudeRateLimitLine(line: string, receivedAt: string): QuotaWindowReading | null {
  if (typeof line !== "string" || line.length > 32768 || Buffer.byteLength(line) > 32768
    || typeof receivedAt !== "string" || receivedAt.length > 64 || !Number.isFinite(Date.parse(receivedAt))) return null;
  try {
    const event: unknown = JSON.parse(line);
    if (!event || typeof event !== "object" || Array.isArray(event)) return null;
    const envelope = event as Record<string, unknown>;
    if (envelope.type !== "rate_limit_event" || !envelope.rate_limit_info
      || typeof envelope.rate_limit_info !== "object" || Array.isArray(envelope.rate_limit_info)) return null;
    const info = envelope.rate_limit_info as Record<string, unknown>;
    if (!["allowed", "allowed_warning", "rejected"].includes(info.status as string)
      || typeof info.utilization !== "number" || !Number.isFinite(info.utilization)
      || info.utilization < 0 || info.utilization > 1
      || typeof info.resetsAt !== "number" || !Number.isSafeInteger(info.resetsAt) || info.resetsAt <= 0
      || typeof info.rateLimitType !== "string") return null;
    const duration = windowMinutes.get(info.rateLimitType);
    if (!duration) return null;
    const reading = quotaReading({
      windowId: info.rateLimitType, usedPercent: info.utilization * 100, windowMinutes: duration,
      resetsAt: new Date(info.resetsAt * 1000).toISOString(), recordedAt: receivedAt,
      source: "claude:rate_limit_event",
    });
    return reading && quotaCurrent(reading, receivedAt) ? reading : null;
  } catch { return null; }
}

export interface ClaudeQuotaReading {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
  recordedAt: string;
  source: string;
}

/**
 * Local, credential-free Claude Code rate-limit reading, the way `readCodexQuota` in daemon.ts reads
 * `rate_limits` from the newest Codex rollout under `$CODEX_HOME/sessions`.
 *
 * Searched under `claudeHome` (default `~/.claude`) for a percent-used-of-window record with a reset time:
 *  - `settings.json` — only feature flags (`tengu_c4w_usage_limit_notifications_enabled`,
 *    `tengu_usage_overage_included_models`, promo-notice arrays), no usage numbers.
 *  - `projects/*\/*.jsonl` (session transcripts) — every assistant turn's `usage` object carries per-message
 *    `input_tokens`/`output_tokens`/cache token counts, but no window-relative percent-used or reset time;
 *    no `rate_limits` event was found in any transcript sampled.
 *  - `cache/changelog.md` — a CLI release note says `SDKRateLimitInfo`/`SDKRateLimitEvent` were added to the
 *    Claude Agent SDK so a live query stream can carry utilization/reset/overage info to the SDK caller, but
 *    that is a runtime stream event, not something the CLI persists to disk.
 *  - `~/.claude.json` (one level up from `claudeHome`) — `lastModelUsage` per project is a cumulative
 *    token/cost counter with no window percentage or reset time; `cachedExtraUsageDisabledReason` is a single
 *    cached flag, not a reading.
 *  - `statsig/`, `daemon/`, `history.jsonl`, `sessions/` — no rate-limit/quota content (no `statsig` directory
 *    exists on this machine at all).
 *  - `.credentials.json` was not opened (credential file, off limits).
 *
 * No reliable local reading exists today, so this always returns null. If a future Claude Code version starts
 * persisting one (as Codex does), point this at it and keep `source` as the file path it came from.
 */
export function readClaudeQuota(claudeHome: string = resolve(homedir(), ".claude")): ClaudeQuotaReading | null {
  return null;
}
