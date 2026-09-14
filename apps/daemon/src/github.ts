import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isSafeId, type PullRequestView } from "@dovsky/protocol";
import type { DeltaArtifact, TreeEntry } from "./job-delta.js";
import { gitBytes, gitText, remoteBranchHead, worktreeAdd, worktreeRemove } from "./git.js";
import { readRegularFile, safeTreePath } from "./file-state.js";
import { sanitizeStoredText } from "./sanitize.js";

const MAX_OUTPUT = 1024 * 1024;
const MAX_BODY = 65_536;
const MAX_EVIDENCE = 60 * 1024;
const MAX_FILE = 64 * 1024 * 1024;

export interface GitHubCommandResult { status: number | null; stdout: string; stderr: string; }
export type GitHubCommandRunner = (argv: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<GitHubCommandResult>;
export interface PullRequestProgress {
  onCommitted?: (headSha: string) => void | Promise<void>;
  onPushed?: (headSha: string) => void | Promise<void>;
}

export interface PullRequestBodyInput {
  acceptance: string;
  criteria?: readonly string[];
  gates?: readonly (readonly [string, string])[];
  review?: string;
  identity: string;
  evaluation?: string;
  evidence?: string;
}

export interface PullRequestLeafInput {
  jobId: string;
  roomId: string;
  repository: string;
  remote: string;
  baseBranch: string;
  projectPath: string;
  worktreePath: string;
  startCommit: string;
  fingerprint: string;
  contentHash: string;
  evidenceHash: string;
  title: string;
  commitName: string;
  commitEmail: string;
  delta: DeltaArtifact;
  body: PullRequestBodyInput;
  draft?: boolean;
  accepted?: boolean;
}

export interface PullRequestProbe {
  configured: boolean;
  branch: string;
  existing: Record<string, unknown> | null;
  branchExists: boolean;
  branchHead: string | null;
  reason?: string;
}

export interface PullRequestLeafResult {
  state: "open" | "merged" | "closed";
  branch: string;
  headSha: string | null;
  number: number | null;
  url: string | null;
  existing: Record<string, unknown> | null;
  bodyHash: string | null;
  isDraft: boolean;
  mergedAt: string | null;
  mergeCommit: string | null;
}

export interface PullRequestStatusInput {
  repository: string;
  projectPath: string;
  branch: string;
  number?: number | null;
}

export interface PullRequestStatusResult {
  state: "open" | "merged" | "closed";
  repository: string;
  branch: string;
  number: number;
  url: string;
  headSha: string;
  isDraft: boolean;
  mergedAt: string | null;
  mergeCommit: string | null;
}

export class GitHubLeafError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "NOT_CONFIGURED" | "STATE_CONFLICT" | "EXTERNAL_ERROR", message: string) {
    super(message);
    this.name = "GitHubLeafError";
  }
}

function bounded(value: string, label: string): string {
  if (Buffer.byteLength(value) > MAX_OUTPUT) throw new GitHubLeafError("EXTERNAL_ERROR", `${label} exceeded output bound`);
  return value;
}

function requireSafe(value: string, label: string): void {
  if (!isSafeId(value)) throw new GitHubLeafError("INVALID_REQUEST", `${label} is not a safe identifier`);
}

function requireRepository(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new GitHubLeafError("INVALID_REQUEST", "repository is invalid");
}

