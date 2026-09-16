import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArguments, usage } from "./args.mjs";
import { renderHelp } from "./help.mjs";
import { main } from "./main.mjs";
import { keyFor, request, socketFor } from "./rpc.mjs";
import { stripTerminalControl } from "./sanitize.mjs";
import { commandFor, table } from "./table.mjs";

const builtins = { room: "/room  show this terminal's session and room", job: "/job [ID]  show or select the current job", to: "/to claude|codex  who receives your messages", clear: "/clear  clear the screen", exit: "/exit  leave the shell (also /quit, Ctrl-D)", quit: null, help: null };
// One terminal is one session and one room; commands that would start another are refused.
const bound = "This terminal is bound to one session and room. Run dovsky in another terminal to start a new one.";
const terminal = ["succeeded", "failed", "cancelled"];

export function splitLine(line) {
  const out = []; let current = "", quote = null, started = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === "'") { if (ch === "'") quote = null; else current += ch; continue; }
    if (ch === "\\" && i + 1 < line.length) { current += line[++i]; started = true; continue; }
    if (quote === '"') { if (ch === '"') quote = null; else current += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { if (started) out.push(current); current = ""; started = false; continue; }
    current += ch; started = true;
  }
  if (quote) throw new Error("Unterminated quote");
  if (started) out.push(current);
  return out;
}

// Reads the usage string: when a command's first required positional is ROOM or JOB, the shell can supply it.
export function contextSlot(name) {
  const entry = commandFor(name); if (!entry) return null;
  const tokens = entry.usage.split(" | ")[0].replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter(Boolean).slice(1), required = [];
  for (let i = 0; i < tokens.length; i += 1) { if (tokens[i].startsWith("--")) { if (tokens[i + 1] && !tokens[i + 1].startsWith("--")) i += 1; continue; } required.push(tokens[i]); }
  return ["ROOM", "JOB"].includes(required[0]) ? { kind: required[0] === "ROOM" ? "room" : "job", count: required.length } : null;
}

