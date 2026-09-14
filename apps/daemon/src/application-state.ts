import { isAbsolute, normalize } from 'node:path';
import type { CanonicalIdentity } from '@dovsky/protocol';

export interface CanonicalApplication {
  state: 'pending' | 'complete';
  canonicalPath: string;
  intentPath: string;
  baselinePath: string;
  finalPath: string;
  expected: CanonicalIdentity;
  contentHash: string;
}

export function applicationRecord(value: unknown): CanonicalApplication | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as CanonicalApplication;
  if (record.state !== 'pending' && record.state !== 'complete') return null;
  if (![record.canonicalPath, record.intentPath, record.baselinePath, record.finalPath].every(path => typeof path === 'string'
    && path.length <= 4096 && isAbsolute(path) && normalize(path) === path && !path.includes('\0'))) return null;
  if (!record.expected || ![record.expected.fingerprint, record.expected.contentHash, record.contentHash]
    .every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) return null;
  return record;
}

/** Invalid metadata is not evidence that an interrupted application completed. */
export function applicationPending(serialized: string | null): boolean {
  if (serialized === null) return false;
  try {
    const metadata: unknown = JSON.parse(serialized);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return true;
    if (!Object.hasOwn(metadata, 'application')) return false;
    return applicationRecord((metadata as { application: unknown }).application)?.state !== 'complete';
  } catch { return true; }
}