function requireBranch(value: string, label: string): void {
  if (!value || value.length > 256 || value.startsWith("-") || value.includes("..") || value.includes("@{") || /[\0-\x20~^:?*[\\]/.test(value)) throw new GitHubLeafError("INVALID_REQUEST", `${label} is invalid`);
}

function validateDeltaIdentity(input: PullRequestLeafInput): void {
  const baseline = input.delta?.baseline?.manifest;
  const final = input.delta?.final?.manifest;
  if (!baseline || typeof baseline.commit !== "string" || !baseline.identity || typeof baseline.identity.fingerprint !== "string" || typeof baseline.identity.contentHash !== "string" || !final || !final.identity || typeof final.identity.fingerprint !== "string" || typeof final.identity.contentHash !== "string") {
    throw new GitHubLeafError("STATE_CONFLICT", "Delta identity is invalid");
  }
  if (input.startCommit !== baseline.commit) throw new GitHubLeafError("STATE_CONFLICT", "PR start commit does not match the delta baseline");
  if (input.fingerprint !== final.identity.fingerprint) throw new GitHubLeafError("STATE_CONFLICT", "PR fingerprint does not match the delta final identity");
  if (input.contentHash !== final.identity.contentHash) throw new GitHubLeafError("STATE_CONFLICT", "PR content hash does not match the delta final identity");
  const evidence = input.body?.evidence ?? "";
  const evidenceHash = createHash("sha256").update(evidence).digest("hex");
  if (input.evidenceHash !== evidenceHash) throw new GitHubLeafError("STATE_CONFLICT", "PR evidence hash does not match the supplied evidence");
}

export function pullRequestBranch(roomId: string, jobId: string): string {
  requireSafe(roomId, "roomId");
  requireSafe(jobId, "jobId");
  return `dovsky/${roomId.slice(0, 8)}-${jobId.slice(0, 8)}`;
}

export function validatePullRequestInput(input: PullRequestLeafInput): void {
  requireSafe(input.jobId, "jobId");
  requireSafe(input.roomId, "roomId");
  requireRepository(input.repository);
  for (const [value, label] of [[input.remote, "remote"], [input.baseBranch, "baseBranch"], [input.startCommit, "startCommit"], [input.commitName, "commitName"], [input.commitEmail, "commitEmail"]] as const) {
    if (!value || value.length > 256 || /[\0\r\n]/.test(value) || value.startsWith("-")) throw new GitHubLeafError("INVALID_REQUEST", `${label} is invalid`);
  }
  if (!isAbsolute(input.projectPath) || !isAbsolute(input.worktreePath) || resolve(input.worktreePath) === resolve(input.projectPath)) throw new GitHubLeafError("INVALID_REQUEST", "project and worktree must be distinct absolute paths");
  if (!input.fingerprint || !input.contentHash || !input.evidenceHash) throw new GitHubLeafError("INVALID_REQUEST", "identities are required");
  if (!input.title.trim() || input.title.length > 72 || /[\0\r\n]/.test(input.title)) throw new GitHubLeafError("INVALID_REQUEST", "title is invalid");
  validateDeltaIdentity(input);
}

function defaultRunner(argv: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<GitHubCommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: env ?? process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    const append = (current: string, chunk: string, label: string): string => {
      const next = current + chunk;
      if (Buffer.byteLength(next) > MAX_OUTPUT) { child.kill("SIGTERM"); throw new GitHubLeafError("EXTERNAL_ERROR", `${label} exceeded output bound`); }
      return next;
    };
    child.stdout.on("data", (chunk: string) => { try { stdout = append(stdout, chunk, "command output"); } catch (error) { reject(error); } });
    child.stderr.on("data", (chunk: string) => { try { stderr = append(stderr, chunk, "command error"); } catch (error) { reject(error); } });
    child.once("error", reject);
    child.once("close", (status: number | null) => resolveResult({ status, stdout: bounded(stdout, "command output"), stderr: bounded(stderr, "command error") }));
  });
}

function parseJsonList(text: string, label: string): Record<string, unknown>[] {
  let value: unknown;
  try { value = JSON.parse(bounded(text, label)); } catch { throw new GitHubLeafError("EXTERNAL_ERROR", `${label} was not JSON`); }
  if (!Array.isArray(value) || value.some(item => item === null || typeof item !== "object" || Array.isArray(item))) throw new GitHubLeafError("EXTERNAL_ERROR", `${label} had an invalid shape`);
  return value as Record<string, unknown>[];
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(bounded(text, label)); } catch { throw new GitHubLeafError("EXTERNAL_ERROR", `${label} was not JSON`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new GitHubLeafError("EXTERNAL_ERROR", `${label} had an invalid shape`);
  return value as Record<string, unknown>;
}

type ExistingPullRequestState = "open" | "merged" | "closed";
interface NormalizedPullRequest {
  state: ExistingPullRequestState;
  number: number;
  url: string;
  headSha: string;
  isDraft: boolean;
  mergedAt: string | null;
  mergeCommit: string | null;
}

function positiveSafeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new GitHubLeafError("EXTERNAL_ERROR", `GitHub PR ${label} was invalid`);
  return value;
}

