import type { Provider } from "@dovsky/protocol";

export interface DanglingTool {
  kind: string;
  command: string;
}

const cut = (value: unknown): string | null => (typeof value === "string" ? value.slice(0, 120) : null);

/**
 * Given the raw text of a `provider-<n>.jsonl` attempt log (one `{"at","channel","data"}` record
 * per line, as written by `daemon.ts`'s `writeLog`), report a tool call that was started but never
 * returned before the process died — evidence that a retry could re-run a side-effecting command.
 *
 * Self-contained by design: this duplicates the small amount of event-shape parsing that
 * `daemon.ts`'s `providerLineStep`/`providerLineResult` already do, rather than importing them,
 * because this module must stay pure (no daemon/database imports) so it can be unit-tested and
 * later called from crash recovery without pulling in the daemon's process/child-process world.
 *
 * Only the LAST complete stdout line is inspected (tail-only), never any tool-shaped line earlier
 * in the log. A tool call that started and finished mid-transcript is not evidence of anything: the
 * log is full of them in a normal run. The only thing a dead process can leave behind is an
 * unanswered call at the very end of what it managed to write — so a match anywhere but the tail is
 * a parse artifact, not a crash (see qm's tapeNeedsInterruptHeal / tape-fold.ts:314-317 for the same
 * lesson: narrow to the tail, not "found somewhere in the tape").
 *
 * Never throws: a missing, empty, or garbage log simply yields no evidence.
 */
export function interruptedTool(logText: string, provider: Provider): DanglingTool | null {
  if (typeof logText !== "string" || logText.length === 0) return null;

  // Reassemble stdout before splitting on "\n": each log line's "data" is the raw, possibly
  // partial chunk read off the child's stdout pipe, so a single JSON event can be split across
  // two or more log lines (see the codex-unicode-split fixture in __fixtures__/provider.ts).
  let stdout = "";
  for (const logLine of logText.split("\n")) {
    if (!logLine) continue;
    let record: unknown;
    try {
      record = JSON.parse(logLine);
    } catch {
      continue;
    }
    if (record && typeof record === "object" && (record as Record<string, unknown>).channel === "stdout") {
      const data = (record as Record<string, unknown>).data;
      if (typeof data === "string") stdout += data;
    }
  }

  const lines = stdout.split("\n").filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (!lastLine) return null;

  let event: unknown;
  try {
    event = JSON.parse(lastLine);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;

  if (provider === "claude" && e.type === "assistant") {
    const content = (e.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return null;
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || block.type !== "tool_use") continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const command = cut(input.command) ?? cut(input.file_path);
      if (command === null) continue;
      return { kind: typeof block.name === "string" ? block.name : "tool", command };
    }
    return null;
  }

  if (provider === "codex" && e.type === "item.started") {
    const item = e.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") return null;
    const command = cut(item.command) ?? cut(item.text);
    if (command === null) return null;
    return { kind: typeof item.type === "string" ? item.type : "item", command };
  }

  return null;
}
