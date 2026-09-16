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
const shellEntry = `import(${JSON.stringify(path.resolve("apps/cli/src/shell.mjs"))}).then((m) => m.shell({ argv: process.argv.slice(1) }))`;
const oneProject = [{ id: "p", workflows: [{ id: "w" }] }];
async function daemon(context, handler) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dovsky-shell-"));
  const socketPath = path.join(root, "daemon.sock"), seen = [];
  const server = createServer((socket) => { let input = ""; socket.setEncoding("utf8"); socket.on("data", (chunk) => { input += chunk; }); socket.on("end", () => { const request = JSON.parse(input); seen.push(request); const reply = handler(request); socket.end(`${JSON.stringify(reply?.ok === false ? { id: request.id, ...reply } : { id: request.id, ok: true, result: reply })}\n`); }); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  context.after(() => server.close());
  return { socketPath, seen: (method) => seen.filter((request) => request.method === method) };
}
function session(socketPath, lines, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", shellEntry, "--", ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DOVSKY_SOCKET: socketPath } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${lines.join("\n")}\n`);
  });
}
const agent = (rooms = {}) => (request) => {
  if (request.method === "projects.list") return rooms.projects ?? oneProject;
  if (request.method === "sessions.create") return { sessionId: "s1" };
  if (request.method === "rooms.create") return { roomId: "r1", jobIds: ["j1"] };
  if (request.method === "rooms.get") return rooms.get ?? { room: { id: request.params.roomId, projectId: "p", sessionId: "s1" }, jobs: [] };
  if (request.method === "messages.create") return { roomId: request.params.roomId, jobIds: [`j${request.params.body.length}`] };
  if (request.method === "jobs.get") return { id: request.params.jobId, provider: "claude", ...(rooms.job ?? { state: "succeeded" }) };
  if (request.method === "jobs.result") return { result: `reply for ${request.params.jobId}` };
  return { ok: true };
};

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

test("one terminal is one session and one room: the first message creates them, later ones follow up", async (context) => {
  const fake = await daemon(context, agent());
  const { code, stdout } = await session(fake.socketPath, ["fix the login", "/to codex", "add a test", "/status --json", "/send other --project p --workflow w", "/record --title T --project p --workflow w --author human hi", "/sessions new T --project p --workflow w", "/room", "/exit", "never sent"], ["--tier", "large"]);
  assert.equal(code, 0);
  assert.match(stdout, /dovsky 2\.0\.0 · p\/w · to claude/);
  assert.deepEqual(fake.seen("sessions.create").map((request) => request.params), [{ title: "fix the login", projectId: "p", workflowId: "w" }]);
  const [created, ...others] = fake.seen("rooms.create");
  assert.equal(others.length, 0);
  assert.deepEqual([created.params.sessionId, created.params.prompt, created.params.recipients, created.params.tier], ["s1", "fix the login", ["claude"], "large"]);
  assert.deepEqual(fake.seen("messages.create").map((request) => [request.params.roomId, request.params.body, request.params.recipient, request.params.tier]), [["r1", "add a test", "codex", "large"]]);
  assert.match(stdout, /claude:\nreply for j1\n/);
  assert.match(stdout, /reply for j10/);
  assert.deepEqual(fake.seen("rooms.get").map((request) => request.params.roomId), ["r1"]);
  assert.equal(stdout.match(/bound to one session and room/g).length, 3);
  assert.match(stdout, /room: r1 · session: s1 · p\/w/);
  assert.equal(fake.seen("turns.record").length + fake.seen("rooms.open").length, 0);
});

test("without --project and --workflow the shell asks, and --resume binds an existing room", async (context) => {
  const fake = await daemon(context, agent({ projects: [{ id: "a", workflows: [{ id: "w" }] }, { id: "b", name: "Bee", workflows: [{ id: "review" }, { id: "change" }] }] }));
  const picked = await session(fake.socketPath, ["9", "2", "change", "/room"]);
  assert.match(picked.stdout, /2\. b \(Bee\)/);
  assert.match(picked.stdout, /room: none yet · session: none yet · b\/change/);
  const unknown = await session(fake.socketPath, [], ["--project", "zzz"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stdout, /Unknown project zzz; choose one of: a, b/);
  const resumed = await session(fake.socketPath, ["hello"], ["--resume", "r9"]);
  assert.match(resumed.stdout, /Resumed room r9/);
  assert.deepEqual(fake.seen("messages.create").map((request) => request.params.roomId), ["r9"]);
  assert.equal(fake.seen("sessions.create").length, 0);
});

test("a failed room creation reuses the session on the next message", async (context) => {
  let attempts = 0;
  const handler = agent();
  const fake = await daemon(context, (request) => request.method === "rooms.create" && (attempts += 1) === 1 ? { ok: false, error: { code: "QUOTA_EXCEEDED", message: "no open rung" } } : handler(request));
  const { stdout } = await session(fake.socketPath, ["first try", "second try"]);
  assert.match(stdout, /QUOTA_EXCEEDED: no open rung/);
  assert.equal(fake.seen("sessions.create").length, 1);
  assert.deepEqual(fake.seen("rooms.create").map((request) => request.params.sessionId), ["s1", "s1"]);
  assert.match(stdout, /reply for j1/);
});

test("failed jobs are reported and errors never end the session", async (context) => {
  const fake = await daemon(context, agent({ job: { state: "failed", failure: { code: "provider_exit", message: "exited 1" } } }));
  const { code, stdout } = await session(fake.socketPath, ["/nope", "/wait", `/send "open`, "do it", "/wait", "/doctor"], ["--project", "p"]);
  assert.equal(code, 0);
  assert.match(stdout, /Unknown command \/nope/);
  assert.match(stdout, /No job yet/);
  assert.match(stdout, /Unterminated quote/);
  assert.equal(stdout.match(/claude failed: exited 1 \(job j1\)/g).length, 2);
  assert.equal(fake.seen("doctor").length, 1);
});

test("an unreachable daemon exits 2 with a transport error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dovsky-shell-"));
  const { code, stdout } = await session(path.join(root, "missing.sock"), []);
  assert.equal(code, 2);
  assert.match(stdout, /TRANSPORT: Could not contact daemon/);
});

test("help lists slash commands and shell built-ins", async (context) => {
  const fake = await daemon(context, agent());
  const { stdout } = await session(fake.socketPath, ["/help"]);
  assert.match(stdout, /\/accept JOB/);
  assert.match(stdout, /\/to claude\|codex/);
  assert.doesNotMatch(stdout, /dovsky accept/);
});

test("without a TTY, bare dovsky still prints help", async () => {
  const { stdout } = await exec(cli, []);
  assert.match(stdout, /^Dovsky CLI/);
});