function pullRequestUrl(repository: string, number: number): string {
  return `https://github.com/${repository}/pull/${number}`;
}

function validateExistingPullRequest(record: Record<string, unknown>, repository: string): NormalizedPullRequest {
  const expectedKeys = ["headRefOid", "isDraft", "mergeCommit", "mergedAt", "number", "state", "url"];
  const actualKeys = Object.keys(record).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR record had an invalid shape");
  const state = record.state;
  if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR state was invalid");
  const number = positiveSafeNumber(record.number, "number");
  if (typeof record.url !== "string" || record.url !== pullRequestUrl(repository, number)) throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR URL was invalid");
  if (typeof record.headRefOid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(record.headRefOid)) throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR head was invalid");
  if (typeof record.isDraft !== "boolean") throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR draft flag was invalid");
  const mergedAtValue = record.mergedAt;
  let mergedAt: string | null = null;
  if (mergedAtValue !== null) {
    if (typeof mergedAtValue !== "string") throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR merge time was invalid");
    const parsed = new Date(mergedAtValue);
    if (!Number.isFinite(parsed.getTime())) throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR merge time was invalid");
    mergedAt = parsed.toISOString();
  }
  const mergeCommitValue = record.mergeCommit;
  let mergeCommit: string | null = null;
  if (mergeCommitValue !== null) {
    if (typeof mergeCommitValue !== "object" || Array.isArray(mergeCommitValue) || Object.keys(mergeCommitValue).length !== 1 || Object.keys(mergeCommitValue)[0] !== "oid") throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR merge commit was invalid");
    const oid = (mergeCommitValue as { oid?: unknown }).oid;
    if (typeof oid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR merge commit was invalid");
    mergeCommit = oid;
  }
  if (state === "MERGED" ? mergedAt === null || mergeCommit === null : mergedAt !== null || mergeCommit !== null) throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR merge fields were inconsistent with state");
  return { state: state === "OPEN" ? "open" : state === "MERGED" ? "merged" : "closed", number, url: record.url, headSha: record.headRefOid, isDraft: record.isDraft, mergedAt, mergeCommit };
}

function parseCreatedPullRequest(text: string, repository: string): { number: number; url: string } {
  const output = bounded(text, "GitHub PR creation").trim();
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^https://github\\.com/${escapedRepository}/pull/([1-9][0-9]*)$`).exec(output);
  if (!match) throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR creation returned an invalid URL");
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number <= 0) throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR creation returned an invalid number");
  return { number, url: pullRequestUrl(repository, number) };
}

/** Read-only preflight: auth, existing PR, then remote branch, in that order. */
export async function probePullRequest(input: PullRequestLeafInput, runner: GitHubCommandRunner = defaultRunner): Promise<PullRequestProbe> {
  validatePullRequestInput(input);
  const branch = pullRequestBranch(input.roomId, input.jobId);
  let auth: GitHubCommandResult;
  try { auth = await runner(["gh", "auth", "status", "--hostname", "github.com"], input.projectPath); }
  catch { return { configured: false, branch, existing: null, branchExists: false, branchHead: null, reason: "NOT_CONFIGURED" }; }
  if (auth.status !== 0) return { configured: false, branch, existing: null, branchExists: false, branchHead: null, reason: "NOT_CONFIGURED" };
  const listed = await runner(["gh", "pr", "list", "--repo", input.repository, "--head", branch, "--state", "all", "--json", "number,state,url,headRefOid,isDraft,mergedAt,mergeCommit"], input.projectPath);
  if (listed.status !== 0) throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR probe failed");
  const records = parseJsonList(listed.stdout, "GitHub PR probe");
  if (records.length > 1) throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR probe was ambiguous");
  const existing = records[0] ?? null;
  if (existing) { validateExistingPullRequest(existing, input.repository); return { configured: true, branch, existing, branchExists: false, branchHead: null }; }
  let branchHead: string | null;
  try { branchHead = remoteBranchHead(input.projectPath, input.remote, branch); }
  catch (error) { throw new GitHubLeafError("EXTERNAL_ERROR", `Remote branch probe failed: ${String(error).slice(0, 2048)}`); }
  return { configured: true, branch, existing: null, branchExists: branchHead !== null, branchHead };
}

