import { constants, chmodSync, fchmodSync, fstatSync, closeSync, lstatSync, mkdirSync, openSync, readlinkSync, readdirSync, readSync, writeSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { assertPrivateRepository } from './git.js';

const MAX_ROOTS = 32;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 128;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const ADMIN_ROOTS = new Set(['/','/home','/root','/run','/etc','/var','/tmp']);
const ADMIN_COMPONENTS = new Set(['.git', '.agentbus', '.dovsky', '.agents', '.codex', '.claude', '.cache', '.npm']);
const hasAdministrativeComponent = (path: string): boolean => path.split('/').some(part => ADMIN_COMPONENTS.has(part.toLowerCase()));

function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith('../'));
}

function assertRealDirectory(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) throw new Error(`${label} must be a normalized absolute path`);
  const absolute = resolve(path), root = parse(absolute).root;
  if (ADMIN_ROOTS.has(absolute)) throw new Error(`${label} is an administrative root`);
  let current = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} has an unsafe ancestor: ${current}`);
  }
}

function safeTreePath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\0')) throw new Error(`Unsafe dependency root: ${path}`);
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || ADMIN_COMPONENTS.has(part.toLowerCase()))) {
    throw new Error(`Unsafe dependency root: ${path}`);
  }
  const target = resolve(root, path);
  if (!inside(resolve(root), target)) throw new Error(`Dependency root escapes source tree: ${path}`);
  let current = resolve(root);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe dependency ancestor: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}

function validateRoot(root: string): string[] {
  if (typeof root !== 'string' || !root || root.includes('\0') || root.includes('\\')) throw new Error(`Invalid dependency root: ${root}`);
  const parts = root.split('/');
  if (parts.at(-1) !== 'node_modules' || parts.slice(0, -1).some(part => !part || part === '.' || part === '..' || ADMIN_COMPONENTS.has(part.toLowerCase()) || part === 'node_modules')) {
    throw new Error(`Dependency root must be a project-relative node_modules directory: ${root}`);
  }
  if (parts.join('/') !== root) throw new Error(`Dependency root must be normalized: ${root}`);
  return parts;
}

function writeFileExclusive(path: string, bytes: Buffer, mode: number): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode & 0o7777);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, null);
    fchmodSync(fd, mode & 0o7777);
  } finally { closeSync(fd); }
}

/** Copy ignored installed dependency trees into an already-private population clone. */
export function copyInstalledDependencies(sourceTree: string, ownedTargetTree: string, roots: readonly string[]): void {
  if (!Array.isArray(roots) || roots.length > MAX_ROOTS) throw new Error('Too many dependency roots');
  if (!isAbsolute(sourceTree) || resolve(sourceTree) !== sourceTree || sourceTree.includes('\0')
    || !isAbsolute(ownedTargetTree) || resolve(ownedTargetTree) !== ownedTargetTree || ownedTargetTree.includes('\0')) {
    throw new Error('Dependency source and target must be normalized absolute paths');
  }
  const source = sourceTree, target = ownedTargetTree;
  if (source === target || inside(source, target) || inside(target, source)) throw new Error('Dependency source and target overlap');
  assertRealDirectory(source, 'Dependency source');
  assertRealDirectory(target, 'Dependency target');
  assertPrivateRepository(source);
  assertPrivateRepository(target);
  const normalized = roots.map(validateRoot);
  const names = normalized.map(parts => parts.join('/'));
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    if (names[i] === names[j] || names[i]!.startsWith(names[j]! + '/') || names[j]!.startsWith(names[i]! + '/')) throw new Error('Overlapping dependency roots');
  }
  const sourceRoots = names.map(root => safeTreePath(source, root));
  const targetRoots = names.map(root => safeTreePath(target, root));
  for (const path of targetRoots) if (lstatSync(path, { throwIfNoEntry: false })) throw new Error(`Dependency target already exists: ${path}`);

  let entries = 0, totalBytes = 0;
  const validate = (from: string, depth: number): void => {
    if (++entries > MAX_ENTRIES || depth > MAX_DEPTH) throw new Error('Dependency output exceeds validation bounds');
    if (hasAdministrativeComponent(relative(source, from))) throw new Error(`Dependency tree exposes administration: ${from}`);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(from), lexical = resolve(dirname(from), link);
      if (!link || isAbsolute(link) || link.includes('\0') || !inside(source, lexical)
        || hasAdministrativeComponent(relative(source, lexical))) throw new Error(`Unsafe dependency symlink: ${from}`);
      return;
    }
    if (stat.isDirectory()) { for (const name of readdirSync(from)) validate(join(from, name), depth + 1); return; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error(`Unsafe or oversized dependency file: ${from}`);
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Dependency output exceeds byte bound');
  };
  const existing = sourceRoots.map(path => lstatSync(path, { throwIfNoEntry: false }));
  for (let i = 0; i < sourceRoots.length; i++) {
    const stat = existing[i], path = sourceRoots[i]!;
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Dependency root is not a real directory: ${path}`);
    validate(path, 0);
  }
  let remainingBytes = totalBytes;
  let copiedEntries = 0;
  const copy = (from: string, to: string, depth: number): void => {
    if (++copiedEntries > MAX_ENTRIES || depth > MAX_DEPTH) throw new Error('Dependency output exceeds validation bounds');
    const stat = lstatSync(from);
    if (hasAdministrativeComponent(relative(source, from))) throw new Error(`Dependency tree exposes administration: ${from}`);
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(from);
      const lexical = resolve(dirname(from), link);
      if (!link || isAbsolute(link) || link.includes('\0') || !inside(source, lexical)
        || hasAdministrativeComponent(relative(source, lexical))) throw new Error(`Unsafe dependency symlink: ${from}`);
      symlinkSync(link, to);
      return;
    }
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: false, mode: 0o700 });
      for (const name of readdirSync(from)) copy(join(from, name), join(to, name), depth + 1);
      chmodSync(to, stat.mode & 0o7777);
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error(`Unsafe or oversized dependency file: ${from}`);
    const fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.nlink !== stat.nlink
        || before.mode !== stat.mode || before.size > MAX_FILE_BYTES || before.size > remainingBytes) throw new Error(`Dependency file identity or byte bound changed: ${from}`);
      const buffer = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, null); if (!count) break; offset += count; }
      const after = fstatSync(fd);
      if (offset !== before.size || before.size !== after.size || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`Dependency file changed while copied: ${from}`);
      bytes = buffer;
    } finally { closeSync(fd); }
    writeFileExclusive(to, bytes, stat.mode);
    remainingBytes -= bytes.length;
  };
  for (let i = 0; i < sourceRoots.length; i++) {
    const from = sourceRoots[i]!, to = targetRoots[i]!;
    const sourceStat = existing[i];
    if (!sourceStat) continue;
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`Dependency root is not a real directory: ${from}`);
    let parent = dirname(to);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertRealDirectory(parent, 'Dependency target parent');
    if (lstatSync(to, { throwIfNoEntry: false })) throw new Error(`Dependency target already exists: ${to}`);
    copy(from, to, 0);
  }
}