export async function shell({ argv = [], input = process.stdin, output = process.stdout, pollMs = 1000 } = {}) {
  const launch = parseArguments(argv).options, socketPath = socketFor(launch);
  const state = { session: null, room: null, job: null, project: null, workflow: null, to: launch.get("to") === "codex" ? "codex" : "claude" };
  const say = (text) => output.write(`${stripTerminalControl(text)}\n`);
  const rpc = (method, params = {}) => request(socketPath, method, params);
  const errorText = (error) => `dovsky: ${typeof error?.code === "string" ? `${error.code}: ` : ""}${error?.message ?? "CLI failed"}`;
  const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  const names = [...new Set([...Object.keys(builtins), ...table.flatMap((entry) => entry.names)])].map((name) => `/${name}`).sort();
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY), completer: (line) => [line.includes(" ") ? [] : names.filter((name) => name.startsWith(line)), line] });
  const lines = rl[Symbol.asyncIterator]();
  let closed = false, busy = false, waiting = false;
  rl.on("close", () => { closed = true; });
  const finish = (code) => { rl.close(); process.exitCode = code; };
  // Ctrl-C stops waiting on a reply, clears the line at the prompt, and otherwise leaves the shell; daemon jobs keep running.
  rl.on("SIGINT", () => {
    if (waiting) { waiting = false; return; }
    if (busy) { say("\ninterrupted; any daemon job keeps running"); process.exit(130); }
    output.write("\n"); rl.write(null, { ctrl: true, name: "u" });
  });

  // Launch flags other than the shell's own go to every send and followup (tier, model, review, ...).
  const forwarded = [...launch].filter(([name]) => !["resume", "project", "workflow", "to", "json", "key"].includes(name)).flatMap(([name, value]) => value === true ? [`--${name}`] : [`--${name}`, value]);
  async function execute(args) {
    const { positionals, options } = parseArguments(args);
    const outcome = await commandFor(positionals[0]).run({ positionals, options, rpc, mutate: (method, params, key) => request(socketPath, method, params, keyFor(options, key)) });
    return outcome.method ? request(socketPath, outcome.method, outcome.params ?? {}, outcome.mutation ? keyFor(options, outcome.key) : undefined) : outcome.result;
  }
  async function choose(label, items, given) {
    if (typeof given === "string") { if (items.some((item) => item.id === given)) return given; throw usage(`Unknown ${label} ${given}; choose one of: ${items.map((item) => item.id).join(", ")}`); }
    if (items.length === 1) return items[0].id;
    say(`${label}s:\n${items.map((item, index) => `  ${index + 1}. ${item.id}${item.name ? ` (${item.name})` : ""}`).join("\n")}`);
    for (;;) {
      output.write(`${label} [1-${items.length}]: `);
      const { value, done } = await lines.next(); if (done) return null;
      const answer = value.trim(), picked = items[Number(answer) - 1] ?? items.find((item) => item.id === answer);
      if (picked) return picked.id;
    }
  }

  try {
    if (typeof launch.get("resume") === "string") {
      const { room } = await rpc("rooms.get", { roomId: launch.get("resume") });
      Object.assign(state, { room: room.id, session: room.sessionId ?? null, project: room.projectId });
    } else {
      const projects = await rpc("projects.list"), list = projects.items ?? projects;
      if (!(state.project = await choose("project", list, launch.get("project")))) return finish(0);
      if (!(state.workflow = await choose("workflow", list.find((project) => project.id === state.project).workflows, launch.get("workflow")))) return finish(0);
    }
  } catch (error) { say(errorText(error)); return finish(error?.exitCode ?? 2); }
  const where = () => `${state.project}${state.workflow ? `/${state.workflow}` : ""}`;
  say(`dovsky ${version} · ${where()} · to ${state.to}\n${state.room ? `Resumed room ${state.room}.` : "New session: type a message to start."} /help for commands, /exit to leave.`);

  async function follow(jobIds) {
    state.job = jobIds.at(-1); waiting = true;
    say(`${jobIds.length > 1 ? "agents" : state.to} working… (Ctrl-C stops waiting; the job keeps running)`);
    const pending = new Set(jobIds);
    while (pending.size && waiting) {
      for (const jobId of [...pending]) {
        const job = await rpc("jobs.get", { jobId });
        if (!terminal.includes(job.state)) continue;
        pending.delete(jobId);
        if (job.state === "succeeded") say(`\n${job.provider ?? state.to}:\n${(await rpc("jobs.result", { jobId })).result ?? job.resultPreview ?? ""}\n`);
        else say(`\n${job.provider ?? state.to} ${job.state}${job.failure ? `: ${job.failure.message ?? job.failure.code ?? JSON.stringify(job.failure)}` : ""} (job ${jobId})\n`);
      }
      if (pending.size && waiting) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (pending.size) say(`Stopped waiting; job ${state.job} keeps running. /wait to follow it again.`);
    waiting = false;
  }
  async function guarded(work) {
    busy = true;
    try { await work(); } catch (error) { say(errorText(error)); }
    busy = false; waiting = false; process.exitCode = 0;
  }
  async function message(text) {
    if (!state.room) {
      // A session made before a failed room creation is reused on the next attempt.
      state.session ??= (await execute(["sessions", "new", text.slice(0, 80), "--project", state.project, "--workflow", state.workflow])).sessionId;
      const created = await execute(["send", text, ...forwarded, "--project", state.project, "--workflow", state.workflow, "--new-room", "--session", state.session, "--to", state.to]);
      state.room = created.roomId;
      return follow(created.jobIds ?? [created.jobId]);
    }
    const sent = await execute(["followup", state.room, text, ...forwarded, "--to", state.to]);
    return follow(sent.jobIds ?? [sent.jobId]);
  }
  async function handle(line) {
    if (!line.startsWith("/")) return guarded(() => message(line));
    let words; try { words = splitLine(line.slice(1)); } catch (error) { return say(`dovsky: ${error.message}`); }
    const [name, ...args] = words;
    if (!name || name === "help") return output.write(`${renderHelp(table).replaceAll("  dovsky ", "  /").replace("Dovsky CLI", "Dovsky shell: type a message to talk to the agent in this terminal's room")}\nShell commands:\n${Object.values(builtins).filter(Boolean).map((text) => `  ${text}`).join("\n")}\n`);
    if (name === "exit" || name === "quit") return "exit";
    if (name === "clear") return output.write("\x1b[2J\x1b[H");
    if (name === "room") return say(args[0] && args[0] !== state.room ? bound : `room: ${state.room ?? "none yet"} · session: ${state.session ?? "none yet"} · ${where()}`);
    if (name === "job") { if (args[0]) state.job = args[0]; return say(`job: ${state.job ?? "none"}`); }
    if (name === "to") { if (args[0] !== "claude" && args[0] !== "codex") return say(`to: ${state.to} (use /to claude|codex)`); state.to = args[0]; return say(`to: ${state.to}`); }
    if (!commandFor(name)) return say(`Unknown command /${name}. Type /help.`);
    const parsed = parseArguments(args);
    if (name === "send" || (name === "sessions" && parsed.positionals[0] === "new") || (name === "record" && parsed.options.has("title"))) return say(bound);
    if (name === "wait" && !parsed.positionals.length && !parsed.options.has("timeout")) return state.job ? guarded(() => follow([state.job])) : say("No job yet. Send a message first.");
    const slot = contextSlot(name);
    if (slot && state[slot.kind] && parsed.positionals.length < slot.count) args.unshift(state[slot.kind]);
    return guarded(async () => {
      const extra = [];
      if (typeof launch.get("socket") === "string" && !parsed.options.has("socket")) extra.push("--socket", launch.get("socket"));
      if (launch.has("json") && !parsed.options.has("json")) extra.push("--json");
      const result = await main([name, ...args, ...extra]);
      const job = result?.jobId ?? result?.jobIds?.at(-1);
      if (result?.roomId === state.room && typeof job === "string") state.job = job;
    });
  }

  const prompt = () => { if (closed) return; rl.setPrompt("dovsky> "); rl.prompt(); };
  prompt();
  for (;;) {
    const { value, done } = await lines.next(); if (done) break;
    const line = value.trim();
    if (line && await handle(line) === "exit") break;
    prompt();
  }
  finish(0);
}