function validateStatusInput(input: PullRequestStatusInput): void {
  requireRepository(input.repository);
  if (!isAbsolute(input.projectPath)) throw new GitHubLeafError("INVALID_REQUEST", "project path must be absolute");
  requireBranch(input.branch, "branch");
  if (input.number !== undefined && input.number !== null) positiveSafeNumber(input.number, "number");
}

/** Read-only status reconciliation for a persisted PR identity. */
export async function statusPullRequest(input: PullRequestStatusInput, runner: GitHubCommandRunner = defaultRunner): Promise<PullRequestStatusResult> {
  validateStatusInput(input);
  let auth: GitHubCommandResult;
  try { auth = await runner(["gh", "auth", "status", "--hostname", "github.com"], input.projectPath); }
  catch { throw new GitHubLeafError("NOT_CONFIGURED", "GitHub CLI is not authenticated"); }
  if (auth.status !== 0) throw new GitHubLeafError("NOT_CONFIGURED", "GitHub CLI is not authenticated");
  const target = input.number === undefined || input.number === null ? input.branch : String(input.number);
  const viewed = await runner(["gh", "pr", "view", target, "--repo", input.repository, "--json", "number,state,url,headRefOid,isDraft,mergedAt,mergeCommit"], input.projectPath);
  if (viewed.status !== 0) throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR status failed");
  const record = parseJsonObject(viewed.stdout, "GitHub PR status");
  const normalized = validateExistingPullRequest(record, input.repository);
  if (input.number !== undefined && input.number !== null && normalized.number !== input.number) throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR status number did not match persisted identity");
  return { repository: input.repository, branch: input.branch, state: normalized.state, number: normalized.number, url: normalized.url, headSha: normalized.headSha, isDraft: normalized.isDraft, mergedAt: normalized.mergedAt, mergeCommit: normalized.mergeCommit };
}

function validateProvidedProbe(input: PullRequestLeafInput, probe: PullRequestProbe): PullRequestProbe {
  if (!probe || probe.branch !== pullRequestBranch(input.roomId, input.jobId) || typeof probe.configured !== "boolean" || typeof probe.branchExists !== "boolean" || (probe.branchExists !== (probe.branchHead !== null))) throw new GitHubLeafError("STATE_CONFLICT", "PR preflight identity was invalid");
  if (probe.configured && probe.existing) validateExistingPullRequest(probe.existing, input.repository);
  if (!probe.existing && probe.branchHead !== null && !probe.branchExists) throw new GitHubLeafError("STATE_CONFLICT", "PR preflight branch identity was invalid");
  return probe;
}

function entryBytes(delta: DeltaArtifact, entry: TreeEntry): Buffer {
  const path = resolve(delta.final.directory, "blobs", entry.hash);
  const bytes = readRegularFile(path, MAX_FILE);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== entry.size || hash !== entry.hash) throw new GitHubLeafError("STATE_CONFLICT", `Delta blob changed: ${entry.path}`);
  return bytes;
}

function removeExisting(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) rmSync(path, { recursive: true, force: false });
  else unlinkSync(path);
}

