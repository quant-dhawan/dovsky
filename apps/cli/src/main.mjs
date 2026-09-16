import { integer, parseArguments } from "./args.mjs";
import { print, printText } from "./format.mjs";
import { renderHelp } from "./help.mjs";
import { keyFor, request, RpcError, socketFor } from "./rpc.mjs";
import { stripTerminalControl } from "./sanitize.mjs";
import { shell } from "./shell.mjs";
import { commandFor, table } from "./table.mjs";

export async function main(argv) {
  const { positionals, options } = parseArguments(argv);
  if (!positionals.length && !options.has("help") && process.stdin.isTTY && process.stdout.isTTY) return shell({ argv });
  const name = positionals[0] ?? "help";
  if (name === "help" || name === "--help" || options.has("help")) { process.stdout.write(renderHelp(table)); return; }
  const entry = commandFor(name);
  if (!entry) { const error = new Error(`Unknown command: ${name}\n\n${renderHelp(table)}`); error.exitCode = 2; throw error; }
  const socketPath = socketFor(options);
  const rawDepth = process.env.DOVSKY_DEPTH;
  const depth = rawDepth === undefined ? undefined : integer(rawDepth, "DOVSKY_DEPTH", { min: 0, max: 2 });
  const withMutationEnvelope = (params) => depth === undefined ? params : { ...params, depth };
  const rpc = (method, params, key, mutation = false) => request(socketPath, method, mutation ? withMutationEnvelope(params) : params, key);
  const mutate = (method, params, key) => rpc(method, params, keyFor(options, key), true);
  let outcome;
  try { outcome = await entry.run({ positionals, options, rpc, mutate }); }
  catch (error) {
    if (error?.code === "STATE_CONFLICT" && name === "accept") { printText("Acceptance evidence changed; reload the job"); process.exitCode = 1; return; }
    throw error;
  }
  if (outcome.text !== undefined) { process.stdout.write(stripTerminalControl(outcome.text)); process.exitCode = outcome.negative ? 1 : 0; return; }
  if (outcome.result !== undefined && !outcome.method) { print(outcome.result, options.has("json")); process.exitCode = outcome.negative ? 1 : 0; return outcome.result; }
  let result;
  try {
    result = await rpc(outcome.method, outcome.params ?? {}, outcome.mutation ? keyFor(options, outcome.key) : undefined, outcome.mutation);
  } catch (error) {
    if (error?.code === "STATE_CONFLICT" && name === "accept") {
      printText("Acceptance evidence changed; reload the job");
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  print(result, options.has("json"));
  if (outcome.notice && !options.has("json")) process.stderr.write(`${stripTerminalControl(outcome.notice)}\n`);
  if (outcome.negative || (name === "doctor" && result?.ok === false)) process.exitCode = 1;
  return result;
}

export { RpcError };
