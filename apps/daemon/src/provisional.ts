import { createHash } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalIdentity } from "@dovsky/protocol";
import type { DeltaArtifact, DeltaEntry, TreeEntry } from "./job-delta.js";
import { stripAnsi } from "./sanitize.js";

export const PROVISIONAL_RESULT_NAME = "provisional-result.v1.json" as const;
export const MAX_PROVISIONAL_RESULT_BYTES = 32 * 1024;
export const MAX_PROVISIONAL_CHANGED_ENTRIES = 2_048;
export const MAX_PROVISIONAL_SERIALIZED_BYTES = 256 * 1024;

export type ProvisionalChangeStatus = "added" | "modified" | "deleted";

/** Metadata only: neither file bytes nor provider-owned blobs are retained here. */
export interface ProvisionalChangedEntry {
  path: string;
  status: ProvisionalChangeStatus;
  type: TreeEntry["type"];
  mode: number;
  hash: string;
  size: number;
}

export interface ProvisionalArtifactSummary {
  resultBytes: number;
  resultTruncated: boolean;
  changedEntries: number;
  changedEntriesTruncated: boolean;
  serializedBytes: number;
}

export interface ProvisionalResultBuildInput {
  providerResult: string;
  /** Captured snapshots only. This builder never reads either snapshot directory. */
  delta: DeltaArtifact;
}

export interface BuiltProvisionalResult {
  bytes: Buffer;
  sha256: string;
  candidate: CanonicalIdentity;
  summary: ProvisionalArtifactSummary;
}

interface SerializedProvisionalResult {
  version: 1;
  candidate: CanonicalIdentity;
  result: { text: string; truncated: boolean };
  changes: { total: number; truncated: boolean; entries: readonly ProvisionalChangedEntry[] };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8Prefix(text: string, maximum: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maximum) return text;
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function cleanProviderResult(value: string): { text: string; truncated: boolean } {
  if (typeof value !== "string") throw new Error("Provider result must be text");
  // Retain line breaks for readable output, but never persist terminal or other control bytes.
  const cleaned = stripAnsi(value).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  const text = utf8Prefix(cleaned, MAX_PROVISIONAL_RESULT_BYTES);
  return { text, truncated: Buffer.byteLength(cleaned) > Buffer.byteLength(text) };
}

function assertSafePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path || Buffer.byteLength(path) > 4_096 || Buffer.from(path).toString("utf8") !== path
    || path.startsWith("/") || path.startsWith("\\") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path)) {
    throw new Error("Unsafe changed path");
  }
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error("Unsafe changed path");
}

function assertIdentity(value: unknown): CanonicalIdentity {
  const identity = value as CanonicalIdentity | null;
  if (!identity || typeof identity.fingerprint !== "string" || typeof identity.contentHash !== "string"
    || !/^[a-f0-9]{64}$/.test(identity.fingerprint) || !/^[a-f0-9]{64}$/.test(identity.contentHash)) {
    throw new Error("Final snapshot identity is invalid");
  }
  return { fingerprint: identity.fingerprint, contentHash: identity.contentHash };
}

function safeEntry(value: unknown, path: string): TreeEntry {
  const entry = value as TreeEntry | null;
  if (!entry || entry.path !== path || !["file", "link", "directory"].includes(entry.type)
    || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777
    || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 64 * 1024 * 1024
    || typeof entry.hash !== "string" || !/^[a-f0-9]{64}$/.test(entry.hash)) {
    throw new Error("Changed entry metadata is invalid");
  }
  return { path: entry.path, type: entry.type, mode: entry.mode, size: entry.size, hash: entry.hash };
}

function changedEntry(value: DeltaEntry): ProvisionalChangedEntry {
  assertSafePath(value?.path);
  if (value.before === null && value.after === null) throw new Error("Changed entry has no snapshot metadata");
  const before = value.before === null ? null : safeEntry(value.before, value.path);
  const after = value.after === null ? null : safeEntry(value.after, value.path);
  const metadata = after ?? before!;
  return {
    path: metadata.path,
    status: before === null ? "added" : after === null ? "deleted" : "modified",
    type: metadata.type,
    mode: metadata.mode,
    hash: metadata.hash,
    size: metadata.size,
  };
}

function serialize(candidate: CanonicalIdentity, result: { text: string; truncated: boolean }, total: number,
  truncated: boolean, entries: readonly ProvisionalChangedEntry[]): Buffer {
  const artifact: SerializedProvisionalResult = {
    version: 1,
    candidate,
    result,
    changes: { total, truncated, entries },
  };
  return Buffer.from(JSON.stringify(artifact));
}

/**
 * Produces the complete immutable artifact from already-captured provider output and delta metadata.
 * It intentionally has no filesystem reads, so later canonical-tree mutations cannot affect its bytes.
 */
export function buildProvisionalResult(input: ProvisionalResultBuildInput): BuiltProvisionalResult {
  if (!input?.delta || !Array.isArray(input.delta.entries) || !input.delta.final?.manifest) throw new Error("Final delta snapshot is invalid");
  const candidate = assertIdentity(input.delta.final.manifest.identity);
  const result = cleanProviderResult(input.providerResult);
  const allChanges = input.delta.entries.map(changedEntry).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (new Set(allChanges.map(change => change.path)).size !== allChanges.length) throw new Error("Changed paths must be unique");

  const candidates = allChanges.slice(0, MAX_PROVISIONAL_CHANGED_ENTRIES);
  const included: ProvisionalChangedEntry[] = [];
  let changesTruncated = allChanges.length > candidates.length;
  // The empty artifact already includes the brackets. Each retained entry adds its JSON bytes and, after
  // the first, one comma. Calculating this incrementally avoids quadratic serialization at the 2,048 cap.
  const emptySize = serialize(candidate, result, allChanges.length, false, []).length;
  let entriesSize = 0;
  for (const change of candidates) {
    const nextSize = entriesSize + (included.length ? 1 : 0) + Buffer.byteLength(JSON.stringify(change));
    if (emptySize + nextSize > MAX_PROVISIONAL_SERIALIZED_BYTES) {
      changesTruncated = true;
      break;
    }
    included.push(change);
    entriesSize = nextSize;
  }
  const bytes = serialize(candidate, result, allChanges.length, changesTruncated, included);
  if (bytes.length > MAX_PROVISIONAL_SERIALIZED_BYTES) throw new Error("Provisional artifact exceeds serialized size bound");
  const summary: ProvisionalArtifactSummary = Object.freeze({
    resultBytes: Buffer.byteLength(result.text),
    resultTruncated: result.truncated,
    changedEntries: included.length,
    changedEntriesTruncated: changesTruncated,
    serializedBytes: bytes.length,
  });
  return { bytes, sha256: sha256(bytes), candidate: Object.freeze(candidate), summary };
}

/** Caller validates and owns the directory; exclusive creation makes retries non-destructive. */
export function writeProvisionalResultArtifact(artifactDirectory: string, artifact: Pick<BuiltProvisionalResult, "bytes">): string {
  const path = join(artifactDirectory, PROVISIONAL_RESULT_NAME);
  let created = false;
  try {
    writeFileSync(path, artifact.bytes, { flag: "wx", mode: 0o400 });
    created = true;
    chmodSync(path, 0o400);
    return path;
  } catch (error) {
    if (created) try { rmSync(path); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}
