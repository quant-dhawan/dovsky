import assert from "node:assert/strict";
import test from "node:test";

import { parseCharterLadder } from "./charter.js";

const frontmatter = (bus: string): string => `---\nname: Argus\ndescription: hunts\n${bus}---\n\nBody text.\n`;

test("a charter with no bus block has no ladder", () => {
  assert.equal(parseCharterLadder(frontmatter(""), "Argus.md"), null);
  assert.equal(parseCharterLadder("no frontmatter at all\n", "Argus.md"), null);
  assert.equal(parseCharterLadder("---\nname: Argus\n", "Argus.md"), null, "an unterminated fence is not a ladder");
});

test("bus.allowed reads as a flow list or a block list, and start picks the entry rung", () => {
  const flow = parseCharterLadder(frontmatter("bus:\n  allowed: [codex/routine, codex/hard, claude/hard]\n"), "Argus.md");
  assert.deepEqual(flow, {
    rungs: [
      { provider: "codex", tier: "routine" },
      { provider: "codex", tier: "hard" },
      { provider: "claude", tier: "hard" },
    ],
    startIndex: 0,
  });

  const block = parseCharterLadder(
    frontmatter("bus:\n  allowed:\n    - codex/routine\n    - codex/hard\n    - claude/hard\n  start: codex/hard\n"),
    "Argus.md",
  );
  assert.deepEqual(block?.rungs, flow?.rungs, "both spellings mean the same ladder");
  assert.equal(block?.startIndex, 1);
});

test("the bus block ends at the next unindented frontmatter key", () => {
  const ladder = parseCharterLadder(
    "---\nbus:\n  allowed: [claude/quick]\nmodel: opus\n---\nbody\n",
    "Hestia.md",
  );
  assert.deepEqual(ladder, { rungs: [{ provider: "claude", tier: "quick" }], startIndex: 0 });
});

test("a malformed ladder names the file and the offending text", () => {
  const cases: Array<[string, RegExp]> = [
    ["bus:\n  allowed: [codex/ultra]\n", /unknown tier "ultra"/],
    ["bus:\n  allowed: [gemini/hard]\n", /unknown provider "gemini"/],
    ["bus:\n  allowed: [codex]\n", /must be provider\/tier, got "codex"/],
    ["bus:\n  allowed: [codex/hard, codex/hard]\n", /repeats codex\/hard/],
    ["bus:\n  allowed: [codex/hard]\n  start: claude/hard\n", /start claude\/hard is not in allowed \[codex\/hard\]/],
    ["bus:\n  allowed: [codex/hard]\n  effort: xhigh\n", /unknown key "effort" under bus:/],
    ["bus:\n  start: codex/hard\n", /bus: has no allowed list/],
    ["bus:\n  allowed: []\n", /bus.allowed is empty/],
    ["bus:\n  allowed: codex/hard\n", /must be a list, got "codex\/hard"/],
    ["bus:\n  - codex/hard\n", /does not follow bus.allowed/],
  ];
  for (const [bus, message] of cases) {
    assert.throws(() => parseCharterLadder(frontmatter(bus), "Argus.md"), (error: unknown) => {
      assert.match((error as Error).message, message);
      assert.match((error as Error).message, /^Argus\.md: /);
      return true;
    }, bus);
  }
});

test("bus.fixed is an explicit boolean in either list spelling and does not change written rungs", () => {
  for (const fixed of [true, false]) {
    for (const allowed of ["  allowed: [codex/quick, claude/routine]\n", "  allowed:\n    - codex/quick\n    - claude/routine\n"]) {
      for (const bus of [`bus:\n  fixed: ${fixed}\n${allowed}`, `bus:\n${allowed}  fixed: ${fixed}\n`]) {
        assert.deepEqual(parseCharterLadder(frontmatter(bus), "Hestia.md"), {
          rungs: [{ provider: "codex", tier: "quick" }, { provider: "claude", tier: "routine" }], startIndex: 0, fixed,
        });
      }
    }
  }
});

test("bus.fixed rejects non-booleans and repeated values without weakening parser validation", () => {
  for (const value of ["", "yes", "no", "True", "FALSE", "1", "0", '"true"', "null", "[]"]) {
    assert.throws(() => parseCharterLadder(frontmatter(`bus:\n  allowed: [codex/hard]\n  fixed: ${value}\n`), "Argus.md"),
      /Argus\.md: bus.fixed must be a boolean/);
  }
  for (const first of [true, false]) {
    assert.throws(() => parseCharterLadder(frontmatter(`bus:\n  allowed: [codex/hard]\n  fixed: ${first}\n  fixed: true\n`), "Argus.md"),
      /Argus\.md: bus.fixed is given twice/);
  }
  assert.throws(() => parseCharterLadder(frontmatter("bus:\n  fixed: true\n"), "Argus.md"), /bus: has no allowed list/);
  assert.throws(() => parseCharterLadder(frontmatter("bus:\n  allowed:\n    - codex/hard\n  fixed: true\n    - claude/hard\n"), "Argus.md"),
    /does not follow bus.allowed/);
});