/** Apply only baseline-to-final entries to a detached start-commit worktree. */
export function materializePullRequestDelta(target: string, delta: DeltaArtifact): void {
  const before = new Map(delta.baseline.manifest.entries.map(entry => [entry.path, entry]));
  const after = new Map(delta.final.manifest.entries.map(entry => [entry.path, entry]));
  const changed = delta.entries.filter(entry => JSON.stringify(entry.before) !== JSON.stringify(entry.after));
  for (const entry of changed.filter(item => item.before && item.before.type === "directory").sort((a, b) => b.path.split("/").length - a.path.split("/").length)) {
    const path = safeTreePath(target, entry.path);
    if (!entry.after || entry.after.type !== "directory") removeExisting(path);
  }
  for (const entry of changed.filter(item => item.before && item.before.type !== "directory").sort((a, b) => b.path.split("/").length - a.path.split("/").length)) removeExisting(safeTreePath(target, entry.path));
  for (const entry of changed.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))) {
    const desired = after.get(entry.path);
    if (!desired) continue;
    const path = safeTreePath(target, desired.path);
    if (desired.type === "directory") { mkdirSync(path, { recursive: true, mode: desired.mode }); chmodSync(path, desired.mode); continue; }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    removeExisting(path);
    const bytes = entryBytes(delta, desired);
    if (desired.type === "link") {
      const link = bytes.toString();
      if (link.includes("\0")) throw new GitHubLeafError("STATE_CONFLICT", `Invalid delta link: ${desired.path}`);
      symlinkSync(link, path);
    } else { writeFileSync(path, bytes, { mode: desired.mode }); chmodSync(path, desired.mode); }
  }
  // Detect an accidentally supplied entry that is not represented in the final snapshot.
  if (changed.some(entry => entry.after && !after.has(entry.after.path) || entry.before && !before.has(entry.before.path))) throw new GitHubLeafError("STATE_CONFLICT", "Delta snapshot is inconsistent");
}

function bodyLine(value: unknown): string { return sanitizeStoredText(typeof value === "string" ? value : String(value ?? "")); }

export function buildPullRequestBody(input: PullRequestBodyInput): string {
  const lines = ["## Acceptance", bodyLine(input.acceptance)];
  for (const criterion of input.criteria ?? []) lines.push(`- [x] ${bodyLine(criterion)}`);
  if (input.gates?.length) { lines.push("", "## Gates"); for (const [name, result] of input.gates) lines.push(`| ${bodyLine(name)} | ${bodyLine(result)} |`); }
  if (input.review !== undefined) lines.push("", "## Review", bodyLine(input.review));
  lines.push("", "## Identity", bodyLine(input.identity));
  if (input.evaluation !== undefined) lines.push("", "## Evaluation", bodyLine(input.evaluation));
  const evidence = bodyLine(input.evidence ?? "");
  const clipped = Buffer.byteLength(evidence) > MAX_EVIDENCE ? `${Buffer.from(evidence).subarray(0, MAX_EVIDENCE).toString()}\n\n[review evidence truncated at 60 KiB]` : evidence;
  lines.push("", "<details>", "<summary>Review evidence</summary>", "", clipped, "", "</details>");
  const body = lines.join("\n");
  if (Buffer.byteLength(body) > MAX_BODY) throw new GitHubLeafError("INVALID_REQUEST", "Pull request body exceeds 65536 bytes");
  return body;
}

function commitMessage(input: PullRequestLeafInput, branch: string): string {
  return `${input.title}\n\njob: ${input.jobId}\nroom: ${input.roomId}\ntree-fingerprint: ${input.fingerprint}\nevidence-sha256: ${input.evidenceHash}\nstart-commit: ${input.startCommit}\nbranch: ${branch}\n`;
}

function readHead(path: string): string { return gitText(path, ["rev-parse", "HEAD"]); }

