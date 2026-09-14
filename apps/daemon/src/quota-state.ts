import type { QuotaWindowReading } from '@dovsky/protocol';

/** Validate persisted measurements; no missing field becomes a zero estimate. */
export function quotaReading(value: unknown): QuotaWindowReading | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.windowId !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(r.windowId)
    || typeof r.source !== 'string' || !r.source || r.source.length > 256
    || typeof r.usedPercent !== 'number' || !Number.isFinite(r.usedPercent) || r.usedPercent < 0 || r.usedPercent > 100
    || typeof r.windowMinutes !== 'number' || !Number.isFinite(r.windowMinutes) || r.windowMinutes <= 0 || r.windowMinutes > 525600
    || typeof r.recordedAt !== 'string' || !Number.isFinite(Date.parse(r.recordedAt))
    || !(r.resetsAt === null || typeof r.resetsAt === 'string' && Number.isFinite(Date.parse(r.resetsAt)))) return null;
  const recordedAt = new Date(r.recordedAt).toISOString();
  const resetsAt = r.resetsAt === null ? null : new Date(r.resetsAt as string).toISOString();
  if (resetsAt !== null && Date.parse(resetsAt) <= Date.parse(recordedAt)) return null;
  return { windowId: r.windowId, usedPercent: r.usedPercent, windowMinutes: r.windowMinutes,
    recordedAt, resetsAt, source: r.source };
}

export function quotaCurrent(reading: QuotaWindowReading, now: string): boolean {
  const time = Date.parse(now), recorded = Date.parse(reading.recordedAt);
  return Number.isFinite(time) && recorded <= time && time < recorded + reading.windowMinutes * 60000
    && (reading.resetsAt === null || time < Date.parse(reading.resetsAt));
}

/** One schema-18 provider row holds up to eight independently measured windows. */
export function quotaWindows(json: unknown): QuotaWindowReading[] {
  if (typeof json !== 'string' || Buffer.byteLength(json) > 32768) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const envelope = value as Record<string, unknown>;
    if (envelope.version !== 1 || !Array.isArray(envelope.windows) || envelope.windows.length > 8) return [];
    const windows = envelope.windows.map(quotaReading);
    if (windows.some(reading => reading === null)) return [];
    const valid = windows as QuotaWindowReading[];
    return new Set(valid.map(reading => reading.windowId)).size === valid.length ? valid : [];
  } catch { return []; }
}
