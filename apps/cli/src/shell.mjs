import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArguments } from "./args.mjs";
import { renderHelp } from "./help.mjs";
import { main } from "./main.mjs";
import { request, socketFor } from "./rpc.mjs";
import { stripTerminalControl } from "./sanitize.mjs";
import { commandFor, table } from "./table.mjs";

const builtins = { room: "/room [ID]  show or select the current room", job: "/job [ID]  show or select the current job", to: "/to claude|codex  recipient for plain-text messages", clear: "/clear  clear the screen", exit: "/exit  leave the shell (also /quit, Ctrl-D)", quit: null, help: null };

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

export async function shell({ argv = [], input = process.stdin, output = process.stdout } = {}) {
  const launch = parseArguments(argv).options, state = { room: null, job: null, to: "claude" };
  const say = (text) => output.write(`${stripTerminalControl(text)}\n`);
  const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  const daemon = await request(socketFor(launch), "doctor", {}).then((result) => result?.ok === false ? "degraded" : "ok", () => "down");
  say(`dovsky ${version} · daemon ${daemon} · room: ${state.room ?? "none"}\nType /help for commands, plain text to message the current room, /exit to leave.`);
  const names = [...new Set([...Object.keys(builtins), ...table.flatMap((entry) => entry.names)])].map((name) => `/${name}`).sort();
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY), completer: (line) => [line.includes(" ") ? [] : names.filter((name) => name.startsWith(line)), line] });

  function track(result) {
    if (!result || typeof result !== "object") return;
    if (typeof result.roomId === "string") state.room = result.roomId;
    const job = typeof result.jobId === "string" ? result.jobId : Array.isArray(result.jobIds) ? result.jobIds.at(-1) : undefined;
    if (typeof job === "string") state.job = job;
  }
  let busy = false;
  async function run(args) {
    busy = true;
    const own = parseArguments(args).options, extra = [];
    if (typeof launch.get("socket") === "string" && !own.has("socket")) extra.push("--socket", launch.get("socket"));
    if (launch.has("json") && !own.has("json")) extra.push("--json");
    try { track(await main([...args, ...extra])); }
    catch (error) { say(`dovsky: ${typeof error?.code === "string" ? `${error.code}: ` : ""}${error?.message ?? "CLI failed"}`); }
    busy = false; process.exitCode = 0;
  }
  async function handle(line) {
    if (!line.startsWith("/")) {
      if (!state.room) return say("No room selected. Start one with /send PROMPT --project ID --workflow ID, or pick one with /room ID.");
      return run(["followup", state.room, line, "--to", state.to]);
    }
    let words; try { words = splitLine(line.slice(1)); } catch (error) { return say(`dovsky: ${error.message}`); }
    const [name, ...args] = words;
    if (!name || name === "help") return output.write(`${renderHelp(table).replaceAll("  dovsky ", "  /").replace("Dovsky CLI", "Dovsky shell")}\nShell commands:\n${Object.values(builtins).filter(Boolean).map((text) => `  ${text}`).join("\n")}\n`);
    if (name === "exit" || name === "quit") return "exit";
    if (name === "clear") return output.write("\x1b[2J\x1b[H");
    if (name === "room" || name === "job") { if (args[0]) state[name] = args[0]; return say(`${name}: ${state[name] ?? "none"}`); }
    if (name === "to") { if (args[0] !== "claude" && args[0] !== "codex") return say(`to: ${state.to} (use /to claude|codex)`); state.to = args[0]; return say(`to: ${state.to}`); }
    if (!commandFor(name)) return say(`Unknown command /${name}. Type /help.`);
    const slot = contextSlot(name);
    const parsed = parseArguments(args);
    // `record --title` creates a room and takes no ROOM argument.
    if (slot && state[slot.kind] && parsed.positionals.length < slot.count && !(name === "record" && parsed.options.has("title"))) args.unshift(state[slot.kind]);
    return run([name, ...args]);
  }

  let closed = false; rl.on("close", () => { closed = true; });
  // Ctrl-C clears the line at the prompt; during a command it leaves the shell, and daemon jobs keep running.
  rl.on("SIGINT", () => {
    if (busy) { say("\ninterrupted; any daemon job keeps running"); process.exit(130); }
    output.write("\n"); rl.write(null, { ctrl: true, name: "u" });
  });
  const prompt = () => { if (closed) return; rl.setPrompt(`dovsky${state.room ? `[${state.room}]` : ""}> `); rl.prompt(); };
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line && await handle(line) === "exit") break;
    prompt();
  }
  rl.close();
  process.exitCode = 0;
}
