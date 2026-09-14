import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { RpcResponse } from "@dovsky/protocol";
import { removeFixtureTree } from "./__fixtures__/runtime-isolation.js";
import { BubblewrapIsolation } from "./sandbox.js";

async function rpc(socketPath: string, method: string, params = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.setEncoding("utf8");
    socket.setTimeout(3_000, () => socket.destroy(new Error(`RPC ${method} timed out`)));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify({ id: randomUUID(), method, params, idempotencyKey: randomUUID() })}\n`));
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (!data.includes("\n")) return;
      socket.destroy();
      const response = JSON.parse(data.split("\n")[0]!) as RpcResponse;
      if (response.ok) resolve(response.result);
      else reject(new Error(JSON.stringify(response.error)));
    });
  });
}

async function eventually(check: () => Promise<boolean>, detail: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(detail());
}

test("real daemon entrypoint owns signals, active jobs, and stale-socket restart", { timeout: 90_000 }, async t => {
  const availability = await new BubblewrapIsolation({ sandboxRoot: join(tmpdir(), "dovsky-main-probe"), hiddenPaths: [] }).available();
  if (!availability.available) {
    const reason = `Host sandbox unavailable: ${availability.reason}`;
    if (process.env.DOVSKY_REQUIRE_SANDBOX === "1") assert.fail(reason);
    t.skip(reason); return;
  }
  const root = mkdtempSync(join(tmpdir(), "dovsky-main-"));
  const project = join(root, "project"), socketPath = join(root, "run", "dovsky.sock");
  const databasePath = join(root, "state", "dovsky.db"), configPath = join(root, "config.json");
  mkdirSync(project);
  // This real local provider consumes the request and stays active until shutdown.
  writeFileSync(join(project, "provider.mjs"), `import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'lifecycle-fixture'})+'\\n');
setInterval(() => {}, 1000);
`);
  const git = spawnSync("git", ["init", "-q", project], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  for (const args of [["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
    const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(configPath, JSON.stringify({ socketPath, databasePath, artifactDirectory: join(root, "artifacts"),
    sandbox: { network: false }, routing: { bandit: { enabled: false } },
    projects: [{ id: "fixture", name: "Fixture", path: project, workflows: [{ id: "default", name: "Default",
      readOnly: true, qualityCommands: [], providers: { codex: { argv: [process.execPath, join(project, "provider.mjs")] } } }] }],
  }));
  interface ProcessFixture {
    child: ChildProcess;
    closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    output: () => string;
  }
  const children: ProcessFixture[] = [];
  function launch(): ProcessFixture {
    const child = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname, "--config", configPath], {
      env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, DOVSKY_HOME: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const value = { child, closed, output: () => output };
    children.push(value);
    return value;
  }
  t.after(async () => {
    for (const value of children) {
      if (value.child.exitCode === null && value.child.signalCode === null) value.child.kill("SIGKILL");
      await value.closed;
    }
    removeFixtureTree(root);
  });
  async function ready(value: ReturnType<typeof launch>) {
    await eventually(async () => {
      assert.equal(value.child.exitCode, null, value.output());
      return value.output().includes('"event":"dovskyd.ready"');
    }, value.output);
    const health = await rpc(socketPath, "health") as { ok: boolean };
    assert.equal(health.ok, true);
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    await t.test(`${signal} settles a running fixture and exits cleanly`, async () => {
      const value = launch();
      await ready(value);
      const room = await rpc(socketPath, "rooms.create", { title: "Lifecycle", projectId: "fixture", workflowId: "default",
        prompt: "Wait for shutdown", recipients: ["codex"] }) as { jobIds: string[] };
      const jobId = room.jobIds[0]!;
      await eventually(async () => {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try { return database.prepare("SELECT thread_id FROM jobs WHERE id=?").get(jobId)?.thread_id === "lifecycle-fixture"; }
        finally { database.close(); }
      }, () => `Provider did not start: ${value.output()}`);
      value.child.kill(signal);
      assert.deepEqual(await value.closed, { code: 0, signal: null }, value.output());
      assert.equal(existsSync(socketPath), false, "shutdown removes the socket");
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal(database.prepare("SELECT state FROM jobs WHERE id=?").get(jobId)?.state, "cancelled");
        assert.equal(database.prepare("SELECT count(*) AS count FROM execution_leases WHERE state != 'exited'").get()?.count, 0);
      } finally { database.close(); }
    });
  }
  await t.test("restart replaces a stale socket left by a crashed daemon", async () => {
    const crashed = launch();
    await ready(crashed);
    crashed.child.kill("SIGKILL");
    assert.deepEqual(await crashed.closed, { code: null, signal: "SIGKILL" });
    assert.equal(lstatSync(socketPath).isSocket(), true);
    const restarted = launch();
    await ready(restarted);
    restarted.child.kill("SIGTERM");
    assert.deepEqual(await restarted.closed, { code: 0, signal: null }, restarted.output());
    assert.equal(existsSync(socketPath), false);
  });
});
