import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FailureInfo, JobState, Provider } from "@dovsky/protocol";
import { isSafeId } from "@dovsky/protocol";

const MAX_TEXT_BYTES = 8 * 1024 * 1024;

export interface LegacyImportSummary {
  scanned: number;
  eligible: number;
  skipped: number;
  warnings: string[];
}

export interface LegacyFollowup {
  createdAt: string | null;
  body: string;
}

export interface LegacyJobSnapshot {
  sourceJobId: string;
  schemaVersion: number | null;
  provider: Provider | null;
  state: JobState;
  cwd: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  prompt: string | null;
  result: string | null;
  failure: FailureInfo | null;
  threadId: string | null;
  followups: LegacyFollowup[];
  model: string | null;
  effort: string | null;
  tier: string | null;
  warnings: string[];
}

export interface LegacyScanResult extends LegacyImportSummary {
  jobs: LegacyJobSnapshot[];
}

export function emptyImportSummary(): LegacyImportSummary {
  return { scanned: 0, eligible: 0, skipped: 0, warnings: [] };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapProvider(value: unknown): Provider | null {
  return value === "claude" || value === "codex" ? value : null;
}

function mapStatus(value: string | null): { state: JobState; recovered: boolean } {
  switch (value) {
    case "done":
    case "succeeded":
      return { state: "succeeded", recovered: false };
    case "failed":
      return { state: "failed", recovered: false };
    case "cancelled":
      return { state: "cancelled", recovered: false };
    case "queued":
    case "starting":
    case "running":
    case "cancel_requested":
      return { state: "failed", recovered: true };
    default:
      return { state: "failed", recovered: true };
  }
}

async function readSmallText(filePath: string, warnings: string[]): Promise<string | null> {
  try {
    const info = await stat(filePath);
    const bytes = Math.min(info.size, MAX_TEXT_BYTES);
    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      if (info.size > MAX_TEXT_BYTES) {
        warnings.push(`${path.basename(filePath)} truncated at ${MAX_TEXT_BYTES} bytes`);
      }
      return buffer.subarray(0, bytesRead).toString("utf8").trimEnd();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") warnings.push(`${path.basename(filePath)} unreadable: ${code ?? "unknown"}`);
    return null;
  }
}

function parseFollowups(input: string | null): LegacyFollowup[] {
  if (!input) return [];
  const chunks = input.split(/^---\s+(.+?)\s+---\s*$/m);
  const followups: LegacyFollowup[] = [];
  for (let index = 1; index < chunks.length; index += 2) {
    const rawDate = chunks[index]?.trim() ?? "";
    const body = chunks[index + 1]?.trim() ?? "";
    if (!body) continue;
    const parsed = Date.parse(rawDate);
    followups.push({
      createdAt: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(),
      body,
    });
  }
  return followups;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export async function readLegacyJob(jobDirectory: string): Promise<LegacyJobSnapshot | null> {
  const sourceJobId = path.basename(jobDirectory);
  if (!isSafeId(sourceJobId)) return null;

  const warnings: string[] = [];
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(path.join(jobDirectory, "job.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    warnings.push(`job.json invalid or unreadable: ${code ?? "parse_error"}`);
    return {
      sourceJobId,
      schemaVersion: null,
      provider: null,
      state: "failed",
      cwd: null,
      createdAt: null,
      updatedAt: null,
      prompt: null,
      result: null,
      failure: {
        code: "unknown",
        summary: "Legacy metadata could not be read",
        retryable: false,
        resumable: false,
        exitCode: null,
        signal: null,
        occurredAt: new Date(0).toISOString(),
      },
      threadId: null,
      followups: [],
      model: null,
      effort: null,
      tier: null,
      warnings,
    };
  }

  const status = await readSmallText(path.join(jobDirectory, "status"), warnings);
  const stateMapping = mapStatus(status);
  const reason = await readSmallText(path.join(jobDirectory, "reason"), warnings);
  const exitText = await readSmallText(path.join(jobDirectory, "exit"), warnings);
  const exitCode = exitText !== null && /^-?\d+$/.test(exitText) ? Number(exitText) : null;
  const prompt = await readSmallText(path.join(jobDirectory, "prompt.txt"), warnings);
  const result = await readSmallText(path.join(jobDirectory, "result.md"), warnings);
  const threadId = await readSmallText(path.join(jobDirectory, "thread"), warnings);
  const promptsLog = await readSmallText(path.join(jobDirectory, "prompts.log"), warnings);
  let updatedAt: string | null = null;
  try {
    updatedAt = (await stat(jobDirectory)).mtime.toISOString();
  } catch {
    warnings.push("directory timestamp unavailable");
  }

  const createdAt = isoOrNull(raw.created ?? raw.created_at);
  if (!createdAt) warnings.push("created timestamp missing or invalid");
  const provider = mapProvider(raw.to ?? raw.provider);
  if (!provider) warnings.push("provider missing or unsupported");
  if (stateMapping.recovered) warnings.push(`legacy status ${status ?? "missing"} imported as failed`);

  const failure: FailureInfo | null =
    stateMapping.state === "failed" || stateMapping.state === "cancelled"
      ? {
          code:
            stateMapping.state === "cancelled"
              ? "cancelled_by_user"
              : stateMapping.recovered
                ? "daemon_restart"
                : "unknown",
          summary:
            reason ||
            (stateMapping.recovered
              ? `Legacy job was left ${status ?? "without status"}`
              : stateMapping.state === "cancelled"
                ? "Cancelled in the legacy harness"
                : "Legacy job failed without a recorded reason"),
          retryable: false,
          resumable: Boolean(threadId),
          exitCode,
          signal: null,
          occurredAt: updatedAt ?? createdAt ?? new Date(0).toISOString(),
        }
      : null;

  return {
    sourceJobId,
    schemaVersion: typeof raw.schema_version === "number" ? raw.schema_version : 0,
    provider,
    state: stateMapping.state,
    cwd: nullableString(raw.cwd),
    createdAt,
    updatedAt,
    prompt,
    result,
    failure,
    threadId: threadId || null,
    followups: parseFollowups(promptsLog),
    model: nullableString(raw.model),
    effort: nullableString(raw.effort),
    tier: nullableString(raw.tier),
    warnings,
  };
}

export async function scanLegacySpool(spoolDirectory: string): Promise<LegacyScanResult> {
  const result: LegacyScanResult = { ...emptyImportSummary(), jobs: [] };
  let entries;
  try {
    entries = await readdir(spoolDirectory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    result.warnings.push(`spool unreadable: ${code ?? "unknown"}`);
    return result;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    result.scanned += 1;
    if (!isSafeId(entry.name)) {
      result.skipped += 1;
      result.warnings.push(`${entry.name}: unsafe directory name`);
      continue;
    }
    const snapshot = await readLegacyJob(path.join(spoolDirectory, entry.name));
    if (!snapshot) {
      result.skipped += 1;
      continue;
    }
    result.jobs.push(snapshot);
    result.eligible += 1;
    result.warnings.push(...snapshot.warnings.map((warning) => `${entry.name}: ${warning}`));
  }
  return result;
}
