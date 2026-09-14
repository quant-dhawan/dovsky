/**
 * Cleans captured command output before it becomes summary/blocker text a human reads in the console.
 * Two problems, one module because both come from the same source (a test runner's raw stdout/stderr
 * landing verbatim in a stored summary):
 *
 *  - `stripAnsi` removes the ANSI/VT control sequences a runner writes for a TTY (SGR colour codes,
 *    cursor/erase CSI sequences, OSC terminal-title/hyperlink sequences). Left in, the escape byte is
 *    invisible in a browser but its "[1m"-style body renders as literal text -- exactly the residue
 *    reported in the live inbox.
 *  - `stripProofWorktreeRoot`/`stripProofWorktreePaths` collapse the daemon's own proof-worktree scratch
 *    path (an internal detail: `<artifactDirectory>/proof-worktrees/<job id>/...`) down to the
 *    project-relative path underneath it, e.g. "backend" instead of
 *    "/home/USER/.dovsky/artifacts/proof-worktrees/<uuid>/backend". `stripProofWorktreeRoot` is for a
 *    call site that already knows the exact root; `stripProofWorktreePaths` is for cleaning text whose
 *    originating root is not known at the point of reading it back (e.g. a row written before this
 *    sanitizer existed), matching any `.../proof-worktrees/<id>/` prefix rather than one specific root.
 *
 * Zero imports: this stays a pure, dependency-free module so it is trivial to unit-test.
 */

// CSI: ESC [ parameter bytes (0x30-0x3F)* intermediate bytes (0x20-0x2F)* final byte (0x40-0x7E) -- covers
// SGR (colour/style) as well as cursor movement, erase and scroll sequences. OSC: ESC ] ... terminated by
// BEL or ESC \ (ST) -- terminal titles and hyperlinks. A lone Fe escape (ESC followed by a single 0x40-0x5F
// byte, e.g. save/restore cursor) is dropped too so no stray control sequence can render as literal text.
const CONTROL_SEQUENCE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(CONTROL_SEQUENCE, "");
}

/** Strips one specific, already-known proof-worktree root (with or without a trailing separator) from `text`. */
export function stripProofWorktreeRoot(text: string, root: string): string {
  if (!root) return text;
  return text.split(`${root}/`).join("").split(root).join("");
}

/**
 * Rewrites every `.../proof-worktrees/<id>/` absolute prefix found in `text` down to nothing, whatever the
 * daemon's artifact directory is. Scoped to that one directory name on purpose: it must never rewrite an
 * arbitrary absolute path a job legitimately mentions (a `cd app && flutter test` command, say).
 */
const PROOF_WORKTREE_PREFIX = /\S*\/proof-worktrees\/[^/\s]+\//g;

export function stripProofWorktreePaths(text: string): string {
  return text.replace(PROOF_WORKTREE_PREFIX, "");
}

/**
 * The one function every read path uses to clean a stored `tasks`/`checks` text field (phase, blocker,
 * nextAction, summary) before it becomes a view a client receives. There are two independent places a raw
 * `tasks`/`checks` row is mapped to a view -- `CoordinationStore.getTask` in coordination.ts (the inbox,
 * `rooms.get`'s `tasks`) and `mapped()`/`getRoom()` in reads.ts/database.ts (the paginated `rooms.snapshot`
 * and `jobs.evidence`, and the legacy `rooms.get` `checks`) -- because they query the table differently; both
 * must call this rather than trust the stored text, since rows written before this sanitizer existed still
 * hold the residue verbatim (nothing here rewrites the database).
 */
export function sanitizeStoredText(text: string): string;
export function sanitizeStoredText(text: string | null): string | null;
export function sanitizeStoredText(text: string | null): string | null {
  return text === null ? null : stripProofWorktreePaths(stripAnsi(text));
}
