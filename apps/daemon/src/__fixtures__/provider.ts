import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fontFixture } from "./font.js";

const mode = process.argv[2] ?? "success";
const rawInput = readFileSync(0, "utf8");
const input = rawInput.split("\n\n--- Dovsky task control contract ---")[0]!;
const completed = '\nDOVSKY_RESULT: {"outcome":"completed","phase":"Fixture work complete","blocker":null,"nextAction":null,"acknowledgedControls":[]}';
const output = (value: string): void => {
  // Evaluated fixtures explicitly implement the new task-result contract.
  if (!mode.startsWith("task-") && /Evaluation policy: (low|medium|high)\./.test(rawInput)) {
    if (!value.startsWith("{")) value += completed;
    else value = value.split("\n").map((line) => {
      if (!line) return line;
      const event = JSON.parse(line);
      if (event.type === "result") event.result += completed;
      if (event.type === "item.completed" && event.item?.type === "agent_message") event.item.text += completed;
      return JSON.stringify(event);
    }).join("\n");
  }
  writeFileSync(1, value);
};
const error = (value: string): void => writeFileSync(2, value);

switch (mode) {
  case "edit-font":
  case "edit-font-delayed": {
    const { bytes, license, approval } = fontFixture();
    writeFileSync(approval.path, bytes); writeFileSync(approval.licensePath, license);
    if (mode === "edit-font-delayed") setTimeout(() => output("Added the synthetic font fixture"), 1_000);
    else output("Added the synthetic font fixture");
    break;
  }
  case "task-checkpoint":
    output('Waiting for a decision\nDOVSKY_RESULT: {"outcome":"awaiting_decision","phase":"Release permission","blocker":"Approval missing","nextAction":"Record decision and resume","acknowledgedControls":[]}');
    break;
  case "task-edit-checkpoint":
    writeFileSync("tracked.txt", "checkpoint changed protected content\n");
    output('DOVSKY_RESULT: {"outcome":"checkpointed","phase":"Paused after edit","blocker":null,"nextAction":"Resume","acknowledgedControls":[]}');
    break;
  case "task-edit-complete":
    writeFileSync("tracked.txt", "completed leg changed protected content\n");
    output(completed.trim());
    break;
  case "task-complete": {
    const controls = JSON.parse(/^Pending controls \(in order\): (.+)$/m.exec(rawInput)?.[1] ?? "[]") as Array<{ id: string }>;
    output(`DOVSKY_RESULT: ${JSON.stringify({ outcome: "completed", phase: "Done", blocker: null, nextAction: null, acknowledgedControls: controls.map((c) => c.id) })}`);
    break;
  }
  case "task-delayed":
  case "task-edit-delayed":
    if (mode === 'task-edit-delayed') writeFileSync('tracked.txt', 'failed leg changed protected content\n');
    output(JSON.stringify({ type: "thread.started", thread_id: "thread-checkpoint" }) + "\n");
    setTimeout(() => output(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: completed.trim() } }) + "\n"), 300);
    break;
  case "commit-edit":
    writeFileSync("tracked.txt", "committed change\n");
    writeFileSync("added.txt", "committed addition\n");
    rmSync("deleted.txt");
    execFileSync("git", ["add", "."]);
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Worker commit"]);
    output("Committed the change");
    break;
  case "success":
    output(`RESULT:${input}`);
    break;
  case "dependency-check":
    if (!existsSync(resolve(process.cwd(), "node_modules/typescript/package.json"))) {
      error("installed dependency is missing");
      process.exitCode = 1;
    } else output("dependency available");
    break;
  case "argv":
    output(`ARGV ${JSON.stringify(process.argv.slice(3))}`);
    break;
  case "edit":
    // The brief alone, after the daemon's standing instruction, so evidence tests read the task text.
    writeFileSync(resolve(process.cwd(), "changed.txt"), input.split("--- Task ---\n").pop() || "changed");
    output("edited");
    break;
  case "transient": {
    const marker = resolve(process.env.HOME!, "fake-provider-attempt");
    if (!existsSync(marker)) {
      writeFileSync(marker, "1");
      error("503 temporarily unavailable");
      process.exitCode = 1;
    } else {
      appendFileSync(marker, "2");
      output("recovered");
    }
    break;
  }
  case "tool-transient":
    output(`${JSON.stringify({ type: "command_execution", command: "probe" })}\n`);
    error("503 temporarily unavailable");
    process.exitCode = 1;
    break;
  case "sleep":
    setTimeout(() => output("finished"), 10_000);
    break;
  case "chatty": {
    // Emits an agent_message every 900ms so a stall watchdog watching lastProgressAt never sees it go quiet,
    // then finishes with turn.completed. Used to prove the stall watchdog leaves a talkative attempt alone.
    output(`${JSON.stringify({ type: "thread.started", thread_id: "thread-chatty", model: "gpt-5.6-terra" })}\n`);
    let tick = 0;
    const total = 16;
    const timer = setInterval(() => {
      tick += 1;
      if (tick >= total) {
        clearInterval(timer);
        output(
          `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `chatty ${tick}` } })}\n` +
            `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } })}\n`,
        );
        return;
      }
      output(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `chatty ${tick}` } })}\n`);
    }, 900);
    break;
  }
  case "ignore-term":
    process.on("SIGTERM", () => undefined);
    output(`${JSON.stringify({ type: "thread.started", thread_id: "thread-ignore-term", model: "gpt-5.6-terra" })}\n`);
    setInterval(() => undefined, 1_000);
    break;
  case "rate-limit":
    error("429 Too Many Requests: rate limit reached");
    process.exitCode = 1;
    break;
  case "gate-fail":
    error("gate failed");
    process.exitCode = 2;
    break;
  case "gate-fail-on-change":
    // Fails only because of the job's own edit, so re-running it at the start commit passes: a real quality gate,
    // not a broken bench.
    if (existsSync(resolve(process.cwd(), "changed.txt"))) {
      error("gate failed");
      process.exitCode = 2;
    }
    break;
  case "claude-json":
    output(`${JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" })}\n${JSON.stringify({ type: "assistant", message: "intermediate" })}\n${JSON.stringify({ type: "result", result: "Claude final answer", usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 900, output_tokens: 40 } })}\n`);
    break;
  case "claude-other-model":
    // Announces a model the daemon did not ask for, the way a charter's own `model:` line would.
    output(`${JSON.stringify({ type: "system", subtype: "init", session_id: "session-1", model: "claude-opus-5" })}\n${JSON.stringify({ type: "result", result: "done" })}\n`);
    break;
  case "claude-notes": {
    // A text block longer than the note cap and spanning lines, then a tool call, then the final result.
    const note = `Reading the ${"config ".repeat(40)}\nfirst.`;
    const message = (content: unknown[]): string => JSON.stringify({ type: "assistant", message: { content } });
    output(`${JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" })}\n${message([{ type: "text", text: note }])}\n${message([{ type: "tool_use", name: "Bash", input: { command: "npm test" } }])}\n${JSON.stringify({ type: "result", result: "Claude final answer" })}\n`);
    break;
  }
  case "codex-json":
    output(`${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex final answer" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } })}\n`);
    break;
  case "codex-slow":
    output(`${JSON.stringify({ type: "thread.started", thread_id: "thread-slow", model: "gpt-5.6-terra" })}\n`);
    setTimeout(() => output(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "slow done" } })}\n`), 300);
    break;
  case "codex-thread-changes":
    output(`${JSON.stringify({ type: "thread.started", thread_id: "thread-early", model: "gpt-5.6-terra" })}\n`);
    setTimeout(() => output(`${JSON.stringify({ type: "thread.started", thread_id: "thread-final", model: "gpt-5.6-terra" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "slow done" } })}\n`), 300);
    break;
  case "codex-slow-fail":
    output(`${JSON.stringify({ type: "thread.started", thread_id: "thread-doomed", model: "gpt-5.6-terra" })}\n`);
    setTimeout(() => {
      error("provider failed after reporting its thread");
      process.exitCode = 1;
    }, 300);
    break;
  case "codex-model-collision":
    output(`${JSON.stringify({ type: "thread.started", thread_id: "thread-collision", model: "gpt-5.4-mini" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "wrong variant" } })}\n`);
    break;
  case "codex-unicode-split": {
    output(`${JSON.stringify({ type: "thread.started", thread_id: "thread-unicode", model: "gpt-5.6-terra" })}\n`);
    const line = Buffer.from(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "नमस्ते 🌍 — 完了" } })}\n`);
    const split = line.indexOf(Buffer.from("न")) + 1;
    writeSync(1, line.subarray(0, split));
    setTimeout(() => writeSync(1, line.subarray(split)), 20);
    break;
  }
  case "codex-big": {
    // Three completed commands whose output exceeds the daemon's capture cap, then the final message.
    const filler = "x".repeat(1_600_000);
    for (const command of ["ls", "npm test", "git diff"]) {
      output(`${JSON.stringify({ type: "item.completed", item: { type: "command_execution", command, aggregated_output: filler } })}\n`);
    }
    output(`${JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "not a step" } })}\n`);
    output(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "BIG DONE" } })}\n`);
    output(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } })}\n`);
    break;
  }
  case "env":
    output(`ENV ${JSON.stringify({ depth: process.env.DOVSKY_DEPTH ?? null, job: process.env.DOVSKY_JOB_ID ?? null, canary: process.env.DOVSKY_TEST_CANARY ?? null })}`);
    break;
  case "marker":
    writeFileSync(resolve(process.cwd(), "provider-was-launched"), "yes");
    output("launched");
    break;
  case "fix":
    // A hunt's shape: fix a tracked file and add a test under test/ that only passes with the fix.
    writeFileSync(resolve(process.cwd(), "tracked.txt"), "fixed\n");
    mkdirSync(resolve(process.cwd(), "test"), { recursive: true });
    writeFileSync(
      resolve(process.cwd(), "test", "tracked.test.mjs"),
      'import { readFileSync } from "node:fs";\nif (readFileSync("tracked.txt", "utf8").trim() !== "fixed") { console.log("not ok 1 - tracked.txt is not fixed"); process.exit(1); }\nconsole.log("ok 1");\n',
    );
    output("fixed");
    break;
  case "verdict": {
    // A reviewer: reply is argv[3] with literal "\\n" unescaped; an optional "SLEEP:<ms>\n" prefix delays it.
    let reply = (process.argv[3] ?? "VERDICT: APPROVED").replace(/\\n/g, "\n");
    const sleep = /^SLEEP:(\d+)\n/.exec(reply);
    if (sleep) reply = reply.slice(sleep[0].length);
    const baseline = (name: string) => (existsSync(resolve(process.cwd(), name)) ? readFileSync(resolve(process.cwd(), name), "utf8").trim() : "-");
    const text = `CWD ${process.cwd()} changed=${existsSync(resolve(process.cwd(), "changed.txt"))}\nBASELINE dirty=${baseline("dirty.txt")} tracked=${baseline("tracked.txt")}\n${reply}`;
    if (sleep) setTimeout(() => output(text), Number(sleep[1]));
    else output(text);
    break;
  }
  case "edit-thread":
    // Edits like "edit" but reports a codex thread, so a refutation can resume it.
    writeFileSync(resolve(process.cwd(), "changed.txt"), input || "changed");
    output(`${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "edited" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } })}\n`);
    break;
  case "edit-symlink":
    // numstat counts a symlink as one added line, so a job that adds one looks tiny; the evidence builder cannot
    // show it at all.
    symlinkSync("/etc/hostname", resolve(process.cwd(), "link.txt"));
    output("linked");
    break;
  case "relink":
    // Repoints an existing symlink without touching any regular file: the protect gate sees a change only if the
    // fingerprint covers the link target.
    rmSync(resolve(process.cwd(), "link.txt"), { force: true });
    symlinkSync("/etc/hostname", resolve(process.cwd(), "link.txt"));
    output("relinked");
    break;
  case "edit-binary":
    writeFileSync(resolve(process.cwd(), "blob.bin"), Buffer.from([0, 1, 2, 0, 255]));
    output("wrote a binary");
    break;
  case "edit-many":
    // Four files in one job, so the change count exceeds a default small.maxFiles of 3.
    for (const name of ["one.txt", "two.txt", "three.txt", "four.txt"]) {
      writeFileSync(resolve(process.cwd(), name), `${name} content\n`);
    }
    output("edited many");
    break;
  case "delete":
    // Removes a file the test pre-created and protected, so the protect gate sees a deletion.
    rmSync(resolve(process.cwd(), "protected.txt"), { force: true });
    output("deleted");
    break;
  case "edit-context":
    // Changes only the middle line of a pre-existing multi-line file, so -U20 keeps unchanged lines around it.
    writeFileSync(
      resolve(process.cwd(), "context.txt"),
      "line1\nline2\nCHANGED\nline4\nline5\n",
    );
    output("edited context");
    break;
  case "edit-package":
    writeFileSync(resolve(process.cwd(), "package.json"), '{"name":"changed"}\n');
    output("edited package.json");
    break;
  case "edit-charter":
    mkdirSync(resolve(process.cwd(), ".claude", "agents"), { recursive: true });
    writeFileSync(resolve(process.cwd(), ".claude", "agents", "Argus.md"), "---\nname: Argus\n---\nRewritten.\n");
    output("edited charter");
    break;
  case "edit-script":
    mkdirSync(resolve(process.cwd(), "scripts"), { recursive: true });
    writeFileSync(resolve(process.cwd(), "scripts", "verify.mjs"), "console.log('changed');\n");
    output("edited script");
    break;
  default:
    error(`unknown fake mode: ${mode}`);
    process.exitCode = 64;
}
