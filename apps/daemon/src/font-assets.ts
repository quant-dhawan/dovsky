import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Operator configuration, never supplied by a worker request or repository manifest. */
export interface FontAssetApproval {
  path: string;
  sha256: string;
  bytes: number;
  licensePath: string;
  licenseSha256: string;
  sourceUrl: string;
  sourceSha256: string;
  note: string;
}

const hashPattern = /^[a-f0-9]{64}$/;
const safePath = (value: unknown): value is string => typeof value === "string" && value.length <= 500
  && value.split("/").every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..");
export const fontAssetHash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

export function parseFontAssetApprovals(value: unknown): FontAssetApproval[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("fontAssets must be an array of at most 32 exact approvals");
  const seen = new Set<string>();
  return value.map((entry: unknown): FontAssetApproval => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid font asset approval");
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "bytes,licensePath,licenseSha256,note,path,sha256,sourceSha256,sourceUrl") throw new Error("Unexpected font approval fields");
    if (!safePath(row.path) || !row.path.endsWith(".woff2") || seen.has(row.path)
      || !safePath(row.licensePath) || row.path === row.licensePath
      || ![row.sha256, row.licenseSha256, row.sourceSha256].every(v => typeof v === "string" && hashPattern.test(v))
      || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 48 || Number(row.bytes) > 2 * 1024 * 1024
      || typeof row.sourceUrl !== "string" || row.sourceUrl.length > 2048
      || typeof row.note !== "string" || !row.note.trim() || row.note.length > 1000 || /[\x00-\x1f`]/.test(row.note)) throw new Error("Invalid exact WOFF2 approval");
    const url = new URL(row.sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password || /[\x00-\x20`]/.test(row.sourceUrl)) throw new Error("Font source must be a credential-free HTTPS URL");
    seen.add(row.path);
    return { path: row.path, sha256: String(row.sha256), bytes: Number(row.bytes), licensePath: row.licensePath,
      licenseSha256: String(row.licenseSha256), sourceUrl: row.sourceUrl, sourceSha256: String(row.sourceSha256), note: row.note };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

export const fontPolicyHash = (policy: FontAssetApproval[]): string => fontAssetHash(JSON.stringify(parseFontAssetApprovals(policy)));

/** Exact identity verification plus header sanity; NOT a font sanitizer or semantic binary review. */
export function fontAssetEvidence(workdir: string, path: string, before: Buffer | null, after: Buffer | null, policy: FontAssetApproval[]): string {
  const approval = policy.find(row => row.path === path);
  if (!approval || before !== null || after === null) throw new Error("Only explicitly approved WOFF2 additions are supported");
  const root = realpathSync(workdir);
  const regular = (relative: string, limit: number): string => {
    const target = resolve(root, relative);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.mode & 0o111 || stat.size > limit || realpathSync(target) !== target) throw new Error("Asset and license must be bounded, non-executable regular files without symlink parents");
    return target;
  };
  const target = regular(path, 2 * 1024 * 1024);
  if (after.length !== approval.bytes || fontAssetHash(after) !== approval.sha256 || !readFileSync(target).equals(after)) throw new Error("Font bytes do not match the frozen operator approval");
  const license = readFileSync(regular(approval.licensePath, 64 * 1024));
  if (license.includes(0) || fontAssetHash(license) !== approval.licenseSha256) throw new Error("Font license does not match the frozen operator approval");
  const flavor = after.readUInt32BE(4);
  if (after.length < 48 || after.toString("ascii", 0, 4) !== "wOF2" || ![0x00010000, 0x4f54544f].includes(flavor)
    || after.readUInt32BE(8) !== after.length || after.readUInt16BE(12) < 1 || after.readUInt16BE(12) > 64
    || after.readUInt16BE(14) !== 0 || after.readUInt32BE(16) < 12 || after.readUInt32BE(16) > 16 * 1024 * 1024
    || after.readUInt32BE(20) < 1 || after.readUInt32BE(20) > after.length - 48
    || !after.subarray(28, 48).equals(Buffer.alloc(20))) throw new Error("Unsupported WOFF2 header (collections, metadata and private blocks are excluded)");
  const receipt = { verification: "operator-pinned-font-identity-v1", before: null, after: { sha256: approval.sha256, bytes: after.length },
    mediaType: "font/woff2", tables: after.readUInt16BE(12), approval,
    limits: "Header sanity and exact identity only. Provenance is operator-declared; no network source verification, sanitizer guarantee, semantic binary review, or human acceptance is inferred." };
  return `### ${path} (approved font addition)\n\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`\n`;
}