/** Local/bare-remote adapter. It performs no DB writes; the caller records the returned state. */
export async function createPullRequestLeaf(input: PullRequestLeafInput, runner: GitHubCommandRunner = defaultRunner, progress?: PullRequestProgress, preflight?: PullRequestProbe): Promise<PullRequestLeafResult> {
  validatePullRequestInput(input);
  if (input.accepted !== true) throw new GitHubLeafError("STATE_CONFLICT", "Pull request requires accepted evidence");
  const probe = preflight === undefined ? await probePullRequest(input, runner) : validateProvidedProbe(input, preflight);
  if (!probe.configured) throw new GitHubLeafError("NOT_CONFIGURED", "GitHub CLI is not authenticated");
  if (probe.existing) {
    const normalized = validateExistingPullRequest(probe.existing, input.repository);
    return { state: normalized.state, branch: probe.branch, headSha: normalized.headSha, number: normalized.number, url: normalized.url, existing: probe.existing, bodyHash: null, isDraft: normalized.isDraft, mergedAt: normalized.mergedAt, mergeCommit: normalized.mergeCommit };
  }
  const body = buildPullRequestBody(input.body);
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const messageDir = mkdtempSync(join(tmpdir(), "dovsky-pr-message-"));
  const messagePath = join(messageDir, "commit-message.txt");
  const bodyPath = join(messageDir, "body.md");
  let added = false;
  try {
    writeFileSync(bodyPath, body, { mode: 0o600 });
    let headSha = probe.branchHead;
    if (!probe.branchExists) {
      worktreeAdd(input.projectPath, input.worktreePath, input.startCommit); added = true;
      materializePullRequestDelta(input.worktreePath, input.delta);
      gitBytes(input.worktreePath, ["add", "-A"]);
      writeFileSync(messagePath, commitMessage(input, probe.branch), { mode: 0o600 });
      const commit = gitBytes(input.worktreePath, ["-c", `user.name=${input.commitName}`, "-c", `user.email=${input.commitEmail}`, "-c", "commit.gpgsign=false", "commit", "--no-verify", "-F", messagePath]);
      if (!commit.length) throw new GitHubLeafError("EXTERNAL_ERROR", "PR commit produced no output");
      headSha = readHead(input.worktreePath);
      if (progress?.onCommitted) await progress.onCommitted(headSha);
      gitBytes(input.worktreePath, ["push", "--set-upstream", input.remote, `HEAD:refs/heads/${probe.branch}`]);
    }
    if (!headSha) throw new GitHubLeafError("STATE_CONFLICT", "Remote branch head was not captured");
    if (progress?.onPushed) await progress.onPushed(headSha);
    const created = await runner(["gh", "pr", "create", "--repo", input.repository, "--base", input.baseBranch, "--head", probe.branch, "--title", input.title, "--body-file", bodyPath, ...(input.draft ? ["--draft"] : [])], input.projectPath, { ...process.env, GH_PROMPT_DISABLED: "1" });
    if (created.status !== 0) throw new GitHubLeafError("EXTERNAL_ERROR", "GitHub PR creation failed; reconciliation is required");
    const createdPullRequest = parseCreatedPullRequest(created.stdout, input.repository);
    const record = { number: createdPullRequest.number, url: createdPullRequest.url, state: "OPEN", headRefOid: headSha, isDraft: input.draft === true, mergedAt: null, mergeCommit: null };
    return { state: "open", branch: probe.branch, headSha, number: createdPullRequest.number, url: createdPullRequest.url, existing: record, bodyHash, isDraft: input.draft === true, mergedAt: null, mergeCommit: null };
  } finally {
    try {
      if (added) {
        try { worktreeRemove(input.projectPath, input.worktreePath); }
        catch { throw new GitHubLeafError("STATE_CONFLICT", "PR worktree cleanup could not be confirmed"); }
      }
    } finally { rmSync(messageDir, { recursive: true, force: true }); }
  }
}

export function pullRequestView(result: PullRequestLeafResult, input: PullRequestLeafInput): Pick<PullRequestView, "jobId" | "roomId" | "repository" | "remote" | "baseBranch" | "branch" | "startCommit" | "headSha" | "number" | "url" | "state" | "fingerprint" | "contentHash" | "evidenceHash" | "bodyHash" | "mergedAt" | "mergeCommit"> & { isDraft: boolean } {
  return { jobId: input.jobId, roomId: input.roomId, repository: input.repository, remote: input.remote, baseBranch: input.baseBranch, branch: result.branch, startCommit: input.startCommit, headSha: result.headSha, number: result.number, url: result.url, state: result.state, fingerprint: input.fingerprint, contentHash: input.contentHash, evidenceHash: input.evidenceHash, bodyHash: result.bodyHash, isDraft: result.isDraft, mergedAt: result.mergedAt, mergeCommit: result.mergeCommit };
}
