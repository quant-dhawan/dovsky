import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { assertRealDirectory, readRegularFile } from './file-state.js';

export interface ProviderHomeOwnership {
  readonly homeDirectory: string;
  assertOwned(): void;
  /** The caller must observe every execution/startup fence; uncertainty retains ownership. */
  release(confirmAbsent: () => Promise<boolean>): Promise<void>;
}

export function validateProviderStateKey(key: string): void {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(key)) throw new Error('Invalid provider state key');
}

function privateDirectory(path: string): Stats {
  assertRealDirectory(path);
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Provider state directory must be private and daemon-owned');
  return stat;
}

/** Durable mkdir ownership has no age/PID/unit-based reclamation path. */
export function acquireProviderHome(sandboxRoot: string, key: string, requireExisting = false): ProviderHomeOwnership {
  validateProviderStateKey(key);
  if (typeof requireExisting !== 'boolean') throw new Error('Invalid provider state retention policy');
  const identities = new Map<string, Stats>([[sandboxRoot, privateDirectory(sandboxRoot)]]);
  const parent = join(sandboxRoot, 'provider-state', key);
  if (requireExisting) {
    try { privateDirectory(join(parent, 'home')); }
    catch { throw new Error('Retained provider state is unavailable; refusing an empty resumed home'); }
  }
  for (const path of [join(sandboxRoot, 'provider-state'), parent]) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    identities.set(path, privateDirectory(path));
  }
  const lock = join(parent, 'owner');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Provider state key is owned; reconciliation is required');
    throw error;
  }
  // A crash or partial initialization after mkdir intentionally leaves a fence.
  identities.set(lock, privateDirectory(lock));
  const token = randomUUID(), record = join(lock, 'token');
  writeFileSync(record, token, { flag: 'wx', mode: 0o600 });
  identities.set(record, lstatSync(record));
  const homeDirectory = join(parent, 'home');
  try { if (!requireExisting) mkdirSync(homeDirectory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  identities.set(homeDirectory, privateDirectory(homeDirectory));
  let released = false, releasing = false;
  const assertOwned = (): void => {
    if (released) throw new Error('Provider home ownership is released');
    for (const [path, identity] of identities) {
      const now = path === record ? lstatSync(path) : privateDirectory(path);
      if (now.ino !== identity.ino || now.dev !== identity.dev || now.uid !== identity.uid
        || (path === record && (!now.isFile() || now.nlink !== 1 || (now.mode & 0o077) !== 0))) throw new Error('Provider home ownership identity changed');
    }
    if (readRegularFile(record, 128).toString() !== token) throw new Error('Provider home ownership token changed');
  };
  return { homeDirectory, assertOwned, release: async confirmAbsent => {
    if (released) return;
    if (releasing) throw new Error('Provider home release is pending');
    releasing = true;
    try {
      assertOwned();
      if (!await confirmAbsent()) throw new Error('Provider home scope absence is unconfirmed');
      assertOwned();
      unlinkSync(record);
      rmdirSync(lock);
      released = true;
    } finally { releasing = false; }
  } };
}
