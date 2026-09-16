import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { contextSlot, splitLine } from "../src/shell.mjs";

const exec = promisify(execFile);
const cli = path.resolve("bin/dovsky");
const shellEntry = `import(${JSON.stringify(path.resolve("apps/cli/src/shell.mjs"))}).then((m) => m.shell())`;
async function daemon(context, handler) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dovsky-shell-"));
  const socketPath = path.join(root, "daemon.sock"), seen = [];
  const server = createServer((socket) => { let input = ""; socket.setEncoding("utf8"); socket.on("data", (chunk) => { input += chunk; }); socket.on("end", () => { const request = JSON.parse(input); seen.push(request); socket.end(`${JSON.stringify({ id: request.id, ok: true, result: handler(request) })}\n`); }); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  context.after(() => server.close());
  return { socketPath, seen: (method) => seen.filter((request) => request.method === method) };
}
function session(socketPath, lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", shellEntry], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DOVSKY_SOCKET: socketPath } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${lines.join("\n")}\n`);
  });
}

test("splitLine honours quotes and escapes", () => {
  assert.deepEqual(splitLine(`send "fix the login"  --note 'a "b"' c\\ d`), ["send", "fix the login", "--note", `a "b"`, "c d"]);
  assert.deepEqual(splitLine(`accept --note "say \\"hi\\""  x`), ["accept", "--note", `say "hi"`, "x"]);
  assert.deepEqual(splitLine(`record "" x`), ["record", "", "x"]);
  assert.throws(() => splitLine(`send "open`), /Unterminated quote/);
});

test("context slots come from the usage table", () => {
  assert.deepEqual(contextSlot("status"), { kind: "room", count: 1 });
  assert.deepEqual(contextSlot("wait"), { kind: "job", count: 1 });
  assert.deepEqual(contextSlot("accept"), { kind: "job", count: 1 });
  assert.deepEqual(contextSlot("grade"), { kind: "job", count: 2 });
  assert.equal(contextSlot("ls"), null);
  assert.equal(contextSlot("execution"), null);
});

test("send selects room and job, which later commands and plain text reuse", async (context) => {
  const fake = await daemon(context, (request) => {
    if (request.method === "rooms.open") return { roomId: "r1", jobIds: ["j1"] };
    if (request.method === "jobs.get") return { id: request.params.jobId, state: "succeeded" };
    if (request.method === "messages.create") return { roomId: request.params.roomId, jobIds: ["j2"] };
    if (request.method === "rooms.get") return { room: { id: request.params.roomId }, jobs: [] };
    return { ok: true };
  });
  const { code, stdout, stderr } = await session(fake.socketPath, ["/send fix the login --project p --workflow w", "/wait", "please add a test", "/to codex", "and another", "/status --json", "/exit", "/ls"]);
  assert.equal(code, 0, stderr + stdout);
  assert.match(stdout, /dovsky 2\.0\.0 · daemon ok · room: none/);
  assert.equal(fake.seen("rooms.open")[0].params.prompt, "fix the login");
  assert.deepEqual(fake.seen("jobs.get").map((request) => request.params.jobId), ["j1"]);
  assert.deepEqual(fake.seen("messages.create").map((request) => [request.params.roomId, request.params.body, request.params.recipient]), [["r1", "please add a test", "claude"], ["r1", "and another", "codex"]]);
  assert.deepEqual(fake.seen("rooms.get").map((request) => request.params.roomId), ["r1"]);
  assert.equal(fake.seen("rooms.list").length + fake.seen("jobs.list").length, 0, "nothing runs after /exit");
});

test("record --title starts a new room and never receives the current room", async (context) => {
  const fake = await daemon(context, (request) => request.method === "rooms.open" ? { roomId: "r1", jobIds: ["j1"] } : { roomId: "r2", turnId: "t" });
  await session(fake.socketPath, ["/send go --project p --workflow w", "/record --title Foo --project p --workflow w --author human hi", "/record --author human noted"]);
  assert.deepEqual(fake.seen("turns.record").map((request) => [request.params.roomId, request.params.body]), [[undefined, "hi"], ["r2", "noted"]]);
});

test("errors are reported and the session continues", async (context) => {
  const fake = await daemon(context, () => ({ items: [] }));
  const { code, stdout, stderr } = await session(fake.socketPath, ["/nope", "/wait", "hello", `/send "open`, "/doctor"]);
  assert.equal(code, 0, stderr + stdout);
  assert.match(stdout, /Unknown command \/nope/);
  assert.match(stdout, /dovsky: Job ID is required/);
  assert.match(stdout, /No room selected/);
  assert.match(stdout, /Unterminated quote/);
  assert.equal(fake.seen("doctor").length, 2, "banner check plus /doctor");
});

test("help lists slash commands and shell built-ins", async (context) => {
  const fake = await daemon(context, () => ({}));
  const { stdout } = await session(fake.socketPath, ["/help"]);
  assert.match(stdout, /\/accept JOB/);
  assert.match(stdout, /\/room \[ID\]/);
  assert.doesNotMatch(stdout, /dovsky accept/);
});

test("without a TTY, bare dovsky still prints help", async () => {
  const { stdout } = await exec(cli, []);
  assert.match(stdout, /^Dovsky CLI/);
});
