import assert from "node:assert/strict";
import test from "node:test";
import { stripAnsi, stripProofWorktreePaths, stripProofWorktreeRoot } from "./sanitize.js";

test("stripAnsi removes SGR colour codes without touching the text between them", () => {
  assert.equal(stripAnsi("\x1b[31mFAIL\x1b[39m tracked.txt"), "FAIL tracked.txt");
});

test("stripAnsi removes CSI sequences that carry parameters other than SGR (cursor, erase)", () => {
  assert.equal(stripAnsi("\x1b[2K\x1b[1G\x1b[10;20Hloading\x1b[0K done"), "loading done");
});

test("stripAnsi removes OSC sequences terminated by BEL or ST", () => {
  assert.equal(stripAnsi("\x1b]0;window title\x07before after"), "before after");
  assert.equal(stripAnsi("\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\"), "link");
});

test("stripAnsi cleans a real mixed banner (SGR + literal brackets) end to end", () => {
  const raw =
    "\x1b[1m\x1b[30m\x1b[46m RUN \x1b[49m\x1b[39m\x1b[22m \x1b[36mv4.1.10 \x1b[39m\x1b[90m/home/USER/.agentbus-v2/artifacts/proof-worktrees/bee84b9f/backend\x1b[39m";
  const cleaned = stripAnsi(raw);
  assert.ok(!cleaned.includes("\x1b"), "no raw escape bytes remain");
  assert.ok(!cleaned.includes("[1m") && !cleaned.includes("[39m"), "no bracket residue remains");
  assert.match(cleaned, /RUN\s+v4\.1\.10\s+\/home\/USER\/\.agentbus-v2\/artifacts\/proof-worktrees\/bee84b9f\/backend/);
});

test("stripAnsi leaves plain text, including literal square brackets, untouched", () => {
  assert.equal(stripAnsi("not ok 1 - [setup] failed"), "not ok 1 - [setup] failed");
});

test("stripProofWorktreeRoot removes a known root with or without a trailing separator", () => {
  const root = "/home/USER/.dovsky/artifacts/proof-worktrees/job-1";
  assert.equal(stripProofWorktreeRoot(`${root}/backend`, root), "backend");
  assert.equal(stripProofWorktreeRoot(`prefix ${root} suffix`, root), "prefix  suffix");
  assert.equal(stripProofWorktreeRoot("unrelated text", root), "unrelated text");
});

test("stripProofWorktreeRoot no-ops on an empty root", () => {
  assert.equal(stripProofWorktreeRoot("/some/path/backend", ""), "/some/path/backend");
});

test("stripProofWorktreePaths rewrites any proof-worktree absolute prefix, root unknown", () => {
  assert.equal(
    stripProofWorktreePaths("at /home/USER/.dovsky/artifacts/proof-worktrees/bee84b9f-4690/backend/src/index.ts"),
    "at backend/src/index.ts",
  );
  // A different job's root than any one call site knows about -- still matched, because the rewrite is
  // pattern-based (the directory name), not tied to one known root.
  assert.equal(stripProofWorktreePaths("/var/lib/dovsky/proof-worktrees/other-job/app/main.dart"), "app/main.dart");
});

test("stripProofWorktreePaths never touches an absolute path outside proof-worktrees", () => {
  const text = "cd app && flutter test test/widgets/foo_test.dart";
  assert.equal(stripProofWorktreePaths(text), text);
  const otherPath = "See /home/USER/dovsky/apps/daemon/src/daemon.ts:343 for the helper";
  assert.equal(stripProofWorktreePaths(otherPath), otherPath);
});
