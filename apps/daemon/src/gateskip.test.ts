import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { JobSummary } from "@dovsky/protocol";
import { FixtureDaemon as DovskyDaemon, removeFixtureTree } from './__fixtures__/runtime-isolation.js';
import type { DaemonConfig } from "./config.js";

// Covers the ADOPT: `runGates` (daemon.ts) must skip re-running a quality gate (verify, or a
// workflow quality command) only when the tree is unchanged AND a recorded PASS for that exact
// command exists on this exact tree, in this room. It must never turn an absent or failing
// record into a pass, and a changed command or a changed tree must always run for real.

const providerFixture = new URL("./__fixtures__/provider.js", import.meta.url).pathname;

interface Harness {
  root: string;
  project: string;
  daemon: DovskyDaemon;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/** One project, one workflow, both providers running the same fixture mode -- mirrors daemon.test.ts's harness(). */
function harness(mode: string, qualityCommands: string[][] = []): Harness {
  const root = mkdtempSync(resolve(tmpdir(), "dovsky-gateskip-test-"));
  const project = resolve(root, "project");
  spawnSync("mkdir", ["-p", project]);
  git(project, "init", "-q");
  git(project, "config", "user.email", "test@example.invalid");
  git(project, "config", "user.name", "Dovsky Test");
  writeFileSync(resolve(project, "tracked.txt"), "baseline\n");
  git(project, "add", "tracked.txt");
  git(project, "commit", "-qm", "baseline");
  const config: DaemonConfig = {
    socketPath: resolve(root, "run", "dovsky.sock"),
    databasePath: resolve(root, "state", "dovsky.db"),
    artifactDirectory: resolve(root, "artifacts"),
    maxActive: 3,
    projects: [
      {
        id: "test",
        name: "Test Project",
        path: project,
        workflows: [
          {
            id: "default",
            name: "Default",
            readOnly: false,
            qualityCommands,
            providers: {
              claude: { argv: [process.execPath, providerFixture, mode] },
              codex: { argv: [process.execPath, providerFixture, mode] },
            },
          },
        ],
      },
    ],
  };
  return { root, project, daemon: new DovskyDaemon(config) };
}

async function cleanup(value: Harness): Promise<void> {
  await value.daemon.stop();
  value.daemon.close();
  removeFixtureTree(value.root);
}

async function waitForJob(daemon: DovskyDaemon, jobId: string, states: string[], timeout = 5_000): Promise<JobSummary> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const page = (await daemon.call("jobs.list", { limit: 100 })) as { items: JobSummary[] };
    const job = page.items.find((candidate) => candidate.id === jobId);
    if (job && states.includes(job.state)) return job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Timed out waiting for ${jobId} in ${states.join(",")}`);
}

async function checksFor(
  daemon: DovskyDaemon,
  roomId: string,
  jobId: string,
): Promise<Array<{ command: string[]; state: string; exitCode: number | null; summary: string | null }>> {
  const detail = (await daemon.call("rooms.get", { roomId })) as {
    checks: Array<{ jobId: string; command: string[]; state: string; exitCode: number | null; summary: string | null }>;
  };
  return detail.checks
    .filter((check) => check.jobId === jobId)
    .map((check) => ({ command: check.command, state: check.state, exitCode: check.exitCode, summary: check.summary }));
}

test("an unchanged tree with a recorded pass is skipped, and marked skipped -- not silently a pass", async () => {
  const value = harness("success", [["/usr/bin/true"]]);
  try {
    value.daemon.start();
    const created = (await value.daemon.call(
      "rooms.create",
      { title: "gateskip", projectId: "test", workflowId: "default", prompt: "do nothing", recipients: ["codex"], verify: "true" },
      randomUUID(),
    )) as { roomId: string; jobIds: string[] };
    const first = await waitForJob(value.daemon, created.jobIds[0] as string, ["succeeded"]);
    assert.deepEqual(await checksFor(value.daemon, created.roomId, first.id), [
      { command: ["sh", "-c", "true"], state: "passed", exitCode: 0, summary: "" },
      { command: ["/usr/bin/true"], state: "passed", exitCode: 0, summary: "" },
    ]);

    // A follow-up in the same room and thread; the fixture ("success") makes no change, so the tree is
    // exactly as job 1 left it, and the same verify + quality command are requested again.
    const followUp = (await value.daemon.call(
      "messages.create",
      { roomId: created.roomId, recipient: "codex", body: "confirm", verify: "true" },
      randomUUID(),
    )) as { jobIds: string[] };
    const second = await waitForJob(value.daemon, followUp.jobIds[0] as string, ["succeeded"]);
    const secondChecks = await checksFor(value.daemon, created.roomId, second.id);
    assert.deepEqual(secondChecks.map((check) => [check.command, check.state, check.exitCode]), [
      [["sh", "-c", "true"], "skipped", 0],
      [["/usr/bin/true"], "skipped", 0],
    ]);
    for (const check of secondChecks) {
      assert.match(check.summary ?? "", /tracked-tree fingerprint/);
      assert.ok(check.summary?.includes(first.id), `summary should name the reused job: ${check.summary}`);
    }
  } finally {
    await cleanup(value);
  }
});

test("a durable dependency invalidation prevents reuse of an otherwise matching pass", async () => {
  const value = harness("success", [["/usr/bin/true"]]);
  try {
    value.daemon.start();
    const created = (await value.daemon.call(
      "rooms.create",
      { title: "dependency-origin", projectId: "test", workflowId: "default", prompt: "do nothing", recipients: ["codex"], verify: "true" },
      randomUUID(),
    )) as { roomId: string; jobIds: string[] };
    const first = await waitForJob(value.daemon, created.jobIds[0]!, ["succeeded"]);
    value.daemon.database.db.prepare("INSERT INTO daemon_settings(key,value) VALUES(?,?)")
      .run(`dependency-origin:${value.project}`, '{"version":1,"state":"runtime_invalidated"}');
    const followUp = (await value.daemon.call(
      "messages.create",
      { roomId: created.roomId, recipient: "codex", body: "confirm", verify: "true" },
      randomUUID(),
    )) as { jobIds: string[] };
    const second = await waitForJob(value.daemon, followUp.jobIds[0]!, ["succeeded"]);
    assert.deepEqual((await checksFor(value.daemon, created.roomId, second.id)).map(check => check.state), ["passed", "passed"]);
    assert.notEqual(first.id, second.id);
  } finally { await cleanup(value); }
});

test("an unchanged tree with no recorded verdict runs the gate for real, and a real failure is not hidden", async () => {
  // First job in a brand-new room: there is nothing to reuse from, so even though this job's own tree
  // never moves (the fixture makes no change), verify must actually run -- and its real failure must surface.
  const value = harness("success");
  try {
    value.daemon.start();
    const created = (await value.daemon.call(
      "rooms.create",
      { title: "no-verdict", projectId: "test", workflowId: "default", prompt: "do nothing", recipients: ["codex"], verify: "false" },
      randomUUID(),
    )) as { roomId: string; jobIds: string[] };
    const job = await waitForJob(value.daemon, created.jobIds[0] as string, ["failed"]);
    assert.equal(job.failure?.code, "quality_gate");
    assert.deepEqual(await checksFor(value.daemon, created.roomId, job.id), [
      { command: ["sh", "-c", "false"], state: "failed", exitCode: 1, summary: "" },
    ]);
  } finally {
    await cleanup(value);
  }
});

test("an unchanged tree following a recorded failure never reports a pass", async () => {
  const value = harness("success");
  try {
    value.daemon.start();
    const created = (await value.daemon.call(
      "rooms.create",
      { title: "recorded-failure", projectId: "test", workflowId: "default", prompt: "do nothing", recipients: ["codex"], verify: "false" },
      randomUUID(),
    )) as { roomId: string; jobIds: string[] };
    const first = await waitForJob(value.daemon, created.jobIds[0] as string, ["failed"]);
    assert.equal(first.failure?.code, "quality_gate");
    // The failed job never records an end fingerprint (only a success does), so it can never become a donor:
    // the follow-up, on the identical unchanged tree with the identical verify command, must run it for real.
    const followUp = (await value.daemon.call(
      "messages.create",
      { roomId: created.roomId, recipient: "codex", body: "try the same thing again", verify: "false" },
      randomUUID(),
    )) as { jobIds: string[] };
    const second = await waitForJob(value.daemon, followUp.jobIds[0] as string, ["failed"]);
    assert.equal(second.failure?.code, "quality_gate");
    assert.deepEqual(await checksFor(value.daemon, created.roomId, second.id), [
      { command: ["sh", "-c", "false"], state: "failed", exitCode: 1, summary: "" },
    ]);
  } finally {
    await cleanup(value);
  }
});

test("a changed tree runs every gate exactly as before, even when a matching pass is on record", async () => {
  // "edit" writes changed.txt with content taken from the prompt, so a differently-worded follow-up
  // changes the tree again: `changed` must win over any donor lookup.
  const value = harness("edit", [["/usr/bin/true"]]);
  try {
    value.daemon.start();
    const created = (await value.daemon.call(
      "rooms.create",
      { title: "changed-tree", projectId: "test", workflowId: "default", prompt: "--- Task ---\nfirst edit", recipients: ["codex"], verify: "true" },
      randomUUID(),
    )) as { roomId: string; jobIds: string[] };
    await waitForJob(value.daemon, created.jobIds[0] as string, ["succeeded"]);

    const followUp = (await value.daemon.call(
      "messages.create",
      { roomId: created.roomId, recipient: "codex", body: "--- Task ---\nsecond, different edit", verify: "true" },
      randomUUID(),
    )) as { jobIds: string[] };
    const second = await waitForJob(value.daemon, followUp.jobIds[0] as string, ["succeeded"]);
    assert.deepEqual(await checksFor(value.daemon, created.roomId, second.id), [
      { command: ["sh", "-c", "true"], state: "passed", exitCode: 0, summary: "" },
      { command: ["/usr/bin/true"], state: "passed", exitCode: 0, summary: "" },
    ]);
  } finally {
    await cleanup(value);
  }
});

test("a donor job with a matching end_fingerprint but a state other than succeeded is never reused", async () => {
  const value = harness("success");
  try {
    value.daemon.start();
    const created = (await value.daemon.call(
      "rooms.create",
      { title: "corrupt-state", projectId: "test", workflowId: "default", prompt: "do nothing", recipients: ["codex"], verify: "true" },
      randomUUID(),
    )) as { roomId: string; jobIds: string[] };
    const first = await waitForJob(value.daemon, created.jobIds[0] as string, ["succeeded"]);
    assert.deepEqual(await checksFor(value.daemon, created.roomId, first.id), [
      { command: ["sh", "-c", "true"], state: "passed", exitCode: 0, summary: "" },
    ]);

    // Corrupt the donor after the fact, through the test's own disposable DB handle: its end_fingerprint and
    // its passed check both survive, only `state` no longer says `succeeded`. Kills the mutant that drops
    // `j.state = 'succeeded'` from runGates's donor lookup -- without this, the row below would still match.
    value.daemon.database.db.prepare("UPDATE jobs SET state='failed' WHERE id=?").run(first.id);

    const followUp = (await value.daemon.call(
      "messages.create",
      { roomId: created.roomId, recipient: "codex", body: "confirm", verify: "true" },
      randomUUID(),
    )) as { jobIds: string[] };
    const second = await waitForJob(value.daemon, followUp.jobIds[0] as string, ["succeeded"]);
    assert.deepEqual(await checksFor(value.daemon, created.roomId, second.id), [
      { command: ["sh", "-c", "true"], state: "passed", exitCode: 0, summary: "" },
    ]);
  } finally {
    await cleanup(value);
  }
});

test("a succeeded donor whose specific check for this command is not a pass is never reused", async () => {
  const value = harness("success");
  try {
    value.daemon.start();
    const created = (await value.daemon.call(
      "rooms.create",
      { title: "corrupt-check", projectId: "test", workflowId: "default", prompt: "do nothing", recipients: ["codex"], verify: "true" },
      randomUUID(),
    )) as { roomId: string; jobIds: string[] };
    const first = await waitForJob(value.daemon, created.jobIds[0] as string, ["succeeded"]);
    assert.deepEqual(await checksFor(value.daemon, created.roomId, first.id), [
      { command: ["sh", "-c", "true"], state: "passed", exitCode: 0, summary: "" },
    ]);

    // Corrupt only the check row: the donor job itself is left genuinely `succeeded`. This cannot happen
    // organically (runGates never lets a job reach `succeeded` with a failed check), so it is injected
    // directly to prove the SQL still requires this exact command's own row to say `passed`. Kills the
    // mutant that drops `c.state = 'passed'` from runGates's donor lookup.
    value.daemon.database.db
      .prepare("UPDATE checks SET state='failed' WHERE job_id=? AND command_json=?")
      .run(first.id, JSON.stringify(["sh", "-c", "true"]));

    const followUp = (await value.daemon.call(
      "messages.create",
      { roomId: created.roomId, recipient: "codex", body: "confirm", verify: "true" },
      randomUUID(),
    )) as { jobIds: string[] };
    const second = await waitForJob(value.daemon, followUp.jobIds[0] as string, ["succeeded"]);
    assert.deepEqual(await checksFor(value.daemon, created.roomId, second.id), [
      { command: ["sh", "-c", "true"], state: "passed", exitCode: 0, summary: "" },
    ]);
  } finally {
    await cleanup(value);
  }
});

test("changed gate commands on the same fingerprint are not reused: the new command runs", async () => {
  const value = harness("success");
  try {
    value.daemon.start();
    const created = (await value.daemon.call(
      "rooms.create",
      { title: "changed-command", projectId: "test", workflowId: "default", prompt: "do nothing", recipients: ["codex"], verify: "true" },
      randomUUID(),
    )) as { roomId: string; jobIds: string[] };
    await waitForJob(value.daemon, created.jobIds[0] as string, ["succeeded"]);

    // Same unchanged tree, but a different verify command: no record exists for it, so it must run for real.
    const followUp = (await value.daemon.call(
      "messages.create",
      { roomId: created.roomId, recipient: "codex", body: "confirm", verify: "false" },
      randomUUID(),
    )) as { jobIds: string[] };
    const second = await waitForJob(value.daemon, followUp.jobIds[0] as string, ["failed"]);
    assert.equal(second.failure?.code, "quality_gate");
    assert.deepEqual(await checksFor(value.daemon, created.roomId, second.id), [
      { command: ["sh", "-c", "false"], state: "failed", exitCode: 1, summary: "" },
    ]);
  } finally {
    await cleanup(value);
  }
});

test("a pass recorded in another room is never reused, even at the same fingerprint and command", async () => {
  // Two rooms on one project. The fixture ("success") makes no change, so room B's job starts at the very
  // fingerprint room A's job ended at, and asks for the same verify + quality command. A donor must come
  // from this room, so room B runs both gates for real.
  const value = harness("success", [["/usr/bin/true"]]);
  try {
    value.daemon.start();
    const roomA = (await value.daemon.call(
      "rooms.create",
      { title: "room-a", projectId: "test", workflowId: "default", prompt: "do nothing", recipients: ["codex"], verify: "true" },
      randomUUID(),
    )) as { roomId: string; jobIds: string[] };
    const donor = await waitForJob(value.daemon, roomA.jobIds[0] as string, ["succeeded"]);
    assert.deepEqual((await checksFor(value.daemon, roomA.roomId, donor.id)).map((check) => check.state), ["passed", "passed"]);

    const roomB = (await value.daemon.call(
      "rooms.create",
      { title: "room-b", projectId: "test", workflowId: "default", prompt: "do nothing", recipients: ["codex"], verify: "true" },
      randomUUID(),
    )) as { roomId: string; jobIds: string[] };
    const job = await waitForJob(value.daemon, roomB.jobIds[0] as string, ["succeeded"]);
    assert.deepEqual(await checksFor(value.daemon, roomB.roomId, job.id), [
      { command: ["sh", "-c", "true"], state: "passed", exitCode: 0, summary: "" },
      { command: ["/usr/bin/true"], state: "passed", exitCode: 0, summary: "" },
    ]);
  } finally {
    await cleanup(value);
  }
});
