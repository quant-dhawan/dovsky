import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeForPrint, stripTerminalControl } from "../src/sanitize.mjs";
test("terminal control sequences never reach CLI output", () => { assert.equal(stripTerminalControl("\x1b[2Jok\x07"), "ok"); assert.equal(sanitizeForPrint({ note: "\x9b2Jok" }).note, "ok"); });
