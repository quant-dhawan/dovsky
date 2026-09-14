import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = path.resolve("bin/dovsky");
async function daemon(context, handler) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dovsky-cli-"));
  const socketPath = path.join(root, "daemon.sock"); let seen;
  const server = createServer((socket) => { let input = ""; socket.setEncoding("utf8"); socket.on("data", (chunk) => { input += chunk; }); socket.on("end", () => { seen = JSON.parse(input); const reply = handler(seen); socket.end(`${JSON.stringify(reply.ok === false ? reply : { id: seen.id, ok: true, result: reply })}\n`); }); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  context.after(() => server.close()); return { socketPath, seen: () => seen };
}

test("help is generated from registered command table", async () => { const { stdout } = await exec(cli, ["--help"]); assert.match(stdout, /dovsky accept JOB/); assert.match(stdout, /dovsky events peek\|take/); assert.match(stdout, /dovsky outline PATH \[--cwd DIR --deadline MS\]/); assert.doesNotMatch(stdout, /web console/); });
test("accept echoes the checked evidence and never sends a second check", async (context) => { let count = 0; const fake = await daemon(context, (request) => { count += 1; if (request.method === "jobs.acceptance.check") return { jobId: "j", accepted: false, problems: ["Human acceptance checklist required"], evaluation: { criteria: ["a"], fingerprint: "f", evidenceHash: "e" } }; assert.equal(request.method, "jobs.acceptance.record"); return { id: request.id, ok: true, result: { accepted: true } }; }); await exec(cli, ["accept", "j", "--criteria", "0", "--note", "checked", "--socket", fake.socketPath, "--json"]); assert.equal(count, 2); assert.deepEqual(fake.seen().params, { jobId: "j", verdict: "accepted", note: "checked", checked: [0], fingerprint: "f", evidenceHash: "e" }); });
test("events peek never mutates and take does", async (context) => { const fake = await daemon(context, () => ({ items: [] })); await exec(cli, ["events", "peek", "operator", "--socket", fake.socketPath]); assert.equal(fake.seen().method, "events.peek"); assert.equal("idempotencyKey" in fake.seen(), false); await exec(cli, ["events", "take", "operator", "--socket", fake.socketPath]); assert.equal(fake.seen().method, "events.consume"); assert.ok(fake.seen().idempotencyKey); });
test("usage and transport exit 2 while negative daemon answers exit 1", async (context) => { await assert.rejects(exec(cli, ["accept"]), (error) => error.code === 2); const fake = await daemon(context, () => ({ accepted: false, problems: ["Human acceptance required"] })); await assert.rejects(exec(cli, ["acceptance-check", "j", "--socket", fake.socketPath]), (error) => error.code === 1); });
test("stale acceptance evidence exits 1 and does not retry", async (context) => { let count = 0; const fake = await daemon(context, (request) => { count += 1; if (request.method === "jobs.acceptance.check") return { jobId: "j", accepted: false, problems: [], evaluation: { criteria: ["a"], fingerprint: "f", evidenceHash: "e" } }; return { id: request.id, ok: false, error: { code: "STATE_CONFLICT", message: "Acceptance evidence changed; reload the job" } }; }); await assert.rejects(exec(cli, ["accept", "j", "--criteria", "0", "--note", "checked", "--socket", fake.socketPath]), (error) => error.code === 1 && /reload the job/.test(error.stdout)); assert.equal(count, 2); });
