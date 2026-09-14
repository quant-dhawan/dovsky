import assert from "node:assert/strict";
import test from "node:test";
import { interruptedTool } from "./dangling.js";

/** One `writeLog` record, exactly as `daemon.ts:3214-3215` writes it: `{"at","channel","data"}\n`. */
const rec = (channel: "stdout" | "stderr" | "daemon", data: string): string => `${JSON.stringify({ at: new Date().toISOString(), channel, data })}\n`;

/** A claude `assistant` stream line carrying one `tool_use` block, shaped like a real `provider-*.jsonl` capture. */
const claudeToolUse = (name: string, command: string): string =>
  `${JSON.stringify({
    type: "assistant",
    message: { model: "claude-fable-5-1", id: "msg_1", type: "message", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name, input: { command }, caller: { type: "direct" } }] },
    parent_tool_use_id: null,
    session_id: "sess-1",
  })}\n`;

const claudeResult = (): string => `${JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "sess-1" })}\n`;

const codexItemStarted = (command: string): string =>
  `${JSON.stringify({ type: "item.started", item: { id: "item_4", type: "command_execution", command, aggregated_output: "", exit_code: null, status: "in_progress" } })}\n`;

const codexItemCompleted = (command: string): string =>
  `${JSON.stringify({ type: "item.completed", item: { id: "item_4", type: "command_execution", command, aggregated_output: "ok", exit_code: 0, status: "completed" } })}\n`;

const codexTurnCompleted = (): string => `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } })}\n`;

test("claude: stdout split mid-JSON across two chunks reassembles and finds the tool", () => {
  const line = claudeToolUse("Bash", "npm test");
  const split = Math.floor(line.length / 2);
  const log = rec("daemon", 'provider started: "claude" "-p"') + rec("stdout", line.slice(0, split)) + rec("stdout", line.slice(split));
  assert.deepEqual(interruptedTool(log, "claude"), { kind: "Bash", command: "npm test" });
});

test("claude: a log ending in result returns null (the call completed)", () => {
  const log = rec("stdout", claudeToolUse("Bash", "npm test")) + rec("stdout", claudeResult()) + rec("daemon", "provider stopped: code=0 signal=null");
  assert.equal(interruptedTool(log, "claude"), null);
});

test("a missing, empty, or garbage log returns null and never throws", () => {
  assert.equal(interruptedTool("", "claude"), null);
  assert.equal(interruptedTool("not json at all\n{{{broken\n", "codex"), null);
  assert.doesNotThrow(() => interruptedTool(undefined as unknown as string, "claude"));
});

test("codex: item.started with no later item.completed returns the command", () => {
  const log = rec("daemon", 'provider started: "codex" "exec"') + rec("stdout", codexItemStarted("npm test"));
  assert.deepEqual(interruptedTool(log, "codex"), { kind: "command_execution", command: "npm test" });
});

test("tail-only: a completed tool call earlier in the log, followed by a completed turn, is not reported", () => {
  const log = rec("stdout", codexItemStarted("npm test")) + rec("stdout", codexItemCompleted("npm test")) + rec("stdout", codexTurnCompleted());
  assert.equal(interruptedTool(log, "codex"), null);
});
